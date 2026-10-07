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

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiConfigListResponse {
    pub providers: Vec<AiProviderConfig>,
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
    Ok(AiConfigListResponse {
        providers: load_providers(&conn)?,
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

    let key = format!("ai.key.{}", request.provider.id);
    crate::secrets::set_secret(&secrets, &base, &key, &request.api_key)?;
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
        "summary" | "outline" | "notes" | "characters" => Ok(()),
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
    conn.execute(
        "INSERT OR REPLACE INTO ai_index (book_hash, chunks, embedding_model, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![hash, chunks, index.embedding_model, index.created_at],
    )
    .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to save ai index").with_cause(err))?;
    Ok(())
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
            AppError::new(ErrorCode::AiProviderError, "无法连接 embeddings 服务")
                .with_cause(err)
                .retryable()
        })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::new(
            ErrorCode::AiProviderError,
            format!("embeddings 服务返回错误({status})"),
        )
        .with_context("body", Value::String(text.chars().take(400).collect())));
    }
    let payload: Value = response.json().await.map_err(|err| {
        AppError::new(ErrorCode::AiProviderError, "embeddings 响应不是合法 JSON").with_cause(err)
    })?;
    let mut vectors: Vec<(usize, Vec<f64>)> = payload
        .get("data")
        .and_then(|data| data.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|item| {
                    let index = item.get("index")?.as_u64()? as usize;
                    let embedding = item.get("embedding")?.as_array()?;
                    let vector: Vec<f64> = embedding
                        .iter()
                        .map(|value| value.as_f64().unwrap_or(0.0))
                        .collect();
                    Some((index, vector))
                })
                .collect()
        })
        .unwrap_or_default();
    vectors.sort_by_key(|(index, _)| *index);
    if vectors.len() != texts.len() {
        return Err(AppError::new(
            ErrorCode::AiProviderError,
            format!(
                "embeddings 数量不符:期望 {},实际 {}",
                texts.len(),
                vectors.len()
            ),
        ));
    }
    Ok(vectors.into_iter().map(|(_, vector)| vector).collect())
}

/// Pure helper: the upstream chat-completions URL for a configured base URL.
pub fn chat_endpoint(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
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
                while let Some(boundary) = buffer.find("\n\n") {
                    let event = buffer[..boundary].to_string();
                    buffer.drain(..boundary + 2);
                    if let Some(data) = event
                        .lines()
                        .find_map(|line| line.strip_prefix("data: "))
                        .map(str::to_string)
                    {
                        on_chunk(data);
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

    tauri::async_runtime::spawn(async move {
        let on_chunk = |chunk: String| {
            if chunk == "[\"__CANCELLED__\"]" {
                emit_event(&channel, "cancelled", json!(null));
            } else {
                emit_event(&channel, "chunk", json!(chunk));
            }
        };
        let result = stream_chat(client, &url, &api_key, body, cancelled, &on_chunk).await;
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
    let model = config
        .embedding_model
        .clone()
        .unwrap_or_else(|| config.model.clone());
    let url = format!("{}/embeddings", config.base_url.trim_end_matches('/'));
    let client = crate::http();
    let vectors = embed_texts(client, &url, &api_key, &model, &request.texts).await?;
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
        assert!(store_artifact(&conn, hash, "evil", &json!({}), "t").is_err());
        assert!(load_artifact(&conn, "../../evil", "summary").is_err());
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
