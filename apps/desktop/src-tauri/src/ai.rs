//! AI chat streaming proxy (spec §28-31).
//!
//! The webview never sees API keys or talks to provider hosts directly: the
//! command resolves the key from the secret store server-side, streams the
//! upstream SSE bytes through a Tauri Channel, and honours cancellation.
//! Provider logic (request shaping, delta extraction) stays in
//! `@deepread/ai-core` on the frontend — Rust is a dumb, safe pipe.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::error::{AppError, ErrorCode};
use crate::secrets::SecretStore;

#[derive(Default)]
pub struct AiState {
    pub cancelled: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts_model: Option<String>,
}

fn load_providers(conn: &Connection) -> Result<Vec<AiProviderConfig>, AppError> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, base_url, model, embedding_model, tts_model FROM ai_providers ORDER BY rowid",
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to prepare provider query").with_cause(err)
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok(AiProviderConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                base_url: row.get(2)?,
                model: row.get(3)?,
                embedding_model: row.get(4)?,
                tts_model: row.get(5)?,
            })
        })
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to query providers").with_cause(err)
        })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to read provider row").with_cause(err)
    })
}

fn upsert_provider(conn: &Connection, provider: &AiProviderConfig) -> Result<(), AppError> {
    conn.execute(
        "INSERT OR REPLACE INTO ai_providers (id, name, base_url, model, embedding_model, tts_model)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            provider.id,
            provider.name,
            provider.base_url,
            provider.model,
            provider.embedding_model,
            provider.tts_model
        ],
    )
    .map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to save provider").with_cause(err)
    })?;
    Ok(())
}

pub fn provider_by_id(conn: &Connection, id: &str) -> Result<Option<AiProviderConfig>, AppError> {
    conn.query_row(
        "SELECT id, name, base_url, model, embedding_model, tts_model FROM ai_providers WHERE id = ?1",
        [id],
        |row| {
            Ok(AiProviderConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                base_url: row.get(2)?,
                model: row.get(3)?,
                embedding_model: row.get(4)?,
                tts_model: row.get(5)?,
            })
        },
    )
    .map(Some)
    .or_else(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => {
            Err(AppError::new(ErrorCode::StorageIo, "failed to read provider").with_cause(other))
        }
    })
}

fn remove_provider_row(conn: &Connection, id: &str) -> Result<bool, AppError> {
    let removed = conn
        .execute("DELETE FROM ai_providers WHERE id = ?1", [id])
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to remove provider").with_cause(err)
        })?;
    Ok(removed > 0)
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AiConfigSaveRequest {
    pub provider: AiProviderConfig,
    pub api_key: String,
}

/// 全书问答的向量服务是独立的一份配置:很多服务商(DeepSeek / Kimi / OC
/// Ferry…)只有对话接口,借对话服务的地址与密钥去打 /embeddings 必然失败,
/// 更不该为了一个向量模型去改对话模型能用的 Base URL。
///
/// 它复用 `ai_providers` 表的固定一行 + `ai.key.embedding-service`,因此不需
/// 要新的表/迁移,备份恢复也照常带走;但 `ai.config.list` 会把它从对话列表
/// 里摘出来,单独以 `embedding` 字段返回,webview 永远看不到明文密钥。
pub const EMBEDDING_PROVIDER_ID: &str = "embedding-service";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiEmbeddingConfig {
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiConfigListResponse {
    pub providers: Vec<AiProviderConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<AiEmbeddingConfig>,
}

/// 把固定槽位从对话列表里摘出来。老版本把向量模型写在对话 Provider 上,
/// 那条路径仍由 `ai.embed` 兜底,这里只处理新配置。
fn split_embedding_provider(providers: &mut Vec<AiProviderConfig>) -> Option<AiEmbeddingConfig> {
    let index = providers
        .iter()
        .position(|provider| provider.id == EMBEDDING_PROVIDER_ID)?;
    let row = providers.remove(index);
    Some(AiEmbeddingConfig {
        base_url: row.base_url,
        model: row.embedding_model.unwrap_or(row.model),
    })
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiConfigSaveResponse {
    pub provider: AiProviderConfig,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AiConfigRemoveRequest {
    pub id: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiConfigRemoveResponse {
    pub removed: bool,
}

pub fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path().app_data_dir().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "app data directory unavailable").with_cause(err)
    })
}

#[tauri::command(rename = "ai.config.list")]
pub fn ai_config_list(
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<AiConfigListResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    let mut providers = load_providers(&conn)?;
    let embedding = split_embedding_provider(&mut providers);
    Ok(AiConfigListResponse {
        providers,
        embedding,
    })
}

/// Upsert the provider config and store its API key (keychain-first).
#[tauri::command(rename = "ai.config.save")]
pub fn ai_config_save(
    app: tauri::AppHandle,
    secrets: State<'_, SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
    request: AiConfigSaveRequest,
) -> Result<AiConfigSaveResponse, AppError> {
    let base = data_dir(&app)?;
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    upsert_provider(&conn, &request.provider)?;

    // 编辑配置时页面拿不到旧密钥(ADR-0010):空 Key 表示「保留钥匙串里那份」。
    if !request.api_key.trim().is_empty() {
        let key = format!("ai.key.{}", request.provider.id);
        crate::secrets::set_secret(&secrets, &base, &key, &request.api_key)?;
    }
    Ok(AiConfigSaveResponse {
        provider: request.provider,
    })
}

#[tauri::command(rename = "ai.config.remove")]
pub fn ai_config_remove(
    app: tauri::AppHandle,
    secrets: State<'_, SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
    request: AiConfigRemoveRequest,
) -> Result<AiConfigRemoveResponse, AppError> {
    let base = data_dir(&app)?;
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    let removed = remove_provider_row(&conn, &request.id)?;
    if removed {
        let key = format!("ai.key.{}", request.id);
        crate::secrets::delete_secret(&secrets, &base, &key)?;
    }
    Ok(AiConfigRemoveResponse { removed })
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AiEmbeddingSetRequest {
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiEmbeddingSetResponse {
    pub embedding: AiEmbeddingConfig,
}

/// `ai.embedding.set` — 单独保存全书问答用的向量服务。地址与密钥都归属它
/// 自己,与当前生效的对话服务互不影响;留空 apiKey 表示保留已存密钥。
#[tauri::command(rename = "ai.embedding.set")]
pub fn ai_embedding_set(
    app: tauri::AppHandle,
    secrets: State<'_, SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
    request: AiEmbeddingSetRequest,
) -> Result<AiEmbeddingSetResponse, AppError> {
    let base_url = request.base_url.trim().to_string();
    let model = request.model.trim().to_string();
    if base_url.is_empty() || model.is_empty() {
        return Err(AppError::new(
            ErrorCode::AiProviderError,
            "向量服务需要填写 Base URL 与模型 ID",
        ));
    }
    let embedding = AiEmbeddingConfig {
        base_url: base_url.clone(),
        model: model.clone(),
    };
    let provider = AiProviderConfig {
        id: EMBEDDING_PROVIDER_ID.to_string(),
        name: "全书问答向量服务".to_string(),
        base_url,
        model: model.clone(),
        embedding_model: Some(model),
        tts_model: None,
    };
    let base = data_dir(&app)?;
    {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        upsert_provider(&conn, &provider)?;
    }
    if !request.api_key.trim().is_empty() {
        let key = format!("ai.key.{EMBEDDING_PROVIDER_ID}");
        crate::secrets::set_secret(&secrets, &base, &key, request.api_key.trim())?;
    }
    Ok(AiEmbeddingSetResponse { embedding })
}

/// `ai.embedding.remove` — 关掉全书问答的向量服务。旧数据里写在对话
/// Provider 上的 embeddingModel 仍能被 `ai.embed` 读到。
#[tauri::command(rename = "ai.embedding.remove")]
pub fn ai_embedding_remove(
    app: tauri::AppHandle,
    secrets: State<'_, SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<AiConfigRemoveResponse, AppError> {
    let base = data_dir(&app)?;
    let removed = {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        remove_provider_row(&conn, EMBEDDING_PROVIDER_ID)?
    };
    if removed {
        let key = format!("ai.key.{EMBEDDING_PROVIDER_ID}");
        crate::secrets::delete_secret(&secrets, &base, &key)?;
    }
    Ok(AiConfigRemoveResponse { removed })
}

/// What a running OC Ferry bridge offers. The bearer key is deliberately absent:
/// ADR-0010 keeps plaintext secrets out of the webview, so `ai.ocFerry.use`
/// reads it again on the Rust side instead.
#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OcFerryDiscovery {
    pub base_url: String,
    pub models: Vec<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AiConfigUseOcFerryRequest {
    pub model: String,
}

/// One fixed slot for the bridge: re-detecting or switching models updates this
/// row instead of piling up near-identical providers.
const OC_FERRY_PROVIDER_ID: &str = "oc-ferry-local";

fn oc_ferry_base_url() -> String {
    let port = std::env::var("FERRY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(41980);
    format!("http://127.0.0.1:{port}/v1")
}

/// OC Ferry's per-user data directory: macOS `~/Library/Application Support/OC
/// Ferry`, Windows `%APPDATA%\OC Ferry`, Linux `$XDG_CONFIG_HOME/OC Ferry`.
/// `FERRY_DATA_DIR` overrides all three, as it does for OC Ferry itself.
fn oc_ferry_data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("FERRY_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join("Library/Application Support/OC Ferry"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join("OC Ferry"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|home| PathBuf::from(home).join(".config").into_os_string())
            })
            .map(|base| PathBuf::from(base).join("OC Ferry"))
    }
}

fn read_oc_ferry_key() -> Result<String, AppError> {
    let data_dir = oc_ferry_data_dir().ok_or_else(|| {
        AppError::new(
            ErrorCode::AiProviderError,
            "找不到 OC Ferry 的数据目录，请确认它已安装",
        )
    })?;
    let key = std::fs::read_to_string(data_dir.join("api-key"))
        .map_err(|_| {
            AppError::new(
                ErrorCode::AiProviderError,
                "找不到 OC Ferry 的 api-key，请确认它已启动过一次",
            )
        })?
        .trim()
        .to_string();
    if key.is_empty() {
        return Err(AppError::new(
            ErrorCode::AiProviderError,
            "OC Ferry 的 api-key 为空，请确认它已启动过一次",
        ));
    }
    Ok(key)
}

/// Model ids go to `/chat/completions` verbatim, so an overlong one cannot be
/// saved (the provider wire type caps it at 128) — skip it instead of truncating.
fn parse_oc_ferry_models(body: &Value) -> Vec<String> {
    body.get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .map(str::trim)
                .filter(|id| !id.is_empty() && id.chars().count() <= 128)
                .take(100) // matches ocFerryDiscoverySchema's upper bound
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn validate_oc_ferry_model(model: &str) -> Result<&str, AppError> {
    let trimmed = model.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 128 {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "OC Ferry 模型名不合法",
        ));
    }
    Ok(trimmed)
}

/// OC Ferry refuses requests carrying an `Origin` header, so probing it from the
/// webview would always fail — this runs in Rust, with the key added here too.
async fn fetch_oc_ferry_models(base_url: &str, api_key: &str) -> Result<Vec<String>, AppError> {
    let response = crate::http()
        .get(format!("{base_url}/models"))
        .bearer_auth(api_key)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|err| {
            AppError::new(
                ErrorCode::AiProviderError,
                format!("连不上本机 OC Ferry（{base_url}）：{err}。请确认托盘程序正在运行"),
            )
        })?;
    if !response.status().is_success() {
        return Err(AppError::new(
            ErrorCode::AiProviderError,
            format!(
                "OC Ferry 返回 {}，请确认它已启动且未被占用",
                response.status()
            ),
        ));
    }
    let body: Value = response.json().await.map_err(|err| {
        AppError::new(
            ErrorCode::AiProviderError,
            format!("OC Ferry 的响应无法解析：{err}"),
        )
    })?;
    let models = parse_oc_ferry_models(&body);
    if models.is_empty() {
        return Err(AppError::new(
            ErrorCode::AiProviderError,
            "OC Ferry 已连上，但暂未判定出可用模型（可能还在检测，或免费池为空）",
        ));
    }
    Ok(models)
}

/// `ai.ocFerry.detect` — list the free models a running OC Ferry has vetted.
#[tauri::command(rename = "ai.ocFerry.detect")]
pub async fn ai_oc_ferry_detect() -> Result<OcFerryDiscovery, AppError> {
    let base_url = oc_ferry_base_url();
    let models = fetch_oc_ferry_models(&base_url, &read_oc_ferry_key()?).await?;
    Ok(OcFerryDiscovery { base_url, models })
}

/// `ai.ocFerry.use` — adopt one of those models as the active provider.
///
/// The key never leaves Rust: it is read from OC Ferry's data dir and written
/// into the secret store under the fixed provider id, exactly as `ai.config.save`
/// would. `ai.chat` later resolves it by that id.
#[tauri::command(rename = "ai.ocFerry.use")]
pub fn ai_oc_ferry_use(
    app: tauri::AppHandle,
    secrets: State<'_, SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
    request: AiConfigUseOcFerryRequest,
) -> Result<AiConfigSaveResponse, AppError> {
    let model = validate_oc_ferry_model(&request.model)?;
    let api_key = read_oc_ferry_key()?;
    let provider = AiProviderConfig {
        id: OC_FERRY_PROVIDER_ID.to_string(),
        name: "OC Ferry(本机)".to_string(),
        base_url: oc_ferry_base_url(),
        model: model.to_string(),
        embedding_model: None,
        tts_model: None,
    };
    let base = data_dir(&app)?;
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    upsert_provider(&conn, &provider)?;
    let key = format!("ai.key.{}", provider.id);
    crate::secrets::set_secret(&secrets, &base, &key, &api_key)?;
    Ok(AiConfigSaveResponse { provider })
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AiChatRequest {
    pub task_id: String,
    pub config_id: String,
    #[ts(type = "Array<{ role: 'system' | 'user' | 'assistant'; content: string }>")]
    pub messages: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiChatResponse {
    pub task_id: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AiCancelRequest {
    pub task_id: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiCancelResponse {
    pub cancelled: bool,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AiEmbedRequest {
    #[allow(dead_code)] // protocol field; the embed call is not cancellable in-flight
    pub task_id: String,
    pub config_id: String,
    pub texts: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiEmbedResponse {
    pub vectors: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiIndexChunk {
    pub label: String,
    pub text: String,
    pub vector: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiIndexPayload {
    pub chunks: Vec<AiIndexChunk>,
    pub embedding_model: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AiIndexGetRequest {
    pub book_hash: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiIndexGetResponse {
    pub index: Option<AiIndexPayload>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AiIndexSetRequest {
    pub book_hash: String,
    pub index: AiIndexPayload,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiIndexSetResponse {
    pub saved_at: String,
}

pub const MAX_INDEX_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_ARTIFACT_BYTES: usize = 4 * 1024 * 1024;

/// Validate the artifact kind against the protocol enum.
pub fn validate_artifact_kind(kind: &str) -> Result<(), AppError> {
    match kind {
        "summary" | "outline" | "notes" | "characters" | "timeline" | "concepts" | "chat" => Ok(()),
        other => Err(
            AppError::new(ErrorCode::SystemValidation, "未知的 artifact 类型")
                .with_context("kind", Value::String(other.to_string())),
        ),
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredArtifact {
    pub payload: Value,
    pub created_at: String,
}

pub fn load_artifact(
    conn: &Connection,
    hash: &str,
    kind: &str,
) -> Result<Option<StoredArtifact>, AppError> {
    crate::state::validate_hash(hash)?;
    validate_artifact_kind(kind)?;
    let result: Result<(String, String), rusqlite::Error> = conn.query_row(
        "SELECT payload, created_at FROM ai_artifacts WHERE book_hash = ?1 AND kind = ?2",
        rusqlite::params![hash, kind],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    match result {
        Ok((payload_text, created_at)) => {
            let payload: Value = serde_json::from_str(&payload_text).map_err(|err| {
                AppError::new(ErrorCode::StorageCorrupt, "artifact is corrupted").with_cause(err)
            })?;
            Ok(Some(StoredArtifact {
                payload,
                created_at,
            }))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(other) => {
            Err(AppError::new(ErrorCode::StorageIo, "failed to read artifact").with_cause(other))
        }
    }
}

pub fn store_artifact(
    conn: &Connection,
    hash: &str,
    kind: &str,
    payload: &Value,
    created_at: &str,
) -> Result<(), AppError> {
    crate::state::validate_hash(hash)?;
    validate_artifact_kind(kind)?;
    if payload.to_string().len() > MAX_ARTIFACT_BYTES {
        return Err(AppError::new(
            ErrorCode::StorageCorrupt,
            "artifact is too large",
        ));
    }
    conn.execute(
        "INSERT OR REPLACE INTO ai_artifacts (book_hash, kind, payload, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![hash, kind, payload.to_string(), created_at],
    )
    .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to save artifact").with_cause(err))?;
    Ok(())
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AiArtifactGetRequest {
    pub book_hash: String,
    pub kind: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiArtifactGetResponse {
    #[ts(type = "Record<string, unknown> | null")]
    pub payload: Option<Value>,
    pub created_at: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AiArtifactSetRequest {
    pub book_hash: String,
    pub kind: String,
    #[ts(type = "Record<string, unknown>")]
    pub payload: Value,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiArtifactSetResponse {
    pub saved_at: String,
}

#[tauri::command(rename = "ai.artifact.get")]
pub fn ai_artifact_get(
    db: tauri::State<'_, crate::storage::Db>,
    request: AiArtifactGetRequest,
) -> Result<AiArtifactGetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(
        match load_artifact(&conn, &request.book_hash, &request.kind)? {
            Some(stored) => AiArtifactGetResponse {
                payload: Some(stored.payload),
                created_at: Some(stored.created_at),
            },
            None => AiArtifactGetResponse {
                payload: None,
                created_at: None,
            },
        },
    )
}

#[tauri::command(rename = "ai.artifact.set")]
pub fn ai_artifact_set(
    db: tauri::State<'_, crate::storage::Db>,
    request: AiArtifactSetRequest,
) -> Result<AiArtifactSetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    store_artifact(
        &conn,
        &request.book_hash,
        &request.kind,
        &request.payload,
        &crate::timestamps::rfc3339_now(),
    )?;
    Ok(AiArtifactSetResponse {
        saved_at: crate::timestamps::rfc3339_now(),
    })
}

pub fn load_index(conn: &Connection, hash: &str) -> Result<Option<AiIndexPayload>, AppError> {
    crate::state::validate_hash(hash)?;
    let result: Result<(String, String, String), rusqlite::Error> = conn.query_row(
        "SELECT chunks, embedding_model, created_at FROM ai_index WHERE book_hash = ?1",
        [hash],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    );
    match result {
        Ok((chunks_text, embedding_model, created_at)) => {
            let chunks: Vec<AiIndexChunk> = serde_json::from_str(&chunks_text).map_err(|err| {
                AppError::new(ErrorCode::StorageCorrupt, "ai index is corrupted").with_cause(err)
            })?;
            Ok(Some(AiIndexPayload {
                chunks,
                embedding_model,
                created_at,
            }))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(other) => {
            Err(AppError::new(ErrorCode::StorageIo, "failed to read ai index").with_cause(other))
        }
    }
}

pub fn store_index(conn: &Connection, hash: &str, index: &AiIndexPayload) -> Result<(), AppError> {
    crate::state::validate_hash(hash)?;
    let chunks = serde_json::to_string(&index.chunks).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to serialize chunks").with_cause(err)
    })?;
    if chunks.len() > MAX_INDEX_BYTES {
        return Err(AppError::new(
            ErrorCode::StorageCorrupt,
            "ai index is too large",
        ));
    }
    let tx = conn.unchecked_transaction().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to begin transaction").with_cause(err)
    })?;
    tx.execute(
        "INSERT OR REPLACE INTO ai_index (book_hash, chunks, embedding_model, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![hash, chunks, index.embedding_model, index.created_at],
    )
    .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to save ai index").with_cause(err))?;
    // 正文搜索行表(book_chunks)随索引重建:先清旧片再写入,两表永远一致。
    tx.execute("DELETE FROM book_chunks WHERE book_hash = ?1", [hash])
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to reset book chunks").with_cause(err)
        })?;
    for chunk in &index.chunks {
        tx.execute(
            "INSERT INTO book_chunks (book_hash, label, text) VALUES (?1, ?2, ?3)",
            rusqlite::params![hash, chunk.label, chunk.text],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to save book chunk").with_cause(err)
        })?;
    }
    tx.commit().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to commit ai index").with_cause(err)
    })
}

/// POST /embeddings through the provider and return the vectors.
pub async fn embed_texts(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    model: &str,
    texts: &[String],
) -> Result<Vec<Vec<f64>>, AppError> {
    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(&json!({ "model": model, "input": texts }))
        .send()
        .await
        .map_err(|err| {
            AppError::new(
                ErrorCode::AiProviderError,
                "连不上向量服务。请确认该地址能直连(海外端点常被网络拦下),或换一家可直连的服务",
            )
            .with_cause(err)
            .retryable()
        })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::new(
            ErrorCode::AiProviderError,
            format!(
                "向量服务返回 HTTP {status}:{}。请确认 Base URL 提供 /embeddings、模型 ID 与 API Key 属于同一家服务",
                brief_value(&text, 200)
            ),
        ));
    }
    let payload: Value = response.json().await.map_err(|err| {
        AppError::new(
            ErrorCode::AiProviderError,
            "向量服务返回的不是合法 JSON(可能是代理/网关返回了错误页)",
        )
        .with_cause(err)
    })?;
    parse_embedding_payload(&payload, texts.len())
}

fn brief_value(text: &str, limit: usize) -> String {
    text.chars()
        .take(limit)
        .collect::<String>()
        .replace('\n', " ")
}

/// 各家「OpenAI 兼容」的 embeddings 响应并不统一:有的不带 `index`,有的把
/// 向量放在 `embedding.values` / `values` / `vector` 里,还有的用顶层
/// `embeddings[]`。解析器要吃下这些变体;真解析不出来时**把上游原始结构附在
/// 错误里**,而不是只丢一句「数量不符」让用户猜。
fn parse_embedding_payload(payload: &Value, expected: usize) -> Result<Vec<Vec<f64>>, AppError> {
    if let Some(error) = payload.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
            .unwrap_or("上游返回错误对象");
        return Err(AppError::new(
            ErrorCode::AiProviderError,
            format!("向量服务返回错误:{message}"),
        ));
    }
    let items: Vec<&Value> = payload
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| payload.get("embeddings").and_then(Value::as_array))
        .map(|array| array.iter().collect())
        .unwrap_or_default();
    let mut vectors: Vec<(usize, Vec<f64>)> = items
        .iter()
        .enumerate()
        .filter_map(|(position, item)| {
            // index 缺失时按数组位置兜底:不少兼容层根本不发这个字段。
            let index = item
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(position as u64) as usize;
            let vector = parse_embedding_vector(item)?;
            Some((index, vector))
        })
        .collect();
    vectors.sort_by_key(|(index, _)| *index);
    let result: Vec<Vec<f64>> = vectors.into_iter().map(|(_, vector)| vector).collect();
    if result.len() != expected {
        return Err(AppError::new(
            ErrorCode::AiProviderError,
            format!(
                "向量服务没有返回有效向量(期望 {expected} 条,实际 {} 条)。请在 设置 → AI 服务 → 全书问答 里确认地址提供 /embeddings、模型 ID 与密钥属于同一家;上游响应:{}",
                result.len(),
                brief_value(&payload.to_string(), 240)
            ),
        ));
    }
    Ok(result)
}

fn parse_embedding_vector(item: &Value) -> Option<Vec<f64>> {
    let raw = item
        .get("embedding")
        .or_else(|| item.get("vector"))
        .or_else(|| item.get("values"))?;
    let array = raw
        .as_array()
        .or_else(|| raw.get("values").and_then(Value::as_array))?;
    let vector: Vec<f64> = array
        .iter()
        .map(|value| value.as_f64().unwrap_or(0.0))
        .collect();
    (!vector.is_empty()).then_some(vector)
}

/// Pure helper: the upstream chat-completions URL for a configured base URL.
pub fn chat_endpoint(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// 与前端 `createSseParser`(ai-core/sse.ts)同一套容错:事件分隔 `\r?\n\r?\n`,
/// `data:` 后带不带空格都认,多行 data 以 \n 拼接。部分供应商发 `data:{...}`
/// (无空格)或 CRLF 行尾 —— 旧实现只认 `data: ` 加 `\n\n`,这类帧整段丢弃。
fn extract_sse_data(event: &str) -> Option<String> {
    let payloads: Vec<&str> = event
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .collect();
    if payloads.is_empty() {
        return None;
    }
    Some(
        payloads
            .iter()
            .map(|payload| payload.trim_start())
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// 找最早的事件分隔 `\r?\n\r?\n`,返回 (起点, 分隔符字节数)。
/// 起点与长度都落在 ASCII 字节上,UTF-8 切片安全。
fn find_event_boundary(buffer: &str) -> Option<(usize, usize)> {
    let bytes = buffer.as_bytes();
    for start in 0..bytes.len() {
        let mut cursor = start;
        if bytes[cursor] == b'\r' {
            cursor += 1;
            if cursor >= bytes.len() || bytes[cursor] != b'\n' {
                continue;
            }
        } else if bytes[cursor] != b'\n' {
            continue;
        }
        cursor += 1; // 吃掉第一个 \n
        if cursor < bytes.len() && bytes[cursor] == b'\r' {
            cursor += 1;
        }
        if cursor < bytes.len() && bytes[cursor] == b'\n' {
            return Some((start, cursor + 1 - start));
        }
    }
    None
}

/// Bridges such as OC Ferry report mid-stream failures as `data: {"error":…}`
/// under HTTP 200. Left alone, the webview sees an empty answer and blames its
/// own JSON parser instead of the upstream failure.
fn sse_error_message(data: &str) -> Option<String> {
    let payload: Value = serde_json::from_str(data).ok()?;
    if payload.get("choices").is_some() {
        return None;
    }
    let error = payload.get("error")?;
    error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .map(str::to_string)
}

fn forward_sse_data(
    data: String,
    on_chunk: &(dyn Fn(String) + Send + Sync),
) -> Result<(), AppError> {
    if let Some(message) = sse_error_message(&data) {
        return Err(AppError::new(
            ErrorCode::AiProviderError,
            format!("AI 服务返回错误：{message}"),
        )
        .retryable());
    }
    on_chunk(data);
    Ok(())
}

/// Stream one chat completion, forwarding raw SSE bytes through the channel.
/// Public so the integration test can drive it against a local mock server
/// without a Tauri runtime.
pub async fn stream_chat(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: Value,
    cancelled: Arc<AtomicBool>,
    on_chunk: &(dyn Fn(String) + Send + Sync),
) -> Result<(), AppError> {
    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::AiProviderError, "无法连接 AI 服务")
                .with_cause(err)
                .retryable()
        })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::new(
            ErrorCode::AiProviderError,
            format!("AI 服务返回错误({status})"),
        )
        .with_context("body", Value::String(text.chars().take(400).collect()))
        .retryable());
    }

    let stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut stream = std::pin::pin!(stream);
    loop {
        if cancelled.load(Ordering::Relaxed) {
            on_chunk("[\"__CANCELLED__\"]".to_string());
            return Ok(());
        }
        match StreamExt::next(&mut stream).await {
            Some(Ok(bytes)) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                while let Some((start, len)) = find_event_boundary(&buffer) {
                    let event = buffer[..start].to_string();
                    buffer.drain(..start + len);
                    if let Some(data) = extract_sse_data(&event) {
                        forward_sse_data(data, on_chunk)?;
                    }
                }
            }
            Some(Err(err)) => {
                return Err(AppError::new(ErrorCode::AiProviderError, "AI 流式传输中断")
                    .with_cause(err)
                    .retryable());
            }
            None => break,
        }
    }
    // 流结束冲刷残留缓冲:有的服务器最后一个事件不带分隔符就关流
    // (与前端 createSseParser#end 同语义)。
    if let Some(data) = extract_sse_data(&buffer) {
        forward_sse_data(data, on_chunk)?;
    }
    Ok(())
}

fn emit_event(channel: &Channel<Value>, kind: &str, data: Value) {
    let _ = channel.send(json!({ "type": kind, "data": data }));
}

#[tauri::command(rename = "ai.chat")]
pub async fn ai_chat(
    app: tauri::AppHandle,
    state: State<'_, AiState>,
    secrets: State<'_, SecretStore>,
    db: State<'_, crate::storage::Db>,
    request: AiChatRequest,
    on_event: Channel<Value>,
) -> Result<AiChatResponse, AppError> {
    let base = data_dir(&app)?;
    let config = {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        provider_by_id(&conn, &request.config_id)?
            .ok_or_else(|| AppError::new(ErrorCode::AiProviderError, "AI 服务配置不存在"))?
    };
    let key = format!("ai.key.{}", request.config_id);
    let api_key = crate::secrets::get_secret(&secrets, &base, &key)?
        .ok_or_else(|| AppError::new(ErrorCode::AiProviderError, "请先填写该服务的 API Key"))?;

    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .cancelled
        .lock()
        .await
        .insert(request.task_id.clone(), cancelled.clone());

    let mut body = json!({
        "model": config.model,
        "messages": request.messages,
        "stream": true,
    });
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    let url = chat_endpoint(&config.base_url);
    let client = crate::http();
    let task_id = request.task_id.clone();
    let channel = on_event.clone();
    let cleanup_id = task_id.clone();

    tauri::async_runtime::spawn(async move {
        let on_chunk = |chunk: String| {
            if chunk == "[\"__CANCELLED__\"]" {
                emit_event(&channel, "cancelled", json!(null));
            } else {
                emit_event(&channel, "chunk", json!(chunk));
            }
        };
        let result = stream_chat(client, &url, &api_key, body, cancelled, &on_chunk).await;
        // 任务结算即除名:这张表原本只在 ai.cancel 时移除,正常完成/出错的
        // 任务会永远占着一条(每轮对话泄漏一条,活得跟应用一样长)。取消后
        // 迟到的 ai.cancel 会如实回答 cancelled:false。
        app.state::<AiState>()
            .cancelled
            .lock()
            .await
            .remove(&cleanup_id);
        match result {
            Ok(()) => emit_event(&channel, "done", json!(null)),
            Err(err) => emit_event(
                &channel,
                "error",
                json!({"code": err.code.as_str(), "message": err.message, "retryable": err.retryable}),
            ),
        }
    });

    Ok(AiChatResponse { task_id })
}

#[tauri::command(rename = "ai.embed")]
pub async fn ai_embed(
    app: tauri::AppHandle,
    secrets: State<'_, SecretStore>,
    db: State<'_, crate::storage::Db>,
    request: AiEmbedRequest,
) -> Result<AiEmbedResponse, AppError> {
    let base = data_dir(&app)?;
    // 独立向量服务优先;没配过时回落老数据(embeddingModel 写在对话 Provider 上)。
    // 两条路径各自解析自己的地址与密钥,绝不拿对话服务的 Key 打别家的接口。
    let (url, model, secret_key) = {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        if let Some(row) = provider_by_id(&conn, EMBEDDING_PROVIDER_ID)? {
            let model = row.embedding_model.unwrap_or(row.model);
            (
                format!("{}/embeddings", row.base_url.trim_end_matches('/')),
                model,
                format!("ai.key.{EMBEDDING_PROVIDER_ID}"),
            )
        } else {
            let config = provider_by_id(&conn, &request.config_id)?
                .ok_or_else(|| AppError::new(ErrorCode::AiProviderError, "AI 服务配置不存在"))?;
            // 拿 chat 模型打 /embeddings 必失败,而报错来自远端,用户看不出
            // 根因是「没填模型」。这里提前拦下,把话说清楚。
            let model = config.embedding_model.clone().ok_or_else(|| {
                AppError::new(
                    ErrorCode::AiProviderError,
                    "未配置向量服务,请在设置 → AI 服务 → 全书问答里添加",
                )
            })?;
            (
                format!("{}/embeddings", config.base_url.trim_end_matches('/')),
                model,
                format!("ai.key.{}", request.config_id),
            )
        }
    };
    let api_key = crate::secrets::get_secret(&secrets, &base, &secret_key)?
        .ok_or_else(|| AppError::new(ErrorCode::AiProviderError, "请先填写该服务的 API Key"))?;
    let vectors = embed_texts(crate::http(), &url, &api_key, &model, &request.texts).await?;
    Ok(AiEmbedResponse { vectors })
}

#[tauri::command(rename = "ai.index.get")]
pub fn ai_index_get(
    db: tauri::State<'_, crate::storage::Db>,
    request: AiIndexGetRequest,
) -> Result<AiIndexGetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(AiIndexGetResponse {
        index: load_index(&conn, &request.book_hash)?,
    })
}

#[tauri::command(rename = "ai.index.set")]
pub fn ai_index_set(
    db: tauri::State<'_, crate::storage::Db>,
    request: AiIndexSetRequest,
) -> Result<AiIndexSetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    store_index(&conn, &request.book_hash, &request.index)?;
    Ok(AiIndexSetResponse {
        saved_at: crate::timestamps::rfc3339_now(),
    })
}

#[tauri::command(rename = "ai.cancel")]
pub async fn ai_cancel(
    state: State<'_, AiState>,
    request: AiCancelRequest,
) -> Result<AiCancelResponse, AppError> {
    let flag = state.cancelled.lock().await.remove(&request.task_id);
    if let Some(flag) = &flag {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(AiCancelResponse {
        cancelled: flag.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, base_url: &str) -> AiProviderConfig {
        AiProviderConfig {
            id: id.to_string(),
            name: id.to_string(),
            base_url: base_url.to_string(),
            model: "chat-model".to_string(),
            embedding_model: None,
            tts_model: None,
        }
    }

    #[test]
    fn embedding_service_is_kept_out_of_chat_providers() {
        let mut rows = vec![
            provider("cfg-chat", "https://api.deepseek.com/v1"),
            AiProviderConfig {
                embedding_model: Some("BAAI/bge-m3".to_string()),
                ..provider(EMBEDDING_PROVIDER_ID, "https://api.siliconflow.cn/v1")
            },
            provider("cfg-second", "https://api.moonshot.cn/v1"),
        ];
        let embedding = split_embedding_provider(&mut rows).expect("embedding slot");
        assert_eq!(embedding.base_url, "https://api.siliconflow.cn/v1");
        assert_eq!(embedding.model, "BAAI/bge-m3");
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row.id != EMBEDDING_PROVIDER_ID));
    }

    #[test]
    fn legacy_embedding_rows_fall_back_to_the_chat_model() {
        let mut rows = vec![provider(EMBEDDING_PROVIDER_ID, "http://localhost:11434/v1")];
        assert_eq!(
            split_embedding_provider(&mut rows).map(|item| item.model),
            Some("chat-model".to_string())
        );
        assert!(split_embedding_provider(&mut rows).is_none());
    }

    #[test]
    fn embedding_payloads_accept_common_openai_compatible_shapes() {
        let standard = json!({
            "data": [
                { "index": 1, "embedding": [0.2, 0.4] },
                { "index": 0, "embedding": [0.1, 0.3] }
            ]
        });
        assert_eq!(
            parse_embedding_payload(&standard, 2).expect("standard"),
            vec![vec![0.1, 0.3], vec![0.2, 0.4]]
        );
        // 很多兼容层不发 index,旧解析器会把整批静默丢光(截图里「期望 1,实际 0」)。
        let no_index = json!({ "data": [{ "embedding": [1.0, 2.0] }] });
        assert_eq!(
            parse_embedding_payload(&no_index, 1).expect("missing index"),
            vec![vec![1.0, 2.0]]
        );
        // Gemini 原生 / 部分网关把向量塞在 values 里。
        let nested = json!({ "embeddings": [{ "values": [3.0, 4.0] }] });
        assert_eq!(
            parse_embedding_payload(&nested, 1).expect("values"),
            vec![vec![3.0, 4.0]]
        );
        let object_embedding = json!({ "data": [{ "embedding": { "values": [5.0] } }] });
        assert_eq!(
            parse_embedding_payload(&object_embedding, 1).expect("embedding.values"),
            vec![vec![5.0]]
        );
    }

    #[test]
    fn embedding_errors_carry_the_upstream_reason() {
        let upstream_error = json!({ "error": { "message": "API key not valid" } });
        let message = parse_embedding_payload(&upstream_error, 1)
            .expect_err("upstream error")
            .message;
        assert!(message.contains("API key not valid"), "{message}");

        let empty = json!({ "object": "list", "data": [] });
        let message = parse_embedding_payload(&empty, 1)
            .expect_err("empty data")
            .message;
        assert!(message.contains("没有返回有效向量"), "{message}");
        assert!(message.contains("全书问答"), "{message}");
        assert!(message.contains("\"data\":[]"), "{message}");
    }

    #[test]
    fn sse_error_frames_become_upstream_errors() {
        assert_eq!(
            sse_error_message(
                r#"{"error":{"message":"Model request timed out","code":"timeout"}}"#
            ),
            Some("Model request timed out".to_string())
        );
        assert_eq!(
            sse_error_message(r#"{"error":"bad envelope"}"#),
            Some("bad envelope".to_string())
        );
        assert_eq!(
            sse_error_message(r#"{"choices":[{"delta":{"content":"ok"}}]}"#),
            None
        );
        assert_eq!(sse_error_message("[DONE]"), None);
    }

    #[test]
    fn oc_ferry_models_are_kept_verbatim_and_filtered() {
        let body = json!({
            "object": "list",
            "data": [
                { "id": "OC · GLM-4.6" },
                { "id": "  " },
                { "name": "no id" },
                { "id": "x".repeat(129) }
            ]
        });
        assert_eq!(
            parse_oc_ferry_models(&body),
            vec!["OC · GLM-4.6".to_string()]
        );
        assert!(parse_oc_ferry_models(&json!({})).is_empty());
    }

    #[test]
    fn oc_ferry_model_is_trimmed_and_bounded() {
        assert_eq!(
            validate_oc_ferry_model("  OC · GLM-4.6  ").unwrap(),
            "OC · GLM-4.6"
        );
        assert!(validate_oc_ferry_model("  ").is_err());
        assert!(validate_oc_ferry_model(&"x".repeat(129)).is_err());
    }

    #[test]
    fn chat_endpoint_appends_path() {
        assert_eq!(
            chat_endpoint("https://api.example.com/v1"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            chat_endpoint("https://api.example.com/v1/"),
            "https://api.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn sse_data_tolerates_missing_space_and_crlf() {
        assert_eq!(
            extract_sse_data("data: {\"a\":1}"),
            Some("{\"a\":1}".to_string())
        );
        // 无空格帧:部分供应商的写法,旧实现会整段丢弃。
        assert_eq!(
            extract_sse_data("data:{\"a\":1}"),
            Some("{\"a\":1}".to_string())
        );
        assert_eq!(extract_sse_data(": keep-alive"), None);
        assert_eq!(extract_sse_data(""), None);
        // 多行 data 以 \n 拼接(SSE 规范)。
        assert_eq!(
            extract_sse_data("data: {\"a\":\ndata: 1}"),
            Some("{\"a\":\n1}".to_string())
        );
    }

    #[test]
    fn event_boundary_matches_lf_and_crlf() {
        assert_eq!(find_event_boundary("data: x\n\n"), Some((7, 2)));
        assert_eq!(find_event_boundary("data: x\r\n\r\n"), Some((7, 4)));
        assert_eq!(find_event_boundary("data: x\n\r\n"), Some((7, 3)));
        assert_eq!(find_event_boundary("data: x\r\n\n"), Some((7, 3)));
        assert_eq!(find_event_boundary("data: x"), None);
        assert_eq!(find_event_boundary(""), None);
        // 中文等多字节字符不出现在分隔符匹配里,切片保持 UTF-8 边界安全。
        assert_eq!(
            find_event_boundary("data: 夜航\n\ndata: 灯塔\n\n"),
            Some((12, 2))
        );
    }

    fn memory_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::storage::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn index_store_round_trips() {
        let conn = memory_db();
        let hash = "23821135d4c62f1428fd15ddb9e91d695402727f43b13a6eb3e9f31fc01b4072";
        let index = AiIndexPayload {
            chunks: vec![AiIndexChunk {
                label: "第一章".into(),
                text: "镇上的人把灯点亮。".into(),
                vector: vec![0.1, 0.9],
            }],
            embedding_model: "mock-embedding".into(),
            created_at: "2026-09-13T00:00:00Z".into(),
        };
        store_index(&conn, hash, &index).unwrap();
        let reloaded = load_index(&conn, hash).unwrap();
        assert_eq!(reloaded.as_ref(), Some(&index));
        assert!(store_index(&conn, "../evil", &index).is_err());
    }

    #[test]
    fn artifact_store_round_trips_and_rejects_bad_kinds() {
        let conn = memory_db();
        let hash = "23821135d4c62f1428fd15ddb9e91d695402727f43b13a6eb3e9f31fc01b4072";
        let artifact = StoredArtifact {
            payload: json!({"overview": "雪季的故事", "themes": ["灯"]}),
            created_at: "2026-09-13T00:00:00Z".into(),
        };
        store_artifact(
            &conn,
            hash,
            "summary",
            &artifact.payload,
            &artifact.created_at,
        )
        .unwrap();
        assert_eq!(
            load_artifact(&conn, hash, "summary").unwrap(),
            Some(artifact)
        );
        assert_eq!(load_artifact(&conn, hash, "notes").unwrap(), None);
        store_artifact(&conn, hash, "chat", &json!({"messages": []}), "t").unwrap();
        assert!(store_artifact(&conn, hash, "evil", &json!({}), "t").is_err());
        assert!(load_artifact(&conn, "../../evil", "summary").is_err());
        // B7 graph kinds round-trip through the same validation.
        store_artifact(&conn, hash, "timeline", &json!({"events": []}), "t").unwrap();
        assert_eq!(
            load_artifact(&conn, hash, "timeline").unwrap(),
            Some(StoredArtifact {
                payload: json!({"events": []}),
                created_at: "t".into(),
            })
        );
        store_artifact(&conn, hash, "concepts", &json!({"concepts": []}), "t").unwrap();
        assert!(load_artifact(&conn, hash, "concepts").unwrap().is_some());
    }

    #[test]
    fn store_index_dual_writes_search_rows() {
        let conn = memory_db();
        let hash = "23821135d4c62f1428fd15ddb9e91d695402727f43b13a6eb3e9f31fc01b4072";
        let index = AiIndexPayload {
            chunks: vec![
                AiIndexChunk {
                    label: "第一章".into(),
                    text: "镇上把灯点亮。".into(),
                    vector: vec![0.1],
                },
                AiIndexChunk {
                    label: "第二章".into(),
                    text: "雪落下来。".into(),
                    vector: vec![0.2],
                },
            ],
            embedding_model: "mock-embedding".into(),
            created_at: "2026-09-13T00:00:00Z".into(),
        };
        store_index(&conn, hash, &index).unwrap();
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM book_chunks WHERE book_hash = ?1",
                [hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 2, "索引的每个 chunk 都要落一行搜索行表");

        // 重写同一本:旧片清空重建,不残留。
        let rebuilt = AiIndexPayload {
            chunks: vec![],
            ..index.clone()
        };
        store_index(&conn, hash, &rebuilt).unwrap();
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM book_chunks WHERE book_hash = ?1",
                [hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn config_store_round_trips() {
        let conn = memory_db();
        let provider = AiProviderConfig {
            id: "0123456789abcdef".into(),
            name: "DeepSeek".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            model: "deepseek-v4-pro".into(),
            embedding_model: None,
            tts_model: None,
        };
        assert!(load_providers(&conn).unwrap().is_empty());
        upsert_provider(&conn, &provider).unwrap();
        // re-upsert is a no-op duplicate
        upsert_provider(&conn, &provider).unwrap();
        assert_eq!(load_providers(&conn).unwrap(), vec![provider.clone()]);
        assert!(remove_provider_row(&conn, &provider.id).unwrap());
        assert!(load_providers(&conn).unwrap().is_empty());
    }
}
