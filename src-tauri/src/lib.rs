use bip32::{secp256k1::ecdsa::SigningKey as Secp256k1SigningKey, DerivationPath, XPrv};
use bip39::{Language, Mnemonic};
use ed25519_dalek::{Signer, SigningKey as Ed25519SigningKey};
use keyring_core::Entry;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use std::{fs, path::PathBuf, sync::OnceLock};
use tauri::{AppHandle, Manager};
use zeroize::Zeroize;

const KEYCHAIN_SERVICE: &str = "social.castora.desktop";
const DEFAULT_NODE_BASE_URL: &str = "https://haatz.quilibrium.com";
const DEFAULT_HUB_SUBMIT_URL: &str = "https://haatz.quilibrium.com/v1/submitMessage";
const DEFAULT_CUSTODY_DERIVATION_PATH: &str = "m/44'/60'/0'/0/0";
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

fn signing_key_from_keychain(fid: u64) -> Result<Ed25519SigningKey, String> {
    let private_key_hex = signer_entry(fid)?
        .get_password()
        .map_err(|error| format!("Failed to read signer from keychain: {error}"))?;
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

    let response = reqwest::Client::new()
        .post(submit_url)
        .header("content-type", "application/octet-stream")
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
            delete_signer,
            delete_custody_identity
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        checksum_eth_address_hex, custody_identity_from_private_key, custody_private_key_from_hex,
        derive_custody_private_key_from_mnemonic, hash_from_hex, normalize_mnemonic_phrase,
        private_key_from_hex, DEFAULT_CUSTODY_DERIVATION_PATH,
    };

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
}
