use ed25519_dalek::{Signer, SigningKey};
use keyring_core::Entry;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::OnceLock};
use tauri::{AppHandle, Manager};

const KEYCHAIN_SERVICE: &str = "social.castora.desktop";
const DEFAULT_NODE_BASE_URL: &str = "https://haatz.quilibrium.com";
const DEFAULT_HUB_SUBMIT_URL: &str = "https://haatz.quilibrium.com/v1/submitMessage";
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DesktopState {
    settings: DesktopSettings,
    account: Option<DesktopAccount>,
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

fn hash_from_hex(hash_hex: &str) -> Result<Vec<u8>, String> {
    let normalized = normalize_hex(hash_hex);
    let bytes = hex::decode(&normalized).map_err(|error| format!("Invalid hash hex: {error}"))?;

    if bytes.is_empty() {
        return Err("Hash bytes cannot be empty.".to_string());
    }

    Ok(bytes)
}

fn signing_key_from_keychain(fid: u64) -> Result<SigningKey, String> {
    let private_key_hex = signer_entry(fid)?
        .get_password()
        .map_err(|error| format!("Failed to read signer from keychain: {error}"))?;
    Ok(SigningKey::from_bytes(&private_key_from_hex(&private_key_hex)?))
}

fn account_from_key(fid: u64, signing_key: &SigningKey) -> DesktopAccount {
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
fn create_signer(app: AppHandle, fid: u64) -> Result<DesktopAccount, String> {
    if fid == 0 {
        return Err("FID must be greater than zero.".to_string());
    }

    let signing_key = SigningKey::generate(&mut OsRng);
    signer_entry(fid)?
        .set_password(&format!("0x{}", hex::encode(signing_key.to_bytes())))
        .map_err(|error| format!("Failed to save signer to keychain: {error}"))?;
    save_account(&app, account_from_key(fid, &signing_key))
}

#[tauri::command]
fn import_signer(app: AppHandle, fid: u64, private_key_hex: String) -> Result<DesktopAccount, String> {
    if fid == 0 {
        return Err("FID must be greater than zero.".to_string());
    }

    let private_key = private_key_from_hex(&private_key_hex)?;
    let signing_key = SigningKey::from_bytes(&private_key);
    signer_entry(fid)?
        .set_password(&format!("0x{}", hex::encode(signing_key.to_bytes())))
        .map_err(|error| format!("Failed to save signer to keychain: {error}"))?;
    save_account(&app, account_from_key(fid, &signing_key))
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

    if state.account.as_ref().is_some_and(|account| account.fid == fid) {
        state.account = None;
        state.settings.selected_fid = None;
        write_state(&app, &state)?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_account,
            create_signer,
            import_signer,
            sign_message_hash,
            submit_raw_message,
            delete_signer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{hash_from_hex, private_key_from_hex};

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
}
