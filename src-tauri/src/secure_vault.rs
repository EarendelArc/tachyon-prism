use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use zeroize::{Zeroize, Zeroizing};

use crate::{secure_file_permissions, write_atomic};

const VAULT_VERSION: u32 = 1;
const VAULT_ALGORITHM: &str = "XChaCha20-Poly1305";
const VAULT_AAD: &[u8] = b"tachyon-prism:secure-vault:v1";
const MASTER_KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;
const KEYRING_SERVICE: &str = "io.tachyon.prism";
const KEYRING_ACCOUNT: &str = "secure-vault-master-key-v1";
const VAULT_FILE_NAME: &str = "secure-vault.v1.json";
const CLEAR_STATE_FILE_NAME: &str = "secure-vault.v1.clear-state.json";
const CLEAR_STATE_VERSION: u32 = 1;

pub const SECTION_SUBSCRIPTIONS: &str = "subscriptions";
pub const SECTION_TACHYON_SERVERS: &str = "tachyonServers";
pub const SECTION_XRAY_ADVANCED: &str = "xrayAdvancedEditor";
pub const SECTION_RUNTIME_TGP_PSK: &str = "runtimeTgpAuthPsk";

static VAULT_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecureVaultPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscriptions: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tachyon_servers: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xray_advanced_editor: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_tgp_auth_psk: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecureVaultLoadResult {
    pub version: u32,
    pub revision: u64,
    pub payload: SecureVaultPayload,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecureVaultMigrationResult {
    pub version: u32,
    pub revision: u64,
    pub migrated_sections: Vec<String>,
    pub payload: SecureVaultPayload,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultEnvelope {
    version: u32,
    algorithm: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct VaultDocument {
    version: u32,
    revision: u64,
    sections: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearState {
    version: u32,
    vault_file: String,
}

trait MasterKeyStore {
    fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String>;
    fn store(&self, key: &[u8]) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

trait VaultFileOps {
    fn remove(&self, path: &Path) -> std::io::Result<()>;
}

struct SystemVaultFileOps;

impl VaultFileOps for SystemVaultFileOps {
    fn remove(&self, path: &Path) -> std::io::Result<()> {
        fs::remove_file(path)
    }
}

struct SystemMasterKeyStore;

impl SystemMasterKeyStore {
    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|_| "secure-vault-keyring-unavailable".to_string())
    }
}

impl MasterKeyStore for SystemMasterKeyStore {
    fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        match self.entry()?.get_secret() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("secure-vault-keyring-unavailable".to_string()),
        }
    }

    fn store(&self, key: &[u8]) -> Result<(), String> {
        self.entry()?
            .set_secret(key)
            .map_err(|_| "secure-vault-keyring-unavailable".to_string())?;
        let reread = self
            .load()?
            .ok_or_else(|| "secure-vault-keyring-verification-failed".to_string())?;
        if reread.as_slice() != key {
            return Err("secure-vault-keyring-verification-failed".to_string());
        }
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err("secure-vault-keyring-unavailable".to_string()),
        }
        match self.load()? {
            None => Ok(()),
            Some(_) => Err("secure-vault-keyring-verification-failed".to_string()),
        }
    }
}

pub fn vault_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "secure-vault-path-unavailable".to_string())?;
    Ok(directory.join(VAULT_FILE_NAME))
}

pub fn load(app: &tauri::AppHandle) -> Result<SecureVaultLoadResult, String> {
    load_at(&vault_path(app)?, &SystemMasterKeyStore)
}

pub fn save_section(
    app: &tauri::AppHandle,
    section: &str,
    value: Value,
) -> Result<SecureVaultLoadResult, String> {
    save_section_at(&vault_path(app)?, &SystemMasterKeyStore, section, value)
}

pub fn migrate(
    app: &tauri::AppHandle,
    payload: SecureVaultPayload,
) -> Result<SecureVaultMigrationResult, String> {
    migrate_at(&vault_path(app)?, &SystemMasterKeyStore, payload)
}

pub fn clear(app: &tauri::AppHandle) -> Result<(), String> {
    clear_at(&vault_path(app)?, &SystemMasterKeyStore)
}

fn load_at(path: &Path, keys: &dyn MasterKeyStore) -> Result<SecureVaultLoadResult, String> {
    let _guard = vault_lock()?;
    recover_interrupted_clear(path, keys, &SystemVaultFileOps)?;
    let document = load_document(path, keys, false)?;
    Ok(load_result(document))
}

fn save_section_at(
    path: &Path,
    keys: &dyn MasterKeyStore,
    section: &str,
    value: Value,
) -> Result<SecureVaultLoadResult, String> {
    validate_section(section)?;
    let _guard = vault_lock()?;
    recover_interrupted_clear(path, keys, &SystemVaultFileOps)?;
    let mut document = load_document(path, keys, true)?;
    document.sections.insert(section.to_string(), value);
    document.revision = document.revision.saturating_add(1);
    persist_verified(path, keys, &document)?;
    Ok(load_result(document))
}

fn migrate_at(
    path: &Path,
    keys: &dyn MasterKeyStore,
    payload: SecureVaultPayload,
) -> Result<SecureVaultMigrationResult, String> {
    let _guard = vault_lock()?;
    recover_interrupted_clear(path, keys, &SystemVaultFileOps)?;
    let mut document = load_document(path, keys, true)?;
    let mut migrated_sections = Vec::new();
    for (section, value) in payload_sections(payload) {
        validate_section(section)?;
        if document.sections.contains_key(section) {
            continue;
        }
        document.sections.insert(section.to_string(), value);
        migrated_sections.push(section.to_string());
    }
    if !migrated_sections.is_empty() {
        document.revision = document.revision.saturating_add(1);
        persist_verified(path, keys, &document)?;
    }
    let result = load_result(document);
    Ok(SecureVaultMigrationResult {
        version: result.version,
        revision: result.revision,
        migrated_sections,
        payload: result.payload,
    })
}

fn clear_at(path: &Path, keys: &dyn MasterKeyStore) -> Result<(), String> {
    clear_at_with(path, keys, &SystemVaultFileOps)
}

fn clear_at_with(
    path: &Path,
    keys: &dyn MasterKeyStore,
    files: &dyn VaultFileOps,
) -> Result<(), String> {
    let _guard = vault_lock()?;
    recover_interrupted_clear(path, keys, files)?;
    write_clear_state(path)?;
    // The marker and ciphertext are intentionally retained. Recovery checks
    // whether the key still exists before deciding which state survived.
    keys.clear()?;
    remove_if_exists(files, path).map_err(|_| "secure-vault-clear-pending".to_string())?;
    remove_if_exists(files, &clear_state_path(path))
        .map_err(|_| "secure-vault-clear-state-pending".to_string())
}

fn clear_state_path(path: &Path) -> PathBuf {
    path.with_file_name(CLEAR_STATE_FILE_NAME)
}

fn write_clear_state(path: &Path) -> Result<(), String> {
    let marker_path = clear_state_path(path);
    let marker = ClearState {
        version: CLEAR_STATE_VERSION,
        vault_file: VAULT_FILE_NAME.to_string(),
    };
    let encoded = serde_json::to_string(&marker)
        .map_err(|_| "secure-vault-clear-state-write-failed".to_string())?;
    write_atomic(&marker_path, &(encoded + "\n"))
        .map_err(|_| "secure-vault-clear-state-write-failed".to_string())?;
    secure_file_permissions(&marker_path)
        .map_err(|_| "secure-vault-clear-state-permissions-failed".to_string())
}

fn recover_interrupted_clear(
    path: &Path,
    keys: &dyn MasterKeyStore,
    files: &dyn VaultFileOps,
) -> Result<(), String> {
    let marker_path = clear_state_path(path);
    if !marker_path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&marker_path)
        .map_err(|_| "secure-vault-clear-state-read-failed".to_string())?;
    let marker: ClearState =
        serde_json::from_str(&raw).map_err(|_| "secure-vault-clear-state-corrupt".to_string())?;
    if marker.version != CLEAR_STATE_VERSION || marker.vault_file != VAULT_FILE_NAME {
        return Err("secure-vault-clear-state-corrupt".to_string());
    }

    if keys.load()?.is_some() {
        // Key deletion did not complete. Preserve the still-decryptable vault.
        remove_if_exists(files, &marker_path)
            .map_err(|_| "secure-vault-clear-state-pending".to_string())?;
        return Ok(());
    }

    // The master key is gone. Any surviving ciphertext is cryptographically
    // orphaned and can be deleted before a future save creates a fresh key.
    remove_if_exists(files, path).map_err(|_| "secure-vault-clear-pending".to_string())?;
    remove_if_exists(files, &marker_path)
        .map_err(|_| "secure-vault-clear-state-pending".to_string())
}

fn remove_if_exists(files: &dyn VaultFileOps, path: &Path) -> std::io::Result<()> {
    match files.remove(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn vault_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    VAULT_MUTEX
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "secure-vault-lock-failed".to_string())
}

fn load_document(
    path: &Path,
    keys: &dyn MasterKeyStore,
    create_if_missing: bool,
) -> Result<VaultDocument, String> {
    if !path.exists() {
        if !create_if_missing {
            return Ok(empty_document());
        }
        let key = load_or_create_key(keys, false)?;
        let document = empty_document();
        persist_with_key(path, &key, &document)?;
        return Ok(document);
    }
    let key = load_or_create_key(keys, true)?;
    decrypt_document(path, &key)
}

fn empty_document() -> VaultDocument {
    VaultDocument {
        version: VAULT_VERSION,
        revision: 0,
        sections: BTreeMap::new(),
    }
}

fn load_or_create_key(
    keys: &dyn MasterKeyStore,
    vault_exists: bool,
) -> Result<Zeroizing<Vec<u8>>, String> {
    if let Some(key) = keys.load()? {
        validate_master_key(&key)?;
        return Ok(key);
    }
    if vault_exists {
        return Err("secure-vault-key-missing".to_string());
    }
    let mut generated = Zeroizing::new(Vec::from(rand::random::<[u8; MASTER_KEY_BYTES]>()));
    keys.store(&generated)?;
    let loaded = keys
        .load()?
        .ok_or_else(|| "secure-vault-keyring-verification-failed".to_string())?;
    validate_master_key(&loaded)?;
    generated.zeroize();
    Ok(loaded)
}

fn validate_master_key(key: &[u8]) -> Result<(), String> {
    if key.len() == MASTER_KEY_BYTES {
        Ok(())
    } else {
        Err("secure-vault-key-invalid".to_string())
    }
}

fn persist_verified(
    path: &Path,
    keys: &dyn MasterKeyStore,
    document: &VaultDocument,
) -> Result<(), String> {
    let key = load_or_create_key(keys, path.exists())?;
    persist_with_key(path, &key, document)?;
    let verified = decrypt_document(path, &key)?;
    if &verified != document {
        return Err("secure-vault-write-verification-failed".to_string());
    }
    Ok(())
}

fn persist_with_key(path: &Path, key: &[u8], document: &VaultDocument) -> Result<(), String> {
    validate_master_key(key)?;
    let plaintext = Zeroizing::new(
        serde_json::to_vec(document).map_err(|_| "secure-vault-encode-failed".to_string())?,
    );
    let nonce_bytes = rand::random::<[u8; NONCE_BYTES]>();
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "secure-vault-key-invalid".to_string())?;
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce_bytes),
            Payload {
                msg: plaintext.as_slice(),
                aad: VAULT_AAD,
            },
        )
        .map_err(|_| "secure-vault-encryption-failed".to_string())?;
    let envelope = VaultEnvelope {
        version: VAULT_VERSION,
        algorithm: VAULT_ALGORITHM.to_string(),
        nonce: STANDARD_NO_PAD.encode(nonce_bytes),
        ciphertext: STANDARD_NO_PAD.encode(ciphertext),
    };
    let encoded =
        serde_json::to_string(&envelope).map_err(|_| "secure-vault-encode-failed".to_string())?;
    write_atomic(path, &(encoded + "\n")).map_err(|_| "secure-vault-write-failed".to_string())?;
    secure_file_permissions(path).map_err(|_| "secure-vault-permissions-failed".to_string())
}

fn decrypt_document(path: &Path, key: &[u8]) -> Result<VaultDocument, String> {
    validate_master_key(key)?;
    let raw = fs::read_to_string(path).map_err(|_| "secure-vault-read-failed".to_string())?;
    let envelope: VaultEnvelope =
        serde_json::from_str(&raw).map_err(|_| "secure-vault-corrupt".to_string())?;
    if envelope.version != VAULT_VERSION || envelope.algorithm != VAULT_ALGORITHM {
        return Err("secure-vault-version-unsupported".to_string());
    }
    let nonce = STANDARD_NO_PAD
        .decode(envelope.nonce)
        .map_err(|_| "secure-vault-corrupt".to_string())?;
    if nonce.len() != NONCE_BYTES {
        return Err("secure-vault-corrupt".to_string());
    }
    let nonce_bytes: [u8; NONCE_BYTES] = nonce
        .as_slice()
        .try_into()
        .map_err(|_| "secure-vault-corrupt".to_string())?;
    let ciphertext = STANDARD_NO_PAD
        .decode(envelope.ciphertext)
        .map_err(|_| "secure-vault-corrupt".to_string())?;
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "secure-vault-key-invalid".to_string())?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                &XNonce::from(nonce_bytes),
                Payload {
                    msg: ciphertext.as_slice(),
                    aad: VAULT_AAD,
                },
            )
            .map_err(|_| "secure-vault-authentication-failed".to_string())?,
    );
    let document: VaultDocument =
        serde_json::from_slice(&plaintext).map_err(|_| "secure-vault-corrupt".to_string())?;
    if document.version != VAULT_VERSION {
        return Err("secure-vault-version-unsupported".to_string());
    }
    Ok(document)
}

fn validate_section(section: &str) -> Result<(), String> {
    if matches!(
        section,
        SECTION_SUBSCRIPTIONS
            | SECTION_TACHYON_SERVERS
            | SECTION_XRAY_ADVANCED
            | SECTION_RUNTIME_TGP_PSK
    ) {
        Ok(())
    } else {
        Err("secure-vault-section-invalid".to_string())
    }
}

fn payload_sections(payload: SecureVaultPayload) -> Vec<(&'static str, Value)> {
    let mut sections = Vec::new();
    if let Some(value) = payload.subscriptions {
        sections.push((SECTION_SUBSCRIPTIONS, value));
    }
    if let Some(value) = payload.tachyon_servers {
        sections.push((SECTION_TACHYON_SERVERS, value));
    }
    if let Some(value) = payload.xray_advanced_editor {
        sections.push((SECTION_XRAY_ADVANCED, value));
    }
    if let Some(value) = payload.runtime_tgp_auth_psk {
        sections.push((SECTION_RUNTIME_TGP_PSK, value));
    }
    sections
}

fn load_result(document: VaultDocument) -> SecureVaultLoadResult {
    SecureVaultLoadResult {
        version: document.version,
        revision: document.revision,
        payload: SecureVaultPayload {
            subscriptions: document.sections.get(SECTION_SUBSCRIPTIONS).cloned(),
            tachyon_servers: document.sections.get(SECTION_TACHYON_SERVERS).cloned(),
            xray_advanced_editor: document.sections.get(SECTION_XRAY_ADVANCED).cloned(),
            runtime_tgp_auth_psk: document.sections.get(SECTION_RUNTIME_TGP_PSK).cloned(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tempfile::TempDir;

    #[derive(Default)]
    struct MemoryKeyStore {
        key: Mutex<Option<Vec<u8>>>,
        unavailable: bool,
        fail_clear: AtomicBool,
    }

    impl MemoryKeyStore {
        fn with_key(key: Vec<u8>) -> Self {
            Self {
                key: Mutex::new(Some(key)),
                unavailable: false,
                fail_clear: AtomicBool::new(false),
            }
        }
    }

    impl MasterKeyStore for MemoryKeyStore {
        fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
            if self.unavailable {
                return Err("secure-vault-keyring-unavailable".to_string());
            }
            Ok(self.key.lock().unwrap().clone().map(Zeroizing::new))
        }

        fn store(&self, key: &[u8]) -> Result<(), String> {
            if self.unavailable {
                return Err("secure-vault-keyring-unavailable".to_string());
            }
            *self.key.lock().unwrap() = Some(key.to_vec());
            Ok(())
        }

        fn clear(&self) -> Result<(), String> {
            if self.fail_clear.load(Ordering::SeqCst) {
                return Err("secure-vault-keyring-unavailable".to_string());
            }
            *self.key.lock().unwrap() = None;
            Ok(())
        }
    }

    fn fixture() -> (TempDir, PathBuf, MemoryKeyStore) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(VAULT_FILE_NAME);
        (directory, path, MemoryKeyStore::default())
    }

    #[test]
    fn round_trips_encrypted_sections_without_plaintext_on_disk() {
        let (_directory, path, keys) = fixture();
        let secret = "vless://private-node-uri";
        save_section_at(
            &path,
            &keys,
            SECTION_SUBSCRIPTIONS,
            serde_json::json!({ "sourceUrl": secret }),
        )
        .unwrap();

        let loaded = load_at(&path, &keys).unwrap();
        assert_eq!(
            loaded.payload.subscriptions,
            Some(serde_json::json!({ "sourceUrl": secret }))
        );
        let disk = fs::read_to_string(path).unwrap();
        assert!(!disk.contains(secret));
        assert!(disk.contains(VAULT_ALGORITHM));
    }

    #[test]
    fn keyring_identity_and_envelope_schema_are_stable() {
        assert_eq!(KEYRING_SERVICE, "io.tachyon.prism");
        assert_eq!(KEYRING_ACCOUNT, "secure-vault-master-key-v1");
        assert_eq!(VAULT_AAD, b"tachyon-prism:secure-vault:v1");
        assert_eq!(VAULT_VERSION, 1);
        assert_eq!(VAULT_ALGORITHM, "XChaCha20-Poly1305");
    }

    #[test]
    fn independent_vaults_receive_distinct_random_master_keys() {
        let first = fixture();
        let second = fixture();
        save_section_at(
            &first.1,
            &first.2,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("a".into()),
        )
        .unwrap();
        save_section_at(
            &second.1,
            &second.2,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("b".into()),
        )
        .unwrap();
        let first_key = first.2.key.lock().unwrap().clone().unwrap();
        let second_key = second.2.key.lock().unwrap().clone().unwrap();
        assert_eq!(first_key.len(), MASTER_KEY_BYTES);
        assert_eq!(second_key.len(), MASTER_KEY_BYTES);
        assert_ne!(first_key, second_key);
        assert_ne!(first_key, vec![0; MASTER_KEY_BYTES]);
        assert_ne!(second_key, vec![0; MASTER_KEY_BYTES]);
    }

    #[test]
    fn every_persist_uses_a_fresh_xchacha_nonce() {
        let (_directory, path, keys) = fixture();
        save_section_at(
            &path,
            &keys,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("first".into()),
        )
        .unwrap();
        let first: VaultEnvelope =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        save_section_at(
            &path,
            &keys,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("second".into()),
        )
        .unwrap();
        let second: VaultEnvelope =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_ne!(first.nonce, second.nonce);
        assert_eq!(
            STANDARD_NO_PAD.decode(first.nonce).unwrap().len(),
            NONCE_BYTES
        );
        assert_eq!(
            STANDARD_NO_PAD.decode(second.nonce).unwrap().len(),
            NONCE_BYTES
        );
    }

    #[test]
    fn ciphertext_is_bound_to_the_versioned_aad() {
        let (_directory, path, keys) = fixture();
        save_section_at(
            &path,
            &keys,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("bound".into()),
        )
        .unwrap();
        let envelope: VaultEnvelope =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let nonce = STANDARD_NO_PAD.decode(envelope.nonce).unwrap();
        let ciphertext = STANDARD_NO_PAD.decode(envelope.ciphertext).unwrap();
        let key = keys.key.lock().unwrap().clone().unwrap();
        let cipher = XChaCha20Poly1305::new_from_slice(&key).unwrap();
        let nonce: [u8; NONCE_BYTES] = nonce.try_into().unwrap();
        assert!(cipher
            .decrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: &ciphertext,
                    aad: b"tachyon-prism:secure-vault:wrong"
                },
            )
            .is_err());
    }

    #[test]
    fn rejects_tampering_and_wrong_keys() {
        let (_directory, path, keys) = fixture();
        save_section_at(
            &path,
            &keys,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("psk".into()),
        )
        .unwrap();

        let wrong = MemoryKeyStore::with_key(vec![9; MASTER_KEY_BYTES]);
        assert_eq!(
            load_at(&path, &wrong).unwrap_err(),
            "secure-vault-authentication-failed"
        );

        let mut envelope: VaultEnvelope =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        envelope.ciphertext.replace_range(0..1, "A");
        fs::write(&path, serde_json::to_string(&envelope).unwrap()).unwrap();
        assert_eq!(
            load_at(&path, &keys).unwrap_err(),
            "secure-vault-authentication-failed"
        );
    }

    #[test]
    fn stale_atomic_candidates_do_not_replace_the_verified_vault() {
        let (_directory, path, keys) = fixture();
        save_section_at(
            &path,
            &keys,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("verified".into()),
        )
        .unwrap();
        fs::write(path.with_extension("tmp"), "truncated candidate").unwrap();

        let loaded = load_at(&path, &keys).unwrap();
        assert_eq!(
            loaded.payload.runtime_tgp_auth_psk,
            Some(Value::String("verified".into()))
        );
    }

    #[test]
    fn migration_is_verified_and_idempotent() {
        let (_directory, path, keys) = fixture();
        let legacy = SecureVaultPayload {
            subscriptions: Some(serde_json::json!({ "sourceUrl": "https://secret" })),
            tachyon_servers: Some(serde_json::json!({ "profiles": [] })),
            ..Default::default()
        };
        let first = migrate_at(&path, &keys, legacy.clone()).unwrap();
        assert_eq!(
            first.migrated_sections,
            vec![SECTION_SUBSCRIPTIONS, SECTION_TACHYON_SERVERS]
        );
        let second = migrate_at(&path, &keys, legacy).unwrap();
        assert!(second.migrated_sections.is_empty());
        assert_eq!(first.revision, second.revision);
        assert_eq!(first.payload, second.payload);
    }

    #[test]
    fn existing_vault_without_key_fails_closed() {
        let (_directory, path, keys) = fixture();
        save_section_at(
            &path,
            &keys,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("psk".into()),
        )
        .unwrap();
        keys.clear().unwrap();
        assert_eq!(
            load_at(&path, &keys).unwrap_err(),
            "secure-vault-key-missing"
        );
    }

    #[test]
    fn unavailable_keyring_never_creates_plaintext_fallback() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(VAULT_FILE_NAME);
        let keys = MemoryKeyStore {
            key: Mutex::new(None),
            unavailable: true,
            fail_clear: AtomicBool::new(false),
        };
        assert_eq!(
            save_section_at(
                &path,
                &keys,
                SECTION_RUNTIME_TGP_PSK,
                Value::String("must-not-persist".into())
            )
            .unwrap_err(),
            "secure-vault-keyring-unavailable"
        );
        assert!(!path.exists());
    }

    struct FailVaultRemovalOnce {
        vault_path: PathBuf,
        failed: AtomicBool,
    }

    impl VaultFileOps for FailVaultRemovalOnce {
        fn remove(&self, path: &Path) -> std::io::Result<()> {
            if path == self.vault_path && !self.failed.swap(true, Ordering::SeqCst) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected ciphertext deletion failure",
                ));
            }
            fs::remove_file(path)
        }
    }

    #[test]
    fn key_deletion_failure_preserves_ciphertext_and_recovers_existing_vault() {
        let (_directory, path, keys) = fixture();
        save_section_at(
            &path,
            &keys,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("must-survive".into()),
        )
        .unwrap();
        let before = fs::read(&path).unwrap();
        keys.fail_clear.store(true, Ordering::SeqCst);

        assert_eq!(
            clear_at(&path, &keys).unwrap_err(),
            "secure-vault-keyring-unavailable"
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(clear_state_path(&path).exists());
        assert!(keys.key.lock().unwrap().is_some());

        keys.fail_clear.store(false, Ordering::SeqCst);
        let loaded = load_at(&path, &keys).unwrap();
        assert_eq!(
            loaded.payload.runtime_tgp_auth_psk,
            Some(Value::String("must-survive".into()))
        );
        assert!(!clear_state_path(&path).exists());
    }

    #[test]
    fn ciphertext_delete_failure_leaves_recoverable_key_destroyed_state() {
        let (directory, path, keys) = fixture();
        save_section_at(
            &path,
            &keys,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("old-secret".into()),
        )
        .unwrap();
        let old_key = keys.key.lock().unwrap().clone().unwrap();
        let old_ciphertext = fs::read(&path).unwrap();
        let files = FailVaultRemovalOnce {
            vault_path: path.clone(),
            failed: AtomicBool::new(false),
        };

        assert_eq!(
            clear_at_with(&path, &keys, &files).unwrap_err(),
            "secure-vault-clear-pending"
        );
        assert!(keys.key.lock().unwrap().is_none());
        assert_eq!(fs::read(&path).unwrap(), old_ciphertext);
        assert!(clear_state_path(&path).exists());

        save_section_at(
            &path,
            &keys,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("new-secret".into()),
        )
        .unwrap();
        let new_key = keys.key.lock().unwrap().clone().unwrap();
        assert_ne!(new_key, old_key);
        assert!(!clear_state_path(&path).exists());

        let restored = directory.path().join("restored-old-vault.json");
        fs::write(&restored, old_ciphertext).unwrap();
        assert_eq!(
            decrypt_document(&restored, &new_key).unwrap_err(),
            "secure-vault-authentication-failed"
        );
        assert_eq!(
            decrypt_document(&restored, &old_key)
                .unwrap()
                .sections
                .get(SECTION_RUNTIME_TGP_PSK),
            Some(&Value::String("old-secret".into()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn vault_file_permissions_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let (_directory, path, keys) = fixture();
        save_section_at(
            &path,
            &keys,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("psk".into()),
        )
        .unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn vault_file_uses_a_protected_windows_dacl() {
        let (_directory, path, keys) = fixture();
        save_section_at(
            &path,
            &keys,
            SECTION_RUNTIME_TGP_PSK,
            Value::String("psk".into()),
        )
        .unwrap();
        let audit = crate::windows_file_dacl_audit(&path).unwrap();
        assert!(audit.protected);
        assert_eq!(audit.trustees.len(), 3);
        assert!(audit.trustees.iter().any(|sid| sid == "S-1-5-18"));
        assert!(audit.trustees.iter().any(|sid| sid == "S-1-5-32-544"));
        for forbidden in ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"] {
            assert!(!audit.trustees.iter().any(|sid| sid == forbidden));
        }
    }
}
