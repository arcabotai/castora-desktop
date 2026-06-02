use bip32::{secp256k1::ecdsa::SigningKey as Secp256k1SigningKey, DerivationPath, XPrv};
use bip39::{Language, Mnemonic};
use ed25519_dalek::{Signer, SigningKey as Ed25519SigningKey};
use keyring_core::Entry;
use libsecp256k1::{Message as Secp256k1Message, SecretKey as Secp256k1SecretKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use zeroize::Zeroize;

const KEYCHAIN_SERVICE: &str = "social.castora.desktop";
const DEFAULT_NODE_BASE_URL: &str = "https://haatz.quilibrium.com";
const DEFAULT_HUB_SUBMIT_URL: &str = "https://haatz.quilibrium.com/v1/submitMessage";
const DEFAULT_CUSTODY_DERIVATION_PATH: &str = "m/44'/60'/0'/0/0";
const FARCASTER_EPOCH_UNIX: u64 = 1_609_459_200;
const FARCASTER_NETWORK_MAINNET: u64 = 1;
const HASH_SCHEME_BLAKE3: u64 = 1;
const SIGNATURE_SCHEME_ED25519: u64 = 1;
const MESSAGE_TYPE_KEY_ADD: u64 = 16;
const ED25519_KEY_TYPE: u64 = 1;
const SIGNED_KEY_REQUEST_METADATA_TYPE: u64 = 1;
const MAX_SIGNER_TTL_SECONDS: u64 = 90 * 24 * 60 * 60;
const SIGNED_KEY_REQUEST_DEADLINE_SECONDS: u64 = 60 * 60;
const KEY_DOMAIN_NAME: &str = "Farcaster KeyAdd";
const KEY_DOMAIN_VERSION: &str = "1";
const SIGNED_KEY_REQUEST_CHAIN_ID: u64 = 1;
const FULL_SIGNER_SCOPES: &[u32] = &[1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15];
static KEYRING_INIT: OnceLock<Result<(), String>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    node_base_url: String,
    hub_submit_url: String,
    selected_fid: Option<u64>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            node_base_url: DEFAULT_NODE_BASE_URL.to_string(),
            hub_submit_url: DEFAULT_HUB_SUBMIT_URL.to_string(),
            selected_fid: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAccount {
    fid: u64,
    public_key_hex: String,
    has_signer: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustodyIdentity {
    address: String,
    derivation_path: String,
    has_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DesktopState {
    settings: DesktopSettings,
    account: Option<DesktopAccount>,
    custody: Option<CustodyIdentity>,
    #[serde(default)]
    signer_nonces: BTreeMap<String, u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignMessageHashResponse {
    public_key_hex: String,
    signature_hex: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawSubmitResponse {
    ok: bool,
    status: u16,
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApproveSignerResponse {
    public_key_hex: String,
    custody_address: String,
    nonce: u64,
    deadline_unix: u64,
    ttl_seconds: u64,
    hash_hex: String,
    submit: RawSubmitResponse,
}

struct KeyAddMessage {
    envelope: Vec<u8>,
    hash_hex: String,
    deadline_unix: u64,
    ttl_seconds: u64,
    nonce: u64,
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to resolve config directory: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create config directory: {error}"))?;
    Ok(dir.join("state.json"))
}

fn read_state(app: &AppHandle) -> Result<DesktopState, String> {
    let path = state_path(app)?;

    if !path.exists() {
        return Ok(DesktopState::default());
    }

    let bytes = fs::read(&path).map_err(|error| format!("Failed to read state: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("Failed to parse state: {error}"))
}

fn write_state(app: &AppHandle, state: &DesktopState) -> Result<(), String> {
    let path = state_path(app)?;
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Failed to encode state: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("Failed to write state: {error}"))
}

fn signer_entry(fid: u64) -> Result<Entry, String> {
    ensure_keyring()?;
    Entry::new(KEYCHAIN_SERVICE, &format!("signer:{fid}"))
        .map_err(|error| format!("Failed to open keychain entry: {error}"))
}

fn custody_entry(address: &str) -> Result<Entry, String> {
    ensure_keyring()?;
    Entry::new(
        KEYCHAIN_SERVICE,
        &format!("custody:{}", normalize_keychain_address(address)),
    )
    .map_err(|error| format!("Failed to open custody keychain entry: {error}"))
}

fn ensure_keyring() -> Result<(), String> {
    KEYRING_INIT
        .get_or_init(|| {
            keyring::use_native_store(false)
                .map_err(|error| format!("Failed to initialize native keychain: {error}"))
        })
        .clone()
}

fn normalize_hex(value: &str) -> String {
    value
        .trim()
        .strip_prefix("0x")
        .unwrap_or(value.trim())
        .to_string()
}

fn private_key_from_hex(private_key_hex: &str) -> Result<[u8; 32], String> {
    let normalized = normalize_hex(private_key_hex);
    let bytes = hex::decode(&normalized).map_err(|error| format!("Invalid hex: {error}"))?;

    if bytes.len() != 32 {
        return Err("Expected a 32-byte Ed25519 signer seed hex string.".to_string());
    }

    bytes
        .try_into()
        .map_err(|_| "Expected a 32-byte Ed25519 signer seed hex string.".to_string())
}

fn custody_private_key_from_hex(private_key_hex: &str) -> Result<[u8; 32], String> {
    let normalized = normalize_hex(private_key_hex);
    let bytes =
        hex::decode(&normalized).map_err(|error| format!("Invalid custody hex: {error}"))?;

    if bytes.len() != 32 {
        return Err("Expected a 32-byte Ethereum custody private key hex string.".to_string());
    }

    let private_key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Expected a 32-byte Ethereum custody private key hex string.".to_string())?;

    Secp256k1SigningKey::from_slice(&private_key)
        .map_err(|_| "Custody private key is not a valid secp256k1 secret.".to_string())?;

    Ok(private_key)
}

fn hash_from_hex(hash_hex: &str) -> Result<Vec<u8>, String> {
    let normalized = normalize_hex(hash_hex);
    let bytes = hex::decode(&normalized).map_err(|error| format!("Invalid hash hex: {error}"))?;

    if bytes.is_empty() {
        return Err("Hash bytes cannot be empty.".to_string());
    }

    Ok(bytes)
}

fn keychain_read_error(secret_label: &str, error: impl std::fmt::Display) -> String {
    let message = error.to_string();
    let lower = message.to_lowercase();

    if lower.contains("passphrase")
        || lower.contains("password")
        || lower.contains("not correct")
        || lower.contains("denied")
    {
        return format!(
            "macOS Keychain rejected access to the {secret_label}. Enter your Mac login keychain password, not your Farcaster mnemonic, and choose Always Allow for Castora Desktop. If you clicked Deny or typed the wrong password, click Approve again."
        );
    }

    format!("Failed to read {secret_label} from keychain: {message}")
}

fn signing_key_from_keychain(fid: u64) -> Result<Ed25519SigningKey, String> {
    let private_key_hex = signer_entry(fid)?
        .get_password()
        .map_err(|error| keychain_read_error("local signer key", error))?;
    Ok(Ed25519SigningKey::from_bytes(&private_key_from_hex(
        &private_key_hex,
    )?))
}

fn account_from_key(fid: u64, signing_key: &Ed25519SigningKey) -> DesktopAccount {
    DesktopAccount {
        fid,
        public_key_hex: format!("0x{}", hex::encode(signing_key.verifying_key().to_bytes())),
        has_signer: true,
    }
}

fn save_account(app: &AppHandle, account: DesktopAccount) -> Result<DesktopAccount, String> {
    let mut state = read_state(app)?;
    state.settings.selected_fid = Some(account.fid);
    state.account = Some(account.clone());
    write_state(app, &state)?;
    Ok(account)
}

fn save_custody_identity(
    app: &AppHandle,
    identity: CustodyIdentity,
) -> Result<CustodyIdentity, String> {
    let mut state = read_state(app)?;
    state.custody = Some(identity.clone());
    write_state(app, &state)?;
    Ok(identity)
}

fn save_custody_key_if_requested(
    identity: &mut CustodyIdentity,
    private_key: &[u8; 32],
    remember: bool,
) -> Result<(), String> {
    if remember {
        custody_entry(&identity.address)?
            .set_password(&format!("0x{}", hex::encode(private_key)))
            .map_err(|error| format!("Failed to save custody key to keychain: {error}"))?;
        identity.has_key = true;
    } else {
        let _ = custody_entry(&identity.address)?.delete_credential();
        identity.has_key = false;
    }

    Ok(())
}

fn normalize_mnemonic_phrase(mnemonic: &str) -> String {
    mnemonic
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn normalize_derivation_path(derivation_path: Option<String>) -> String {
    derivation_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CUSTODY_DERIVATION_PATH.to_string())
}

fn normalize_keychain_address(address: &str) -> String {
    address.trim().trim_start_matches("0x").to_lowercase()
}

fn derive_custody_private_key_from_mnemonic(
    normalized_mnemonic: &str,
    derivation_path: &str,
) -> Result<[u8; 32], String> {
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, normalized_mnemonic)
        .map_err(|_| "Mnemonic is not a valid BIP39 English recovery phrase.".to_string())?;
    let mut seed = mnemonic.to_seed_normalized("");

    let result = (|| {
        let path = derivation_path
            .parse::<DerivationPath>()
            .map_err(|error| format!("Invalid derivation path: {error}"))?;
        let xprv = XPrv::derive_from_path(seed.as_slice(), &path)
            .map_err(|error| format!("Failed to derive custody key: {error}"))?;
        let private_key = xprv.private_key().to_bytes();
        let mut private_key_bytes = [0u8; 32];
        private_key_bytes.copy_from_slice(private_key.as_ref());
        Ok(private_key_bytes)
    })();

    seed.zeroize();
    result
}

fn custody_identity_from_private_key(
    private_key: &[u8; 32],
    derivation_path: String,
    has_key: bool,
) -> Result<CustodyIdentity, String> {
    let signing_key = Secp256k1SigningKey::from_slice(private_key)
        .map_err(|_| "Custody private key is not a valid secp256k1 secret.".to_string())?;
    let public_key = signing_key.verifying_key().to_encoded_point(false);
    let public_key_bytes = public_key.as_bytes();

    if public_key_bytes.len() != 65 {
        return Err("Unable to encode custody public key.".to_string());
    }

    let hash = Keccak256::digest(&public_key_bytes[1..]);
    let mut address = [0u8; 20];
    address.copy_from_slice(&hash[12..]);

    Ok(CustodyIdentity {
        address: checksum_eth_address(&address),
        derivation_path,
        has_key,
    })
}

fn checksum_eth_address(address: &[u8; 20]) -> String {
    checksum_eth_address_hex(&hex::encode(address)).expect("20-byte address should checksum")
}

fn checksum_eth_address_hex(address_hex: &str) -> Result<String, String> {
    let normalized = address_hex.trim().trim_start_matches("0x").to_lowercase();

    if normalized.len() != 40
        || !normalized
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Expected a 20-byte Ethereum address.".to_string());
    }

    let hash = hex::encode(Keccak256::digest(normalized.as_bytes()));
    let mut checksummed = String::from("0x");

    for (index, character) in normalized.chars().enumerate() {
        let hash_nibble = u8::from_str_radix(&hash[index..index + 1], 16)
            .map_err(|error| format!("Invalid checksum nibble: {error}"))?;
        if hash_nibble >= 8 {
            checksummed.push(character.to_ascii_uppercase());
        } else {
            checksummed.push(character);
        }
    }

    Ok(checksummed)
}

fn current_unix_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is before Unix epoch: {error}"))
        .map(|duration| duration.as_secs())
}

fn farcaster_timestamp_now() -> Result<u64, String> {
    current_unix_seconds()?
        .checked_sub(FARCASTER_EPOCH_UNIX)
        .ok_or_else(|| "System clock is before Farcaster epoch.".to_string())
}

fn next_signer_nonce(app: &AppHandle, fid: u64) -> Result<u64, String> {
    let mut state = read_state(app)?;
    let key = fid.to_string();
    let previous = state.signer_nonces.get(&key).copied().unwrap_or_default();
    let next = (previous + 1).max(current_unix_seconds()?);
    state.signer_nonces.insert(key, next);
    write_state(app, &state)?;
    Ok(next)
}

fn custody_private_key_from_keychain(address: &str) -> Result<[u8; 32], String> {
    let private_key_hex = custody_entry(address)?
        .get_password()
        .map_err(|error| keychain_read_error("owner key", error))?;
    custody_private_key_from_hex(&private_key_hex)
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    let digest = Keccak256::digest(data);
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&digest);
    hash
}

fn concat_slices(slices: &[&[u8]]) -> Vec<u8> {
    let total_len = slices.iter().map(|slice| slice.len()).sum();
    let mut output = Vec::with_capacity(total_len);
    for slice in slices {
        output.extend_from_slice(slice);
    }
    output
}

fn to_uint256(value: u64) -> [u8; 32] {
    let mut output = [0u8; 32];
    output[24..].copy_from_slice(&value.to_be_bytes());
    output
}

fn address_to_32(address_hex: &str) -> Result<[u8; 32], String> {
    let normalized = normalize_hex(address_hex);
    let bytes =
        hex::decode(&normalized).map_err(|error| format!("Invalid address hex: {error}"))?;

    if bytes.len() != 20 {
        return Err("Expected a 20-byte Ethereum address.".to_string());
    }

    let mut output = [0u8; 32];
    output[12..].copy_from_slice(&bytes);
    Ok(output)
}

fn eip712_domain_separator() -> [u8; 32] {
    let type_hash = keccak256(b"EIP712Domain(string name,string version,uint256 chainId)");
    let name_hash = keccak256(KEY_DOMAIN_NAME.as_bytes());
    let version_hash = keccak256(KEY_DOMAIN_VERSION.as_bytes());
    keccak256(&concat_slices(&[
        &type_hash,
        &name_hash,
        &version_hash,
        &to_uint256(SIGNED_KEY_REQUEST_CHAIN_ID),
    ]))
}

fn uint32_array_hash(values: &[u32]) -> [u8; 32] {
    let mut encoded = Vec::with_capacity(values.len() * 32);
    for value in values {
        encoded.extend_from_slice(&to_uint256(u64::from(*value)));
    }
    keccak256(&encoded)
}

fn signed_key_request_digest(fid: u64, key: &[u8; 32], deadline: u64) -> [u8; 32] {
    let type_hash = keccak256(b"SignedKeyRequest(uint256 requestFid,bytes key,uint256 deadline)");
    let key_hash = keccak256(key);
    let struct_hash = keccak256(&concat_slices(&[
        &type_hash,
        &to_uint256(fid),
        &key_hash,
        &to_uint256(deadline),
    ]));
    let domain_separator = eip712_domain_separator();
    keccak256(&concat_slices(&[
        &[0x19, 0x01],
        &domain_separator,
        &struct_hash,
    ]))
}

fn key_add_digest(
    fid: u64,
    key: &[u8; 32],
    key_type: u64,
    scopes: &[u32],
    ttl: u64,
    nonce: u64,
    deadline: u64,
) -> [u8; 32] {
    let type_hash = keccak256(
        b"KeyAdd(uint256 fid,bytes key,uint32 keyType,uint32[] scopes,uint32 ttl,uint32 nonce,uint256 deadline)",
    );
    let key_hash = keccak256(key);
    let scopes_hash = uint32_array_hash(scopes);
    let struct_hash = keccak256(&concat_slices(&[
        &type_hash,
        &to_uint256(fid),
        &key_hash,
        &to_uint256(key_type),
        &scopes_hash,
        &to_uint256(ttl),
        &to_uint256(nonce),
        &to_uint256(deadline),
    ]));
    let domain_separator = eip712_domain_separator();
    keccak256(&concat_slices(&[
        &[0x19, 0x01],
        &domain_separator,
        &struct_hash,
    ]))
}

fn sign_eip712_digest(
    digest: &[u8; 32],
    custody_private_key: &[u8; 32],
) -> Result<[u8; 65], String> {
    let secret_key = Secp256k1SecretKey::parse(custody_private_key)
        .map_err(|error| format!("Invalid custody private key: {error:?}"))?;
    let message = Secp256k1Message::parse(digest);
    let (signature, recovery_id) = libsecp256k1::sign(&message, &secret_key);
    let mut output = [0u8; 65];
    output[..64].copy_from_slice(&signature.serialize());
    output[64] = recovery_id.serialize() + 27;
    Ok(output)
}

fn signed_key_request_metadata(
    fid: u64,
    signer_public_key: &[u8; 32],
    deadline: u64,
    custody_private_key: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let digest = signed_key_request_digest(fid, signer_public_key, deadline);
    let signature = sign_eip712_digest(&digest, custody_private_key)?;
    let request_signer =
        custody_identity_from_private_key(custody_private_key, "approval".to_string(), true)?
            .address;
    abi_encode_signed_key_request_metadata(fid, &request_signer, &signature, deadline)
}

fn abi_encode_signed_key_request_metadata(
    fid: u64,
    request_signer: &str,
    signature: &[u8; 65],
    deadline: u64,
) -> Result<Vec<u8>, String> {
    let head_size = 32 * 4;
    let signature_padded_len = signature.len().div_ceil(32) * 32;
    let mut signature_padded = vec![0u8; signature_padded_len];
    signature_padded[..signature.len()].copy_from_slice(signature);

    let mut output = Vec::with_capacity(head_size + 32 + signature_padded_len);
    output.extend_from_slice(&to_uint256(fid));
    output.extend_from_slice(&address_to_32(request_signer)?);
    output.extend_from_slice(&to_uint256(head_size as u64));
    output.extend_from_slice(&to_uint256(deadline));
    output.extend_from_slice(&to_uint256(signature.len() as u64));
    output.extend_from_slice(&signature_padded);
    Ok(output)
}

struct ProtoWriter {
    bytes: Vec<u8>,
}

impl ProtoWriter {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn write_varint_field(&mut self, field: u32, value: u64) {
        if value == 0 {
            return;
        }

        self.write_tag(field, 0);
        self.write_varint(value);
    }

    fn write_bytes_field(&mut self, field: u32, value: &[u8]) {
        self.write_tag(field, 2);
        self.write_varint(value.len() as u64);
        self.bytes.extend_from_slice(value);
    }

    fn write_sub_message(&mut self, field: u32, value: &[u8]) {
        self.write_bytes_field(field, value);
    }

    fn write_packed_int32(&mut self, field: u32, values: &[u32]) {
        if values.is_empty() {
            return;
        }

        let mut packed = ProtoWriter::new();
        for value in values {
            packed.write_varint(u64::from(*value));
        }
        self.write_bytes_field(field, &packed.finish());
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }

    fn write_tag(&mut self, field: u32, wire_type: u32) {
        self.write_varint(u64::from((field << 3) | wire_type));
    }

    fn write_varint(&mut self, value: u64) {
        let mut current = value;
        while current > 0x7f {
            self.bytes.push(((current & 0x7f) as u8) | 0x80);
            current >>= 7;
        }
        self.bytes.push(current as u8);
    }
}

fn encode_key_add_body(
    signer_public_key: &[u8; 32],
    custody_signature: &[u8; 65],
    deadline: u64,
    nonce: u64,
    metadata: &[u8],
    scopes: &[u32],
    ttl: u64,
) -> Vec<u8> {
    let mut writer = ProtoWriter::new();
    writer.write_bytes_field(1, signer_public_key);
    writer.write_varint_field(2, ED25519_KEY_TYPE);
    writer.write_bytes_field(3, custody_signature);
    writer.write_varint_field(4, deadline);
    writer.write_varint_field(5, nonce);
    writer.write_bytes_field(6, metadata);
    writer.write_varint_field(7, SIGNED_KEY_REQUEST_METADATA_TYPE);
    writer.write_packed_int32(9, scopes);
    writer.write_varint_field(10, ttl);
    writer.finish()
}

fn encode_key_add_message_data(
    fid: u64,
    signer_public_key: &[u8; 32],
    custody_signature: &[u8; 65],
    deadline: u64,
    nonce: u64,
    metadata: &[u8],
    scopes: &[u32],
    ttl: u64,
) -> Result<Vec<u8>, String> {
    let key_add_body = encode_key_add_body(
        signer_public_key,
        custody_signature,
        deadline,
        nonce,
        metadata,
        scopes,
        ttl,
    );

    let mut writer = ProtoWriter::new();
    writer.write_varint_field(1, MESSAGE_TYPE_KEY_ADD);
    writer.write_varint_field(2, fid);
    writer.write_varint_field(3, farcaster_timestamp_now()?);
    writer.write_varint_field(4, FARCASTER_NETWORK_MAINNET);
    writer.write_sub_message(19, &key_add_body);
    Ok(writer.finish())
}

fn encode_message_envelope(
    data_bytes: &[u8],
    hash: &[u8],
    signature: &[u8],
    signer_public_key: &[u8; 32],
) -> Vec<u8> {
    let mut writer = ProtoWriter::new();
    writer.write_sub_message(1, data_bytes);
    writer.write_bytes_field(2, hash);
    writer.write_varint_field(3, HASH_SCHEME_BLAKE3);
    writer.write_bytes_field(4, signature);
    writer.write_varint_field(5, SIGNATURE_SCHEME_ED25519);
    writer.write_bytes_field(6, signer_public_key);
    writer.write_bytes_field(7, data_bytes);
    writer.finish()
}

fn build_key_add_message(
    fid: u64,
    signing_key: &Ed25519SigningKey,
    custody_private_key: &[u8; 32],
    nonce: u64,
) -> Result<KeyAddMessage, String> {
    let deadline_unix = current_unix_seconds()? + SIGNED_KEY_REQUEST_DEADLINE_SECONDS;
    let signer_public_key = signing_key.verifying_key().to_bytes();
    let metadata =
        signed_key_request_metadata(fid, &signer_public_key, deadline_unix, custody_private_key)?;
    let custody_digest = key_add_digest(
        fid,
        &signer_public_key,
        ED25519_KEY_TYPE,
        FULL_SIGNER_SCOPES,
        MAX_SIGNER_TTL_SECONDS,
        nonce,
        deadline_unix,
    );
    let custody_signature = sign_eip712_digest(&custody_digest, custody_private_key)?;
    let data_bytes = encode_key_add_message_data(
        fid,
        &signer_public_key,
        &custody_signature,
        deadline_unix,
        nonce,
        &metadata,
        FULL_SIGNER_SCOPES,
        MAX_SIGNER_TTL_SECONDS,
    )?;
    let hash = blake3::hash(&data_bytes);
    let hash_20 = &hash.as_bytes()[..20];
    let signature = signing_key.sign(hash_20).to_bytes();
    let envelope = encode_message_envelope(&data_bytes, hash_20, &signature, &signer_public_key);

    Ok(KeyAddMessage {
        envelope,
        hash_hex: format!("0x{}", hex::encode(hash_20)),
        deadline_unix,
        ttl_seconds: MAX_SIGNER_TTL_SECONDS,
        nonce,
    })
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<DesktopSettings, String> {
    Ok(read_state(&app)?.settings)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: DesktopSettings) -> Result<DesktopSettings, String> {
    let mut state = read_state(&app)?;
    state.settings = settings;
    write_state(&app, &state)?;
    Ok(state.settings)
}

#[tauri::command]
fn get_account(app: AppHandle) -> Result<Option<DesktopAccount>, String> {
    Ok(read_state(&app)?.account)
}

#[tauri::command]
fn get_custody_identity(app: AppHandle) -> Result<Option<CustodyIdentity>, String> {
    Ok(read_state(&app)?.custody)
}

#[tauri::command]
fn create_signer(app: AppHandle, fid: u64) -> Result<DesktopAccount, String> {
    if fid == 0 {
        return Err("FID must be greater than zero.".to_string());
    }

    let signing_key = Ed25519SigningKey::generate(&mut OsRng);
    signer_entry(fid)?
        .set_password(&format!("0x{}", hex::encode(signing_key.to_bytes())))
        .map_err(|error| format!("Failed to save signer to keychain: {error}"))?;
    save_account(&app, account_from_key(fid, &signing_key))
}

#[tauri::command]
fn import_signer(
    app: AppHandle,
    fid: u64,
    private_key_hex: String,
) -> Result<DesktopAccount, String> {
    if fid == 0 {
        return Err("FID must be greater than zero.".to_string());
    }

    let private_key = private_key_from_hex(&private_key_hex)?;
    let signing_key = Ed25519SigningKey::from_bytes(&private_key);
    signer_entry(fid)?
        .set_password(&format!("0x{}", hex::encode(signing_key.to_bytes())))
        .map_err(|error| format!("Failed to save signer to keychain: {error}"))?;
    save_account(&app, account_from_key(fid, &signing_key))
}

#[tauri::command]
fn import_custody_from_mnemonic(
    app: AppHandle,
    mut mnemonic: String,
    remember: bool,
    derivation_path: Option<String>,
) -> Result<CustodyIdentity, String> {
    let path = normalize_derivation_path(derivation_path);
    let mut normalized_mnemonic = normalize_mnemonic_phrase(&mnemonic);
    mnemonic.zeroize();

    let mut private_key = derive_custody_private_key_from_mnemonic(&normalized_mnemonic, &path)?;
    normalized_mnemonic.zeroize();

    let mut identity = custody_identity_from_private_key(&private_key, path, false)?;
    let save_result = save_custody_key_if_requested(&mut identity, &private_key, remember);
    private_key.zeroize();
    save_result?;

    save_custody_identity(&app, identity)
}

#[tauri::command]
fn import_custody_private_key(
    app: AppHandle,
    private_key_hex: String,
    remember: bool,
) -> Result<CustodyIdentity, String> {
    let mut private_key = custody_private_key_from_hex(&private_key_hex)?;
    let mut identity =
        custody_identity_from_private_key(&private_key, "imported private key".to_string(), false)?;
    let save_result = save_custody_key_if_requested(&mut identity, &private_key, remember);
    private_key.zeroize();
    save_result?;

    save_custody_identity(&app, identity)
}

#[tauri::command]
fn sign_message_hash(fid: u64, hash_hex: String) -> Result<SignMessageHashResponse, String> {
    if fid == 0 {
        return Err("FID must be greater than zero.".to_string());
    }

    let signing_key = signing_key_from_keychain(fid)?;
    let hash = hash_from_hex(&hash_hex)?;
    let signature = signing_key.sign(&hash);

    Ok(SignMessageHashResponse {
        public_key_hex: format!("0x{}", hex::encode(signing_key.verifying_key().to_bytes())),
        signature_hex: format!("0x{}", hex::encode(signature.to_bytes())),
    })
}

#[tauri::command]
async fn submit_raw_message(
    submit_url: String,
    encoded_message_hex: String,
) -> Result<RawSubmitResponse, String> {
    let payload = hex::decode(normalize_hex(&encoded_message_hex))
        .map_err(|error| format!("Invalid encoded message hex: {error}"))?;

    post_raw_message(submit_url, payload).await
}

async fn post_raw_message(
    submit_url: String,
    payload: Vec<u8>,
) -> Result<RawSubmitResponse, String> {
    let response = reqwest::Client::new()
        .post(submit_url)
        .header("content-type", "application/octet-stream")
        .timeout(Duration::from_secs(12))
        .body(payload)
        .send()
        .await
        .map_err(|error| format!("Failed to submit message: {error}"))?;

    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read submit response: {error}"))?;

    Ok(RawSubmitResponse { ok, status, body })
}

#[tauri::command]
async fn approve_signer(
    app: AppHandle,
    fid: u64,
    submit_url: String,
) -> Result<ApproveSignerResponse, String> {
    if fid == 0 {
        return Err("FID must be greater than zero.".to_string());
    }

    let state = read_state(&app)?;
    let account = state
        .account
        .as_ref()
        .filter(|account| account.fid == fid)
        .ok_or_else(|| "Create a local desktop signer before approving it.".to_string())?;
    let custody = state
        .custody
        .as_ref()
        .ok_or_else(|| "Connect the Farcaster owner key before approving a signer.".to_string())?;

    if !custody.has_key {
        return Err(
            "The owner key is not saved in Keychain. Reconnect with Save custody key in Keychain enabled so Castora can approve this signer locally."
                .to_string(),
        );
    }

    let signing_key = signing_key_from_keychain(fid)?;
    let local_public_key = format!("0x{}", hex::encode(signing_key.verifying_key().to_bytes()));

    if local_public_key.to_lowercase() != account.public_key_hex.to_lowercase() {
        return Err("Local signer keychain entry does not match the selected account.".to_string());
    }

    let mut custody_private_key = custody_private_key_from_keychain(&custody.address)?;
    let nonce = next_signer_nonce(&app, fid)?;
    let message = build_key_add_message(fid, &signing_key, &custody_private_key, nonce);
    custody_private_key.zeroize();
    let message = message?;
    let submit = post_raw_message(submit_url, message.envelope).await?;

    if !submit.ok {
        return Err(format!(
            "Signer approval submit failed with HTTP {}: {}",
            submit.status, submit.body
        ));
    }

    Ok(ApproveSignerResponse {
        public_key_hex: local_public_key,
        custody_address: custody.address.clone(),
        nonce: message.nonce,
        deadline_unix: message.deadline_unix,
        ttl_seconds: message.ttl_seconds,
        hash_hex: message.hash_hex,
        submit,
    })
}

#[tauri::command]
fn delete_signer(app: AppHandle, fid: u64) -> Result<(), String> {
    if fid == 0 {
        return Err("FID must be greater than zero.".to_string());
    }

    let _ = signer_entry(fid)?.delete_credential();
    let mut state = read_state(&app)?;

    if state
        .account
        .as_ref()
        .is_some_and(|account| account.fid == fid)
    {
        state.account = None;
        state.settings.selected_fid = None;
        write_state(&app, &state)?;
    }

    Ok(())
}

#[tauri::command]
fn delete_custody_identity(app: AppHandle) -> Result<(), String> {
    let mut state = read_state(&app)?;

    if let Some(identity) = state.custody.as_ref() {
        let _ = custody_entry(&identity.address)?.delete_credential();
    }

    state.custody = None;
    write_state(&app, &state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_account,
            get_custody_identity,
            create_signer,
            import_signer,
            import_custody_from_mnemonic,
            import_custody_private_key,
            sign_message_hash,
            submit_raw_message,
            approve_signer,
            delete_signer,
            delete_custody_identity
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        abi_encode_signed_key_request_metadata, build_key_add_message, checksum_eth_address_hex,
        custody_identity_from_private_key, custody_private_key_from_hex,
        derive_custody_private_key_from_mnemonic, hash_from_hex, normalize_mnemonic_phrase,
        private_key_from_hex, sign_eip712_digest, signed_key_request_digest, to_uint256,
        DEFAULT_CUSTODY_DERIVATION_PATH,
    };
    use ed25519_dalek::SigningKey as Ed25519SigningKey;

    #[test]
    fn accepts_prefixed_private_key_hex() {
        let input = format!("0x{}", "11".repeat(32));
        assert_eq!(private_key_from_hex(&input).unwrap(), [0x11; 32]);
    }

    #[test]
    fn rejects_short_private_key_hex() {
        assert!(private_key_from_hex("0x1234").is_err());
    }

    #[test]
    fn decodes_message_hash_hex() {
        assert_eq!(hash_from_hex("0x0102").unwrap(), vec![1, 2]);
    }

    #[test]
    fn normalizes_mnemonic_spacing_and_casing() {
        assert_eq!(
            normalize_mnemonic_phrase("  Test   TEST test  "),
            "test test test"
        );
    }

    #[test]
    fn checksums_eth_address() {
        assert_eq!(
            checksum_eth_address_hex("f39fd6e51aad88f6f4ce6ab8827279cfffb92266").unwrap(),
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        );
    }

    #[test]
    fn derives_hardhat_custody_address_from_mnemonic() {
        let private_key = derive_custody_private_key_from_mnemonic(
            "test test test test test test test test test test test junk",
            DEFAULT_CUSTODY_DERIVATION_PATH,
        )
        .unwrap();
        let identity = custody_identity_from_private_key(
            &private_key,
            DEFAULT_CUSTODY_DERIVATION_PATH.into(),
            false,
        )
        .unwrap();

        assert_eq!(
            identity.address,
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        );
        assert!(!identity.has_key);
    }

    #[test]
    fn rejects_invalid_custody_private_key() {
        assert!(custody_private_key_from_hex("0x1234").is_err());
        assert!(custody_private_key_from_hex(&format!("0x{}", "00".repeat(32))).is_err());
    }

    #[test]
    fn encodes_uint256_as_left_padded_word() {
        let encoded = to_uint256(513);
        assert_eq!(&encoded[..30], &[0u8; 30]);
        assert_eq!(encoded[30], 2);
        assert_eq!(encoded[31], 1);
    }

    #[test]
    fn signs_eip712_digest_as_ethereum_signature() {
        let private_key = derive_custody_private_key_from_mnemonic(
            "test test test test test test test test test test test junk",
            DEFAULT_CUSTODY_DERIVATION_PATH,
        )
        .unwrap();
        let digest = signed_key_request_digest(1, &[7u8; 32], 1_900_000_000);
        let signature = sign_eip712_digest(&digest, &private_key).unwrap();

        assert_eq!(signature.len(), 65);
        assert!(signature[64] == 27 || signature[64] == 28);
    }

    #[test]
    fn abi_encodes_signed_key_request_metadata() {
        let signature = [9u8; 65];
        let encoded = abi_encode_signed_key_request_metadata(
            123,
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            &signature,
            1_900_000_000,
        )
        .unwrap();

        assert_eq!(encoded.len(), 256);
        assert_eq!(&encoded[..31], &[0u8; 31]);
        assert_eq!(encoded[31], 123);
        assert_eq!(encoded[159], 65);
        assert_eq!(&encoded[160..225], &signature);
    }

    #[test]
    fn builds_key_add_envelope_for_existing_signer() {
        let custody_private_key = derive_custody_private_key_from_mnemonic(
            "test test test test test test test test test test test junk",
            DEFAULT_CUSTODY_DERIVATION_PATH,
        )
        .unwrap();
        let signer = Ed25519SigningKey::from_bytes(&[1u8; 32]);
        let message =
            build_key_add_message(123, &signer, &custody_private_key, 1_800_000_000).unwrap();

        assert!(message.envelope.len() > 400);
        assert_eq!(message.hash_hex.len(), 42);
        assert_eq!(message.ttl_seconds, 90 * 24 * 60 * 60);
        assert_eq!(message.nonce, 1_800_000_000);
    }
}
