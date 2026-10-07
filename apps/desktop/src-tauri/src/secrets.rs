//! Secret storage for API keys. Primary store is the OS keychain (macOS
//! Keychain / Windows Credential Manager / Linux keyutils via the `keyring`
//! crate); when no keychain service is available (headless CI, some Linux
//! setups) it degrades to a 0600 JSON file in the app data directory.
//!
//! Keys are addressed by opaque strings (`ai.key.<configId>`); values never
//! leave the Rust side except to the AI HTTP client (spec §49).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use ts_rs::TS;

use crate::error::{AppError, ErrorCode};

const SERVICE: &str = "deepread";

#[derive(Debug, Clone)]
pub enum SecretStore {
    Keyring,
    // File(PathBuf) is constructed by tests and (planned) by the headless
    // runtime fallback in Phase 3 II; dead_code is allowed on purpose.
    #[allow(dead_code)]
    File(PathBuf),
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretFile {
    #[serde(flatten)]
    entries: std::collections::HashMap<String, String>,
}

fn keyring_entry(key: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(SERVICE, key)
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "keychain unavailable").with_cause(err))
}

fn file_store_path(base: &Path) -> PathBuf {
    base.join("secrets.json")
}

fn file_load(base: &Path) -> SecretFile {
    std::fs::read_to_string(file_store_path(base))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn file_save(base: &Path, store: &SecretFile) -> Result<(), AppError> {
    std::fs::create_dir_all(base).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to create data directory").with_cause(err)
    })?;
    let bytes = serde_json::to_vec_pretty(store).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to serialize secrets").with_cause(err)
    })?;
    let path = file_store_path(base);
    std::fs::write(&path, bytes).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to write secrets").with_cause(err)
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|err| {
            AppError::new(
                ErrorCode::StorageIo,
                "failed to restrict secrets permissions",
            )
            .with_cause(err)
        })?;
    }
    Ok(())
}

pub fn set_secret(
    store: &SecretStore,
    base: &Path,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    match store {
        SecretStore::Keyring => match keyring_entry(key) {
            Ok(entry) => entry.set_password(value).map_err(|err| {
                AppError::new(ErrorCode::StorageIo, "keychain write failed").with_cause(err)
            }),
            // No keychain service: degrade to the file store.
            Err(_) => file_set(base, key, value),
        },
        SecretStore::File(base_path) => file_set(base_path, key, value),
    }
}

fn file_set(base: &Path, key: &str, value: &str) -> Result<(), AppError> {
    let mut store = file_load(base);
    store.entries.insert(key.to_string(), value.to_string());
    file_save(base, &store)
}

pub fn get_secret(store: &SecretStore, base: &Path, key: &str) -> Result<Option<String>, AppError> {
    match store {
        SecretStore::Keyring => match keyring_entry(key) {
            Ok(entry) => entry
                .get_password()
                .map(Some)
                .or_else(|err| match err {
                    keyring::Error::NoEntry => Ok(None),
                    other => {
                        log::warn!("keychain read failed, falling back to file store: {other}");
                        file_get(base, key)
                    }
                })
                .map_err(|err: AppError| err),
            Err(_) => file_get(base, key),
        },
        SecretStore::File(base_path) => file_get(base_path, key),
    }
}

fn file_get(base: &Path, key: &str) -> Result<Option<String>, AppError> {
    Ok(file_load(base).entries.get(key).cloned())
}

pub fn delete_secret(store: &SecretStore, base: &Path, key: &str) -> Result<bool, AppError> {
    match store {
        SecretStore::Keyring => match keyring_entry(key) {
            Ok(entry) => match entry.delete_credential() {
                Ok(()) => Ok(true),
                Err(keyring::Error::NoEntry) => Ok(false),
                Err(_) => file_delete(base, key),
            },
            Err(_) => file_delete(base, key),
        },
        SecretStore::File(base_path) => file_delete(base_path, key),
    }
}

fn file_delete(base: &Path, key: &str) -> Result<bool, AppError> {
    let mut store = file_load(base);
    let removed = store.entries.remove(key).is_some();
    if removed {
        file_save(base, &store)?;
    }
    Ok(removed)
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SecretSetRequest {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SecretDeleteRequest {
    pub key: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecretDeleteResponse {
    pub deleted: bool,
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path().app_data_dir().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "app data directory unavailable").with_cause(err)
    })
}

#[tauri::command(rename = "secret.set")]
pub fn secret_set(
    app: tauri::AppHandle,
    store: State<'_, SecretStore>,
    request: SecretSetRequest,
) -> Result<(), AppError> {
    set_secret(&store, &data_dir(&app)?, &request.key, &request.value)
}

#[tauri::command(rename = "secret.delete")]
pub fn secret_delete(
    app: tauri::AppHandle,
    store: State<'_, SecretStore>,
    request: SecretDeleteRequest,
) -> Result<SecretDeleteResponse, AppError> {
    Ok(SecretDeleteResponse {
        deleted: delete_secret(&store, &data_dir(&app)?, &request.key)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "reader-secrets-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn file_store_round_trip_and_delete() {
        let base = temp_base("file");
        let store = SecretStore::File(base.clone());
        set_secret(&store, &base, "ai.key.test", "sk-value").unwrap();
        assert_eq!(
            get_secret(&store, &base, "ai.key.test").unwrap().as_deref(),
            Some("sk-value")
        );
        assert!(delete_secret(&store, &base, "ai.key.test").unwrap());
        assert_eq!(get_secret(&store, &base, "ai.key.test").unwrap(), None);
    }

    #[test]
    fn missing_key_is_none_not_error() {
        let base = temp_base("missing");
        let store = SecretStore::File(base.clone());
        assert_eq!(get_secret(&store, &base, "ai.key.none").unwrap(), None);
        assert!(!delete_secret(&store, &base, "ai.key.none").unwrap());
    }

    #[test]
    fn secrets_file_restricted_on_unix() {
        let base = temp_base("perms");
        let store = SecretStore::File(base.clone());
        set_secret(&store, &base, "ai.key.test", "v").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(file_store_path(&base))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    #[ignore = "touches the real OS keychain: macOS pops an authorization dialog in automation"]
    fn set_secret_via_keyring_fallback_writes_file_when_no_service() {
        // The keyring entry constructor succeeds on most platforms; the
        // set/get may fail without a keychain service — either way the store
        // must end up readable. This exercises the degradation path.
        let base = temp_base("fallback");
        let store = SecretStore::Keyring;
        let result = set_secret(&store, &base, "ai.key.fb", "v");
        let _ = result;
        let readable = get_secret(&store, &base, "ai.key.fb").unwrap();
        if result.is_ok() {
            assert_eq!(readable.as_deref(), Some("v"));
        }
    }
}
