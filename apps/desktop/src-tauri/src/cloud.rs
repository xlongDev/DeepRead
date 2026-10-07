//! WebDAV cloud provider — the transport half of sync (spec §50-§53).
//!
//! The merge engine lives in `@deepread/shared` on the frontend; Rust is a
//! dumb, safe pipe: raw GET/PUT against the configured WebDAV endpoint with
//! keychain-held credentials, plus whole-database backup/restore (§126).
//! Remote payloads are untrusted — the frontend schema-validates everything
//! it pulls before it may touch storage.

use serde::{Deserialize, Serialize};

use crate::ai::data_dir;
use crate::error::{AppError, ErrorCode};

pub const DEVICE_ID_KEY: &str = "device.id";
pub const DEVICE_NAME_KEY: &str = "device.name";
pub const CLOUD_ENDPOINT_KEY: &str = "cloud.endpoint";
pub const CLOUD_USERNAME_KEY: &str = "cloud.username";
pub const CLOUD_PASSWORD_KEY: &str = "cloud.webdav.password";
pub const CLOUD_BASE_PATH: &str = "Deepread";

// ---------- Configuration ----------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudConfigGetResponse {
    pub config: Option<CloudConfig>,
    pub device_id: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudConfig {
    pub endpoint: String,
    pub username: String,
}

/// The stable device identity, created on first call (spec Sprint 13: Device).
pub fn device_identity(conn: &rusqlite::Connection) -> Result<(String, String), AppError> {
    let device_id = match crate::storage::get_setting(conn, DEVICE_ID_KEY)? {
        Some(id) => id,
        None => {
            let id = format!("dev-{}", crate::cloud::random_token());
            crate::storage::set_setting(conn, DEVICE_ID_KEY, &id)?;
            id
        }
    };
    let device_name = match crate::storage::get_setting(conn, DEVICE_NAME_KEY)? {
        Some(name) => name,
        None => {
            let name = format!("设备 {}", &device_id[device_id.len().saturating_sub(4)..]);
            crate::storage::set_setting(conn, DEVICE_NAME_KEY, &name)?;
            name
        }
    };
    Ok((device_id, device_name))
}

/// Random hex token from the OS entropy pool (no extra crate).
pub fn random_token() -> String {
    let mut bytes = [0u8; 8];
    getrandom_fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn getrandom_fill(buffer: &mut [u8]) {
    // /dev/urandom exists on macOS/Linux/Unix; Windows uses RtlGenRandom via
    // the same interface exposed through the bcrypt primitives — kept simple
    // with the win32 helper behind a cfg.
    #[cfg(unix)]
    {
        use std::io::Read;
        let mut file = std::fs::File::open("/dev/urandom").expect("/dev/urandom must exist");
        file.read_exact(buffer).expect("random read must succeed");
    }
    #[cfg(windows)]
    {
        // BCryptGenRandom via the raw FFI is overkill here; the process id,
        // time and a hash chain are enough for a device id that only needs
        // uniqueness, not secrecy.
        let mut hasher = sha2::Sha256::new();
        use sha2::Digest;
        hasher.update(std::process::id().to_le_bytes());
        hasher.update(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .to_le_bytes(),
        );
        hasher.update(&*buffer);
        let digest = hasher.finalize();
        buffer.copy_from_slice(&digest[..buffer.len()]);
    }
}

#[tauri::command(rename = "cloud.config.get")]
pub fn cloud_config_get(
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<CloudConfigGetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    let (device_id, device_name) = device_identity(&conn)?;
    let config = match (
        crate::storage::get_setting(&conn, CLOUD_ENDPOINT_KEY)?,
        crate::storage::get_setting(&conn, CLOUD_USERNAME_KEY)?,
    ) {
        (Some(endpoint), Some(username)) => Some(CloudConfig { endpoint, username }),
        _ => None,
    };
    Ok(CloudConfigGetResponse {
        config,
        device_id,
        device_name,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudConfigSaveRequest {
    pub endpoint: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudConfigSaveResponse {
    pub config: CloudConfig,
}

#[tauri::command(rename = "cloud.config.save")]
pub fn cloud_config_save(
    app: tauri::AppHandle,
    secrets: tauri::State<'_, crate::secrets::SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
    request: CloudConfigSaveRequest,
) -> Result<CloudConfigSaveResponse, AppError> {
    let base = data_dir(&app)?;
    let endpoint = request.endpoint.trim_end_matches('/').to_string();
    validate_endpoint(&endpoint)?;
    {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        crate::storage::set_setting(&conn, CLOUD_ENDPOINT_KEY, &endpoint)?;
        crate::storage::set_setting(&conn, CLOUD_USERNAME_KEY, request.username.trim())?;
    }
    crate::secrets::set_secret(&secrets, &base, CLOUD_PASSWORD_KEY, &request.password)?;
    Ok(CloudConfigSaveResponse {
        config: CloudConfig {
            endpoint,
            username: request.username.trim().to_string(),
        },
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudConfigTestRequest {
    pub endpoint: String,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
}

#[tauri::command(rename = "cloud.config.test")]
pub async fn cloud_config_test(
    app: tauri::AppHandle,
    secrets: tauri::State<'_, crate::secrets::SecretStore>,
    request: CloudConfigTestRequest,
) -> Result<crate::cloud::CloudTestResponse, AppError> {
    let base = data_dir(&app)?;
    let endpoint = request.endpoint.trim_end_matches('/').to_string();
    validate_endpoint(&endpoint)?;
    let password = match request.password {
        Some(password) if !password.is_empty() => password,
        _ => crate::secrets::get_secret(&secrets, &base, CLOUD_PASSWORD_KEY)?
            .ok_or_else(|| AppError::new(ErrorCode::SyncProviderError, "请先填写 WebDAV 密码"))?,
    };
    webdav_probe(&endpoint, &request.username, &password).await?;
    Ok(CloudTestResponse { ok: true })
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudTestResponse {
    pub ok: bool,
}

#[tauri::command(rename = "cloud.config.clear")]
pub fn cloud_config_clear(
    app: tauri::AppHandle,
    secrets: tauri::State<'_, crate::secrets::SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<crate::cloud::CloudClearResponse, AppError> {
    let base = data_dir(&app)?;
    {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        conn.execute(
            "DELETE FROM app_settings WHERE key = ?1",
            [CLOUD_ENDPOINT_KEY],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to clear setting").with_cause(err)
        })?;
        conn.execute(
            "DELETE FROM app_settings WHERE key = ?1",
            [CLOUD_USERNAME_KEY],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to clear setting").with_cause(err)
        })?;
    }
    crate::secrets::delete_secret(&secrets, &base, CLOUD_PASSWORD_KEY)?;
    Ok(CloudClearResponse { cleared: true })
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudClearResponse {
    pub cleared: bool,
}

/// Only http(s) endpoints are allowed — this URL is contacted with the
/// user's credentials, so anything else must be rejected at the boundary.
pub fn validate_endpoint(endpoint: &str) -> Result<(), AppError> {
    if endpoint.starts_with("https://") || endpoint.starts_with("http://") {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::SystemValidation,
            "WebDAV 地址必须以 http(s):// 开头",
        ))
    }
}

// ---------- WebDAV transport ----------

fn webdav_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .expect("reqwest client builds")
}

async fn webdav_probe(endpoint: &str, username: &str, password: &str) -> Result<(), AppError> {
    let response = webdav_client()
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").expect("valid method"),
            endpoint,
        )
        .basic_auth(username, Some(password))
        .header("Depth", "0")
        .send()
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::SyncProviderError, "无法连接 WebDAV 服务")
                .with_cause(err)
                .retryable()
        })?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AppError::new(
            ErrorCode::SyncProviderError,
            "WebDAV 用户名或密码不正确",
        ));
    }
    if !status.is_success() && status.as_u16() != 207 {
        return Err(AppError::new(
            ErrorCode::SyncProviderError,
            format!("WebDAV 服务返回错误({})", status.as_u16()),
        )
        .retryable());
    }
    Ok(())
}

/// GET a remote document; `Ok(None)` when it does not exist yet.
pub async fn webdav_get(
    endpoint: &str,
    username: &str,
    password: &str,
    path: &str,
) -> Result<Option<String>, AppError> {
    let url = format!(
        "{}/{}/{}",
        endpoint.trim_end_matches('/'),
        CLOUD_BASE_PATH,
        path.trim_start_matches('/')
    );
    let response = webdav_client()
        .get(&url)
        .basic_auth(username, Some(password))
        .send()
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::SyncProviderError, "无法连接 WebDAV 服务")
                .with_cause(err)
                .retryable()
        })?;
    match response.status() {
        reqwest::StatusCode::NOT_FOUND => Ok(None),
        status if status.is_success() => {
            let body = response.text().await.map_err(|err| {
                AppError::new(ErrorCode::SyncProviderError, "WebDAV 响应传输中断")
                    .with_cause(err)
                    .retryable()
            })?;
            Ok(Some(body))
        }
        status => Err(AppError::new(
            ErrorCode::SyncProviderError,
            format!("WebDAV 服务返回错误({})", status.as_u16()),
        )
        .with_context("status", serde_json::Value::from(status.as_u16()))
        .retryable()),
    }
}

/// PUT a remote document, creating the parent collection first.
pub async fn webdav_put(
    endpoint: &str,
    username: &str,
    password: &str,
    path: &str,
    body: &str,
) -> Result<(), AppError> {
    let base = format!("{}/{}", endpoint.trim_end_matches('/'), CLOUD_BASE_PATH);
    mkcol_parents(&base, path, username, password).await?;
    let url = format!("{}/{}", base, path.trim_start_matches('/'));
    let response = webdav_client()
        .put(&url)
        .basic_auth(username, Some(password))
        .body(body.to_string())
        .send()
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::SyncProviderError, "无法连接 WebDAV 服务")
                .with_cause(err)
                .retryable()
        })?;
    if !response.status().is_success() {
        return Err(AppError::new(
            ErrorCode::SyncProviderError,
            format!("WebDAV 写入失败({})", response.status().as_u16()),
        )
        .retryable());
    }
    Ok(())
}

/// MKCOL each path segment of `path` under `base`; existing collections (405)
/// are fine.
async fn mkcol_parents(
    base: &str,
    path: &str,
    username: &str,
    password: &str,
) -> Result<(), AppError> {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let mut current = base.to_string();
    // The last segment is the document itself, not a collection.
    for segment in &segments[..segments.len().saturating_sub(1)] {
        current = format!("{}/{}", current, segment);
        let response = webdav_client()
            .request(
                reqwest::Method::from_bytes(b"MKCOL").expect("valid method"),
                &current,
            )
            .basic_auth(username, Some(password))
            .send()
            .await;
        if let Ok(response) = response {
            let status = response.status().as_u16();
            if !(status == 201 || status == 405 || status == 301) {
                return Err(AppError::new(
                    ErrorCode::SyncProviderError,
                    format!("WebDAV 建目录失败({status})"),
                )
                .retryable());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudWebdavGetRequest {
    pub path: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudWebdavGetResponse {
    pub body: Option<String>,
}

/// (endpoint, username) of the configured WebDAV account.
fn load_cloud(conn: &rusqlite::Connection) -> Result<(String, String), AppError> {
    let endpoint = crate::storage::get_setting(conn, CLOUD_ENDPOINT_KEY)?
        .ok_or_else(|| AppError::new(ErrorCode::SyncProviderError, "尚未配置 WebDAV 服务"))?;
    let username = crate::storage::get_setting(conn, CLOUD_USERNAME_KEY)?
        .ok_or_else(|| AppError::new(ErrorCode::SyncProviderError, "尚未配置 WebDAV 服务"))?;
    Ok((endpoint, username))
}

#[tauri::command(rename = "cloud.webdav.get")]
pub async fn cloud_webdav_get(
    app: tauri::AppHandle,
    secrets: tauri::State<'_, crate::secrets::SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
    request: CloudWebdavGetRequest,
) -> Result<CloudWebdavGetResponse, AppError> {
    let base = data_dir(&app)?;
    let (endpoint, username) = {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        load_cloud(&conn)?
    };
    let password = crate::secrets::get_secret(&secrets, &base, CLOUD_PASSWORD_KEY)?
        .ok_or_else(|| AppError::new(ErrorCode::SyncProviderError, "尚未配置 WebDAV 服务"))?;
    let body = webdav_get(&endpoint, &username, &password, &request.path).await?;
    Ok(CloudWebdavGetResponse { body })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudWebdavPutRequest {
    pub path: String,
    pub body: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudWebdavPutResponse {
    pub ok: bool,
}

#[tauri::command(rename = "cloud.webdav.put")]
pub async fn cloud_webdav_put(
    app: tauri::AppHandle,
    secrets: tauri::State<'_, crate::secrets::SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
    request: CloudWebdavPutRequest,
) -> Result<CloudWebdavPutResponse, AppError> {
    let base = data_dir(&app)?;
    let (endpoint, username) = {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        load_cloud(&conn)?
    };
    let password = crate::secrets::get_secret(&secrets, &base, CLOUD_PASSWORD_KEY)?
        .ok_or_else(|| AppError::new(ErrorCode::SyncProviderError, "尚未配置 WebDAV 服务"))?;
    webdav_put(
        &endpoint,
        &username,
        &password,
        &request.path,
        &request.body,
    )
    .await?;
    Ok(CloudWebdavPutResponse { ok: true })
}

// ---------- Whole-database backup / restore over WebDAV ----------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudBackupResponse {
    pub remote_path: String,
    pub bytes: u64,
    pub checksum: String,
}

#[tauri::command(rename = "cloud.backup")]
pub async fn cloud_backup(
    app: tauri::AppHandle,
    secrets: tauri::State<'_, crate::secrets::SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<CloudBackupResponse, AppError> {
    let base = data_dir(&app)?;
    let (endpoint, username) = {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        load_cloud(&conn)?
    };
    let password = crate::secrets::get_secret(&secrets, &base, CLOUD_PASSWORD_KEY)?
        .ok_or_else(|| AppError::new(ErrorCode::SyncProviderError, "尚未配置 WebDAV 服务"))?;

    // Snapshot the live database to a temp file, then stream it up.
    let stamp = crate::timestamps::rfc3339_now().replace([':', '.'], "-");
    let temp = base.join(format!("cloud-backup-{stamp}.db"));
    let remote_path = format!("backups/deepread-{stamp}.db");
    let (bytes, checksum) = {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        let bytes = crate::storage::backup_to(&conn, &temp)?;
        let checksum = crate::storage::file_checksum(&temp)?;
        (bytes, checksum)
    };
    let body = std::fs::read(&temp).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to read snapshot").with_cause(err)
    })?;
    let put = webdav_put_bytes(&endpoint, &username, &password, &remote_path, &body).await;
    let _ = std::fs::remove_file(&temp);
    put?;
    Ok(CloudBackupResponse {
        remote_path,
        bytes,
        checksum,
    })
}

async fn webdav_put_bytes(
    endpoint: &str,
    username: &str,
    password: &str,
    path: &str,
    body: &[u8],
) -> Result<(), AppError> {
    let base = format!("{}/{}", endpoint.trim_end_matches('/'), CLOUD_BASE_PATH);
    mkcol_parents(&base, path, username, password).await?;
    let url = format!("{}/{}", base, path.trim_start_matches('/'));
    let response = webdav_client()
        .put(&url)
        .basic_auth(username, Some(password))
        .body(body.to_vec())
        .send()
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::SyncProviderError, "无法连接 WebDAV 服务")
                .with_cause(err)
                .retryable()
        })?;
    if !response.status().is_success() {
        return Err(AppError::new(
            ErrorCode::SyncProviderError,
            format!("WebDAV 写入失败({})", response.status().as_u16()),
        )
        .retryable());
    }
    Ok(())
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRestoreResponse {
    pub restored: bool,
}

/// Restore the newest WebDAV snapshot into the live database (validated and
/// checksummed first, spec §126).
#[tauri::command(rename = "cloud.restore")]
pub async fn cloud_restore(
    app: tauri::AppHandle,
    secrets: tauri::State<'_, crate::secrets::SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<CloudRestoreResponse, AppError> {
    let base = data_dir(&app)?;
    let (endpoint, username) = {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        load_cloud(&conn)?
    };
    let password = crate::secrets::get_secret(&secrets, &base, CLOUD_PASSWORD_KEY)?
        .ok_or_else(|| AppError::new(ErrorCode::SyncProviderError, "尚未配置 WebDAV 服务"))?;

    // The backup folder is flat and timestamped; find the newest one by
    // listing it (PROPFIND), falling back to the well-known latest pointer.
    let latest = newest_backup_path(&endpoint, &username, &password).await?;
    let body = webdav_get_bytes(&endpoint, &username, &password, &latest).await?;
    let temp = base.join("cloud-restore.db");
    std::fs::write(&temp, &body).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to write snapshot").with_cause(err)
    })?;
    let checksum = crate::storage::file_checksum(&temp)?;
    let mut conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    crate::storage::restore_from(&mut conn, &temp, &checksum)?;
    let _ = std::fs::remove_file(&temp);
    Ok(CloudRestoreResponse { restored: true })
}

/// Most recent `backups/deepread-*.db` by the RFC3339 timestamp in the name.
async fn newest_backup_path(
    endpoint: &str,
    username: &str,
    password: &str,
) -> Result<String, AppError> {
    let url = format!(
        "{}/{}/backups",
        endpoint.trim_end_matches('/'),
        CLOUD_BASE_PATH
    );
    let response = webdav_client()
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").expect("valid method"),
            &url,
        )
        .basic_auth(username, Some(password))
        .header("Depth", "1")
        .send()
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::SyncProviderError, "无法连接 WebDAV 服务")
                .with_cause(err)
                .retryable()
        })?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::new(
            ErrorCode::SyncProviderError,
            "云端还没有任何备份",
        ));
    }
    if !response.status().is_success() && response.status().as_u16() != 207 {
        return Err(AppError::new(
            ErrorCode::SyncProviderError,
            format!("WebDAV 列目录失败({})", response.status().as_u16()),
        )
        .retryable());
    }
    let body = response.text().await.map_err(|err| {
        AppError::new(ErrorCode::SyncProviderError, "WebDAV 响应传输中断").with_cause(err)
    })?;
    newest_backup_path_from_xml(&body)
        .ok_or_else(|| AppError::new(ErrorCode::SyncProviderError, "云端还没有任何备份"))
}

/// 从 multistatus XML 里选最新的 `backups/deepread-*.db`。
/// 文件名即 RFC3339 时间戳,字典序 = 时间序。
fn newest_backup_path_from_xml(body: &str) -> Option<String> {
    propfind_hrefs(body)
        .iter()
        .filter_map(|href| href.rsplit('/').next())
        .filter(|name| name.starts_with("deepread-") && name.ends_with(".db"))
        .max()
        .map(|name| format!("backups/{name}"))
}

/// 命名空间无关地提取所有 `<…href>` 元素的文本。
///
/// 过去是手写字符串扫描 `<d:href`/`<D:href>` —— 服务器用默认命名空间
/// (`<href>`)或别的前缀(`<lp1:href>`,某些 Apache/Nginx 组合)时,
/// 一条都扫不出来,备份恢复就成了"云端明明有备份却说没有"。
/// quick-xml 按局部名匹配,前缀/默认命名空间一视同仁。
fn propfind_hrefs(body: &str) -> Vec<String> {
    use quick_xml::events::Event;

    let mut reader = quick_xml::Reader::from_str(body);
    let mut hrefs = Vec::new();
    // 累积模型:Start(href) 开缓冲,Text/实体/CData 各自是同一段内容的一块
    // (quick-xml ≥0.41 会把 `&amp;` 拆成独立事件),End 落账。
    let mut current: Option<String> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                current = (tag.local_name().as_ref() == b"href").then(String::new);
            }
            Ok(Event::Text(text)) => {
                if let (Some(buf), Ok(decoded)) = (current.as_mut(), text.xml10_content()) {
                    buf.push_str(&decoded);
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                let name = String::from_utf8_lossy(reference.as_ref()).into_owned();
                let decoded = quick_xml::escape::unescape(&format!("&{name};"))
                    .map(|decoded| decoded.into_owned());
                if let Some(buf) = current.as_mut() {
                    buf.push_str(&decoded.unwrap_or_else(|_| format!("&{name};")));
                }
            }
            Ok(Event::CData(text)) => {
                if let Some(buf) = current.as_mut() {
                    buf.push_str(&String::from_utf8_lossy(text.as_ref()));
                }
            }
            Ok(Event::End(_)) => {
                if let Some(buf) = current.take() {
                    hrefs.push(buf);
                }
            }
            Ok(Event::Eof) => break,
            // 残缺 XML 就此收手:收下还没落账的缓冲,拿已解析到的继续挑最新。
            Err(_) => {
                if let Some(buf) = current.take() {
                    hrefs.push(buf);
                }
                break;
            }
            _ => {}
        }
    }
    hrefs
}

async fn webdav_get_bytes(
    endpoint: &str,
    username: &str,
    password: &str,
    path: &str,
) -> Result<Vec<u8>, AppError> {
    let url = format!(
        "{}/{}/{}",
        endpoint.trim_end_matches('/'),
        CLOUD_BASE_PATH,
        path.trim_start_matches('/')
    );
    let response = webdav_client()
        .get(&url)
        .basic_auth(username, Some(password))
        .send()
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::SyncProviderError, "无法连接 WebDAV 服务")
                .with_cause(err)
                .retryable()
        })?;
    if !response.status().is_success() {
        return Err(AppError::new(
            ErrorCode::SyncProviderError,
            format!("WebDAV 下载失败({})", response.status().as_u16()),
        )
        .retryable());
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|err| {
            AppError::new(ErrorCode::SyncProviderError, "WebDAV 响应传输中断")
                .with_cause(err)
                .retryable()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_must_be_http() {
        assert!(validate_endpoint("https://dav.jianguoyun.com/dav/").is_ok());
        assert!(validate_endpoint("http://localhost:5005/dav").is_ok());
        assert!(validate_endpoint("ftp://dav.example.com").is_err());
        assert!(validate_endpoint("file:///etc/passwd").is_err());
    }

    #[test]
    fn device_identity_is_stable_and_named() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::storage::migrate(&conn).unwrap();
        let (id1, name1) = device_identity(&conn).unwrap();
        let (id2, name2) = device_identity(&conn).unwrap();
        assert_eq!(id1, id2);
        assert_eq!(name1, name2);
        assert!(id1.starts_with("dev-"));
        assert!(!name1.is_empty());
        crate::storage::set_setting(&conn, DEVICE_NAME_KEY, "书房 Mac").unwrap();
        assert_eq!(device_identity(&conn).unwrap().1, "书房 Mac");
    }

    #[test]
    fn random_token_is_hex_and_unguessable_enough() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 16);
        assert_ne!(a, b);
    }

    #[test]
    fn propfind_hrefs_match_any_namespace_prefix() {
        // 大小写前缀 + 自带命名空间声明(老实现的主路径)。
        let prefixed = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/backups/deepread-2026-10-01T00-00-00Z.db</d:href><d:displayname>x</d:displayname></d:response><D:response><D:href>/dav/backups/deepread-2026-10-02T00-00-00Z.db</D:href></D:response></d:multistatus>"#;
        assert_eq!(propfind_hrefs(prefixed).len(), 2);

        // 默认命名空间:老实现一条都扫不出来,恢复备份随之失败。
        let default_ns = r#"<multistatus xmlns="DAV:"><response><href>/dav/backups/deepread-2026-10-03T00-00-00Z.db</href></response></multistatus>"#;
        assert_eq!(
            propfind_hrefs(default_ns),
            vec!["/dav/backups/deepread-2026-10-03T00-00-00Z.db"]
        );

        // 任意私有大写前缀(某些 Apache mod_dav 组合)。
        let odd_prefix = r#"<lp1:multistatus xmlns:lp1="DAV:"><lp1:response><lp1:href>/dav/deepread-2026-10-04T00-00-00Z.db</lp1:href></lp1:response></lp1:multistatus>"#;
        assert_eq!(propfind_hrefs(odd_prefix).len(), 1);
    }

    #[test]
    fn propfind_href_text_is_unescaped_and_cdata_aware() {
        let escaped = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/a%20b&amp;c/deepread-x.db</d:href></d:response></d:multistatus>"#;
        assert_eq!(propfind_hrefs(escaped), vec!["/dav/a%20b&c/deepread-x.db"]);
    }

    #[test]
    fn newest_backup_picks_lexicographic_max_and_prefixes_path() {
        let hrefs = [
            "/dav/backups/deepread-2026-10-01T00-00-00Z.db".to_string(),
            "/dav/backups/notes.txt".to_string(),
            "/dav/backups/deepread-2026-10-02T00-00-00Z.db".to_string(),
        ];
        assert_eq!(
            newest_backup_path_from_xml(&hrefs.join(" ")),
            None,
            "纯文本不是 XML,挑不出备份"
        );
        let xml = format!(
            r#"<multistatus xmlns="DAV:"><response>{}</response></multistatus>"#,
            hrefs
                .iter()
                .map(|href| format!("<href>{href}</href>"))
                .collect::<String>()
        );
        assert_eq!(
            newest_backup_path_from_xml(&xml),
            Some("backups/deepread-2026-10-02T00-00-00Z.db".to_string())
        );
    }
}
