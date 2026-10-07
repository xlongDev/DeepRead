//! Cloud TTS with an on-disk cache (spec §44/§46/§122).
//!
//! The webview never sees API keys or provider hosts: this command resolves
//! the provider + key server-side, synthesizes through the OpenAI-compatible
//! `/audio/speech` endpoint, and stores the audio under `tts-cache/` keyed by
//! a SHA-256 of the request. The frontend plays the returned file via the
//! asset protocol, so playback works offline once a segment is cached.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Digest;
use ts_rs::TS;

use crate::ai::{data_dir, provider_by_id};
use crate::error::{AppError, ErrorCode};

pub const MAX_TTS_TEXT_CHARS: usize = 5000;
pub const TTS_FORMAT: &str = "mp3";

/// Absolute cache directory for synthesized audio.
pub fn cache_dir(base: &Path) -> PathBuf {
    base.join("tts-cache")
}

/// 缓存默认上限 2GB。可在 `app_settings` 以 [`TTS_CACHE_LIMIT_KEY`] 覆盖
/// (字节整数字符串;非法值/0 一律回默认)。设置面板的旋钮等 B3 的设置
/// 协议一起透出,协议面不为一个数字单开命令。
pub const TTS_CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const TTS_CACHE_LIMIT_KEY: &str = "tts.cache.maxBytes";

/// Pure helper: effective cap from an optional app_settings value.
fn cache_limit(setting: Option<&str>) -> u64 {
    setting
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|limit| *limit > 0)
        .unwrap_or(TTS_CACHE_MAX_BYTES)
}

/// mtime LRU:最旧的先删,直到目录总大小 ≤ `max_bytes`。返回删除的字节数。
/// 每删一个记一条日志 —— "缓存怎么变小了" 必须有账可查。
pub fn prune_cache(dir: &Path, max_bytes: u64) -> std::io::Result<u64> {
    let mut entries: Vec<(std::time::SystemTime, PathBuf, u64)> = Vec::new();
    let mut total = 0u64;
    for entry in std::fs::read_dir(dir)?.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        total += meta.len();
        let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        entries.push((modified, entry.path(), meta.len()));
    }
    if total <= max_bytes {
        return Ok(0);
    }
    entries.sort_by_key(|(modified, _, _)| *modified);
    let mut deleted = 0u64;
    for (_, path, len) in entries {
        if total <= max_bytes {
            break;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {
                total = total.saturating_sub(len);
                deleted += len;
                log::info!("tts-cache: pruned {} ({len} bytes)", path.display());
            }
            Err(err) => log::warn!("tts-cache: failed to remove {}: {err}", path.display()),
        }
    }
    Ok(deleted)
}

/// 当前生效的上限:best-effort 读 app_settings,读不到就回默认。
fn cache_limit_from_db(conn: &rusqlite::Connection) -> u64 {
    let stored = crate::storage::get_setting(conn, TTS_CACHE_LIMIT_KEY)
        .ok()
        .flatten();
    cache_limit(stored.as_deref())
}

/// 启动即清一次,之后常驻会话每 24h 一次(interval 首个 tick 立即触发)。
pub fn spawn_cache_pruner(app: tauri::AppHandle) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(24 * 60 * 60));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            if let Ok(base) = data_dir(&app) {
                let db = app.state::<crate::storage::Db>();
                if let Ok(conn) = db.0.lock() {
                    let limit = cache_limit_from_db(&conn);
                    drop(conn);
                    if let Err(err) = prune_cache(&cache_dir(&base), limit) {
                        log::warn!("tts-cache: prune failed: {err}");
                    }
                }
            }
            ticker.tick().await;
        }
    });
}

/// Pure helper: the upstream speech endpoint for a configured base URL.
pub fn speech_endpoint(base_url: &str) -> String {
    format!("{}/audio/speech", base_url.trim_end_matches('/'))
}

/// Content-addressed cache file name (request tuple + text).
pub fn cache_file_name(
    config_id: &str,
    voice: &str,
    speed: f64,
    text: &str,
    model: &str,
) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(config_id.as_bytes());
    hasher.update([0]);
    hasher.update(model.as_bytes());
    hasher.update([0]);
    hasher.update(voice.as_bytes());
    hasher.update([0]);
    hasher.update(speed.to_le_bytes());
    hasher.update([0]);
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{hex}.{TTS_FORMAT}")
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TtsAudioRequest {
    pub config_id: String,
    pub text: String,
    pub voice: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TtsAudioResponse {
    pub path: String,
    pub cached: bool,
}

/// Pure helper: the request body for the speech endpoint (tested without IO).
pub fn speech_body(model: &str, text: &str, voice: &str, speed: f64) -> Value {
    json!({
        "model": model,
        "input": text,
        "voice": voice,
        "speed": speed,
        "response_format": TTS_FORMAT,
    })
}

/// Synthesize-or-serve: returns the cached file when present, otherwise calls
/// the provider once and writes the bytes into the cache.
pub async fn tts_audio(
    app: tauri::AppHandle,
    secrets: tauri::State<'_, crate::secrets::SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
    request: TtsAudioRequest,
) -> Result<TtsAudioResponse, AppError> {
    let text = request.text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "合成文本不能为空",
        ));
    }
    if text.chars().count() > MAX_TTS_TEXT_CHARS {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "单次合成的文本过长",
        ));
    }
    let speed = request.speed.unwrap_or(1.0);
    if !(0.25..=4.0).contains(&speed) {
        return Err(AppError::new(ErrorCode::SystemValidation, "语速超出范围"));
    }

    let base = data_dir(&app)?;
    let config = {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        provider_by_id(&conn, &request.config_id)?
            .ok_or_else(|| AppError::new(ErrorCode::TtsProviderError, "语音服务配置不存在"))?
    };
    let model = config.tts_model.clone().ok_or_else(|| {
        AppError::new(
            ErrorCode::TtsProviderError,
            "请先为该服务配置语音合成(TTS)模型",
        )
    })?;

    let file_name = cache_file_name(&config.id, &request.voice, speed, &text, &model);
    let path = cache_dir(&base).join(file_name);
    if path.exists() {
        return Ok(TtsAudioResponse {
            path: path.to_string_lossy().to_string(),
            cached: true,
        });
    }

    let key = format!("ai.key.{}", config.id);
    let api_key = crate::secrets::get_secret(&secrets, &base, &key)?
        .ok_or_else(|| AppError::new(ErrorCode::TtsProviderError, "请先填写该服务的 API Key"))?;

    let url = speech_endpoint(&config.base_url);
    let client = crate::http();
    let response = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&speech_body(&model, &text, &request.voice, speed))
        .send()
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::TtsProviderError, "无法连接语音合成服务")
                .with_cause(err)
                .retryable()
        })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::new(
            ErrorCode::TtsProviderError,
            format!("语音合成服务返回错误({status})"),
        )
        .with_context("body", Value::String(body.chars().take(400).collect()))
        .retryable());
    }
    let bytes = response.bytes().await.map_err(|err| {
        AppError::new(ErrorCode::TtsProviderError, "语音合成响应传输中断")
            .with_cause(err)
            .retryable()
    })?;
    if bytes.is_empty() {
        return Err(
            AppError::new(ErrorCode::TtsProviderError, "语音合成服务返回了空音频").retryable(),
        );
    }

    std::fs::create_dir_all(path.parent().expect("cache path has a parent")).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to create tts cache").with_cause(err)
    })?;
    // Temp file + rename so a crashed write never leaves a corrupt cache hit.
    let temp = path.with_extension("part");
    std::fs::write(&temp, &bytes).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to write audio").with_cause(err)
    })?;
    std::fs::rename(&temp, &path).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to commit audio").with_cause(err)
    })?;

    Ok(TtsAudioResponse {
        path: path.to_string_lossy().to_string(),
        cached: false,
    })
}

#[tauri::command(rename = "tts.audio")]
pub async fn command_tts_audio(
    app: tauri::AppHandle,
    secrets: tauri::State<'_, crate::secrets::SecretStore>,
    db: tauri::State<'_, crate::storage::Db>,
    request: TtsAudioRequest,
) -> Result<TtsAudioResponse, AppError> {
    tts_audio(app, secrets, db, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_endpoint_appends_path() {
        assert_eq!(
            speech_endpoint("https://api.example.com/v1"),
            "https://api.example.com/v1/audio/speech"
        );
        assert_eq!(
            speech_endpoint("https://api.example.com/v1/"),
            "https://api.example.com/v1/audio/speech"
        );
    }

    #[test]
    fn cache_file_name_is_deterministic_and_request_sensitive() {
        let a = cache_file_name("cfg-12345678", "alloy", 1.0, "你好。", "tts-1");
        let b = cache_file_name("cfg-12345678", "alloy", 1.0, "你好。", "tts-1");
        let c = cache_file_name("cfg-12345678", "alloy", 1.5, "你好。", "tts-1");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.ends_with(".mp3"));
        assert_eq!(a.len(), 64 + 4);
    }

    #[test]
    fn speech_body_carries_the_expected_fields() {
        let body = speech_body("tts-1", "你好。", "alloy", 1.2);
        assert_eq!(body["model"], "tts-1");
        assert_eq!(body["input"], "你好。");
        assert_eq!(body["voice"], "alloy");
        assert_eq!(body["speed"], 1.2);
        assert_eq!(body["response_format"], "mp3");
    }

    #[test]
    fn cache_limit_parses_setting_or_falls_back_to_default() {
        assert_eq!(cache_limit(None), TTS_CACHE_MAX_BYTES);
        assert_eq!(cache_limit(Some("5000")), 5000);
        assert_eq!(cache_limit(Some("  5000 ")), 5000);
        // 0 = "全删"是不该发生的误配,当没配处理。
        assert_eq!(cache_limit(Some("0")), TTS_CACHE_MAX_BYTES);
        assert_eq!(cache_limit(Some("abc")), TTS_CACHE_MAX_BYTES);
    }

    #[test]
    fn prune_cache_drops_oldest_first_and_stops_when_under_cap() {
        let dir = std::env::temp_dir().join(format!("deepread-tts-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        // 间隔写保证 mtime 严格递增(排序才确定)。
        for name in ["a", "b", "c"] {
            std::thread::sleep(std::time::Duration::from_millis(25));
            std::fs::write(dir.join(name), vec![0u8; 100]).expect("write cache file");
        }
        // 总 300,上限 200 → 只删最旧的一个,达标即停。
        assert_eq!(prune_cache(&dir, 200).expect("prune"), 100);
        assert!(!dir.join("a").exists());
        assert!(dir.join("b").exists() && dir.join("c").exists());
        // 已达标:再跑一次是空操作。
        assert_eq!(prune_cache(&dir, 200).expect("prune again"), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
