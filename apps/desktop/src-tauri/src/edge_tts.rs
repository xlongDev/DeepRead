//! Edge TTS (Microsoft Edge read-aloud) with the shared on-disk cache.
//!
//! Speaks through the same WebSocket endpoint the Edge browser uses, gated by
//! the public trusted-client token plus the time-derived `Sec-MS-GEC` proof.
//! Audio arrives as MP3 frames over binary WebSocket messages; frames are
//! concatenated into one file and cached under `tts-cache/` exactly like the
//! OpenAI-compatible cloud path, so playback and offline reuse are identical.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, ErrorCode};

pub const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_ENDPOINT: &str =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const VOICES_ENDPOINT: &str = "https://speech.platform.bing.com/consumer/speech/voices/list";
const SEC_MS_GEC_VERSION: &str = "1-143.0.3650.75";
/// Output format: 24 kHz mono MP3 keeps segments small while staying clear.
const AUDIO_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";

/// Pure helper: the time-derived `Sec-MS-GEC` proof token. The clock is
/// floored to 5-minute buckets so both sides agree within the skew window.
pub fn sec_ms_gec(now_seconds: u64) -> String {
    const WIN_EPOCH_OFFSET: u64 = 11_644_473_600;
    let mut ticks = now_seconds.saturating_add(WIN_EPOCH_OFFSET);
    ticks -= ticks % 300;
    let material = format!("{}0000000{}", ticks, TRUSTED_CLIENT_TOKEN);
    let digest = Sha256::digest(material.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    hex.to_uppercase()
}

/// Pure helper: the WebSocket URL with all required query parameters.
pub fn synthesize_url(now_seconds: u64) -> String {
    format!(
        "{WSS_ENDPOINT}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}",
        sec_ms_gec(now_seconds)
    )
}

/// Pure helper: SSML for one segment. `rate` 1.0 maps to `+0%`.
pub fn ssml_for(text: &str, voice: &str, lang: &str, rate: f64) -> String {
    let percent = ((rate - 1.0) * 100.0).round();
    let sign = if percent >= 0.0 { '+' } else { '-' };
    let percent = percent.abs();
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&apos;")
        .replace('"', "&quot;");
    format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{lang}'>\
         <voice name='{voice}'>\
         <prosody pitch='+0Hz' rate='{sign}{percent}%'>\
         {escaped}\
         </prosody></voice></speak>"
    )
}

/// Pure helper: the two text frames the protocol expects on connect.
pub fn handshake_messages(ssml: &str, request_id: &str, now_seconds: u64) -> (String, String) {
    let timestamp = rfc1123(now_seconds);
    let config = format!(
        "X-Timestamp:{timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
         {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}},\"outputFormat\":\"{AUDIO_FORMAT}\"}}}}}}}}"
    );
    let ssml_frame = format!(
        "X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{timestamp}Z\r\nPath:ssml\r\n\r\n{ssml}"
    );
    (config, ssml_frame)
}

/// Pure helper: RFC 1123 date (no external chrono dependency needed for this).
pub fn rfc1123(now_seconds: u64) -> String {
    // time crate is already in the dependency tree.
    let offset = time::OffsetDateTime::from_unix_timestamp(now_seconds as i64)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    offset
        .format(&time::format_description::well_known::Rfc2822)
        .unwrap_or_default()
        .replace("+0000", "GMT")
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn request_id() -> String {
    let digest = Sha256::digest(now_seconds().to_le_bytes().as_slice());
    let hex: String = digest.iter().map(|byte| format!("{byte:02X}")).collect();
    hex.chars().take(32).collect()
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EdgeVoice {
    pub short_name: String,
    pub friendly_name: String,
    pub locale: String,
    pub gender: String,
}

/// Fallback catalog when the live voice list is unreachable: the full set of
/// Chinese voices plus the most-used English ones.
fn fallback_voices() -> Vec<EdgeVoice> {
    const ZH: &[&str] = &[
        "zh-CN-XiaoxiaoNeural",
        "zh-CN-XiaoyiNeural",
        "zh-CN-YunjianNeural",
        "zh-CN-YunxiNeural",
        "zh-CN-YunxiaNeural",
        "zh-CN-YunyangNeural",
        "zh-CN-liaoning-XiaobeiNeural",
        "zh-CN-shaanxi-XiaoniNeural",
        "zh-HK-HiuGaaiNeural",
        "zh-HK-HiuMaanNeural",
        "zh-HK-WanLungNeural",
        "zh-TW-HsiaoChenNeural",
        "zh-TW-HsiaoYuNeural",
        "zh-TW-YunJheNeural",
    ];
    const EN: &[&str] = &[
        "en-US-AriaNeural",
        "en-US-AnaNeural",
        "en-US-ChristopherNeural",
        "en-US-EricNeural",
        "en-US-GuyNeural",
        "en-US-JennyNeural",
        "en-MichelleNeural",
        "en-US-RogerNeural",
        "en-US-SteffanNeural",
        "en-GB-SoniaNeural",
        "en-GB-RyanNeural",
        "en-GB-LibbyNeural",
    ];
    let mut voices: Vec<EdgeVoice> = ZH
        .iter()
        .chain(EN.iter())
        .map(|short| {
            let locale = short.split('-').take(2).collect::<Vec<_>>().join("-");
            EdgeVoice {
                short_name: (*short).to_string(),
                friendly_name: (*short).to_string(),
                locale,
                gender: "—".to_string(),
            }
        })
        .collect();
    voices.sort_by(|a, b| a.short_name.cmp(&b.short_name));
    voices
}

/// Live voice list; falls back to the curated catalog on any failure.
pub async fn edge_voices() -> Result<Vec<EdgeVoice>, AppError> {
    let seconds = now_seconds();
    let gec = sec_ms_gec(seconds);
    let url = format!(
        "{VOICES_ENDPOINT}?trustedclienttoken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={gec}&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}"
    );
    let response = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::TtsProviderError, "无法获取 Edge 语音列表")
                .with_cause(err)
                .retryable()
        })?;
    if !response.status().is_success() {
        return Ok(fallback_voices());
    }
    #[derive(Deserialize)]
    struct RawVoice {
        #[serde(rename = "ShortName")]
        short_name: String,
        #[serde(rename = "FriendlyName")]
        friendly_name: String,
        #[serde(rename = "Locale")]
        locale: String,
        #[serde(rename = "Gender")]
        gender: String,
    }
    let raw: Vec<RawVoice> = response.json().await.map_err(|err| {
        AppError::new(ErrorCode::TtsProviderError, "Edge 语音列表解析失败")
            .with_cause(err)
            .retryable()
    })?;
    let voices: Vec<EdgeVoice> = raw
        .into_iter()
        .map(|voice| EdgeVoice {
            short_name: voice.short_name,
            friendly_name: voice.friendly_name,
            locale: voice.locale,
            gender: voice.gender,
        })
        .collect();
    if voices.is_empty() {
        return Ok(fallback_voices());
    }
    Ok(voices)
}

/// Synthesize one segment over WebSocket, concatenating MP3 binary frames.
async fn synthesize(text: &str, voice: &str, lang: &str, rate: f64) -> Result<Vec<u8>, AppError> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let seconds = now_seconds();
    let mut request = synthesize_url(seconds)
        .into_client_request()
        .map_err(|err| {
            AppError::new(ErrorCode::TtsProviderError, "Edge TTS 连接请求构造失败").with_cause(err)
        })?;
    // The endpoint rejects bare upgrades with 403. Headers mirror the Edge
    // read-aloud extension (edge-tts reference): extension Origin, no-cache,
    // and a current Edge browser User-Agent.
    let headers = request.headers_mut();
    for (name, value) in [
        (
            "Origin",
            "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        ),
        ("Pragma", "no-cache"),
        ("Cache-Control", "no-cache"),
        ("Accept-Language", "en-US,en;q=0.9"),
        (
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        ),
    ] {
        headers.insert(name, value.parse().expect("static header value"));
    }
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::TtsProviderError, "无法连接 Edge TTS 服务")
                .with_cause(err)
                .retryable()
        })?;

    let (config, ssml_frame) =
        handshake_messages(&ssml_for(text, voice, lang, rate), &request_id(), seconds);
    socket.send(Message::Text(config)).await.map_err(|err| {
        AppError::new(ErrorCode::TtsProviderError, "Edge TTS 握手发送失败")
            .with_cause(err)
            .retryable()
    })?;
    socket
        .send(Message::Text(ssml_frame))
        .await
        .map_err(|err| {
            AppError::new(ErrorCode::TtsProviderError, "Edge TTS 请求发送失败")
                .with_cause(err)
                .retryable()
        })?;

    let mut audio: Vec<u8> = Vec::new();
    while let Some(message) = socket.next().await {
        let message = message.map_err(|err| {
            AppError::new(ErrorCode::TtsProviderError, "Edge TTS 连接中断")
                .with_cause(err)
                .retryable()
        })?;
        match message {
            Message::Binary(bytes) => {
                if bytes.len() > 2 {
                    let header_len = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
                    if bytes.len() > header_len + 2 {
                        audio.extend_from_slice(&bytes[header_len + 2..]);
                    }
                }
            }
            Message::Text(text) => {
                if text.contains("Path:turn.end") {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    if audio.is_empty() {
        return Err(AppError::new(ErrorCode::TtsProviderError, "Edge TTS 未返回音频").retryable());
    }
    Ok(audio)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeTtsAudioRequest {
    pub text: String,
    pub voice: String,
    #[serde(default)]
    pub lang: Option<String>,
    #[serde(default)]
    pub rate: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EdgeTtsAudioResponse {
    pub path: String,
    pub cached: bool,
}

/// Synthesize-or-serve through the Edge endpoint, cached like cloud audio.
pub async fn edge_tts_audio(
    base: &Path,
    request: EdgeTtsAudioRequest,
) -> Result<EdgeTtsAudioResponse, AppError> {
    let text = request.text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "合成文本不能为空",
        ));
    }
    if text.chars().count() > crate::tts::MAX_TTS_TEXT_CHARS {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "单次合成的文本过长",
        ));
    }
    let rate = request.rate.unwrap_or(1.0);
    if !(0.25..=4.0).contains(&rate) {
        return Err(AppError::new(ErrorCode::SystemValidation, "语速超出范围"));
    }
    let voice = request.voice.trim().to_string();
    if voice.is_empty() {
        return Err(AppError::new(ErrorCode::SystemValidation, "语音不能为空"));
    }
    let lang = request
        .lang
        .unwrap_or_else(|| voice.split('-').take(2).collect::<Vec<_>>().join("-"));

    let file_name = crate::tts::cache_file_name("edge", &voice, rate, &text, "edge-tts");
    let path = crate::tts::cache_dir(base).join(file_name);
    if path.exists() {
        return Ok(EdgeTtsAudioResponse {
            path: path.to_string_lossy().to_string(),
            cached: true,
        });
    }

    // Edge 端点偶尔掐断连接:失败后换一个时间桶重试一次再报错。
    let bytes = match synthesize(&text, &voice, &lang, rate).await {
        Ok(bytes) => bytes,
        Err(first) => synthesize(&text, &voice, &lang, rate)
            .await
            .map_err(|_| first)?,
    };
    std::fs::create_dir_all(path.parent().expect("cache path has a parent")).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to create tts cache").with_cause(err)
    })?;
    let temp = path.with_extension("part");
    std::fs::write(&temp, &bytes).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to write audio").with_cause(err)
    })?;
    std::fs::rename(&temp, &path).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to commit audio").with_cause(err)
    })?;
    Ok(EdgeTtsAudioResponse {
        path: path.to_string_lossy().to_string(),
        cached: false,
    })
}

#[tauri::command(rename = "tts.edge.audio")]
pub async fn command_edge_tts_audio(
    app: tauri::AppHandle,
    request: EdgeTtsAudioRequest,
) -> Result<EdgeTtsAudioResponse, AppError> {
    let base = crate::ai::data_dir(&app)?;
    edge_tts_audio(&base, request).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeVoicesResponse {
    pub voices: Vec<EdgeVoice>,
}

#[tauri::command(rename = "tts.edge.voices")]
pub async fn command_edge_tts_voices() -> Result<EdgeVoicesResponse, AppError> {
    Ok(EdgeVoicesResponse {
        voices: edge_voices().await?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sec_ms_gec_is_deterministic_and_5min_stable() {
        // 1_700_000_100 + WIN_EPOCH lands exactly on a 5-minute boundary.
        let a = sec_ms_gec(1_700_000_100);
        let b = sec_ms_gec(1_700_000_100);
        let c = sec_ms_gec(1_700_000_399); // same 5-minute bucket
        let d = sec_ms_gec(1_700_000_400); // next bucket
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_ne!(a, d);
        assert_eq!(a.len(), 64);
        assert!(
            a.chars()
                .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit())
        );
    }

    #[test]
    fn synthesize_url_carries_token_and_proof() {
        let url = synthesize_url(1_700_000_000);
        assert!(url.starts_with(WSS_ENDPOINT));
        assert!(url.contains("TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4"));
        assert!(url.contains("Sec-MS-GEC="));
        assert!(url.contains("Sec-MS-GEC-Version="));
    }

    #[test]
    fn ssml_escapes_and_encodes_rate() {
        let ssml = ssml_for("你好 & <世界>", "zh-CN-XiaoxiaoNeural", "zh-CN", 1.5);
        assert!(ssml.contains("rate='+50%'"));
        assert!(ssml.contains("你好 &amp; &lt;世界&gt;"));
        assert!(ssml.contains("voice name='zh-CN-XiaoxiaoNeural'"));
        let slow = ssml_for("你好", "zh-CN-XiaoxiaoNeural", "zh-CN", 0.75);
        assert!(slow.contains("rate='-25%'"));
    }

    #[test]
    fn handshake_frames_carry_paths() {
        let (config, ssml) = handshake_messages("<speak/>", "ABC123", 1_700_000_000);
        assert!(config.contains("Path:speech.config"));
        assert!(config.contains("outputFormat"));
        assert!(ssml.contains("X-RequestId:ABC123"));
        assert!(ssml.contains("Path:ssml"));
        assert!(ssml.ends_with("<speak/>"));
    }

    /// 真实端到端:连微软端点合成一段中文(需要联网,平时跳过)。
    #[tokio::test]
    #[ignore = "hits the live Edge endpoint; run with --ignored"]
    async fn edge_audio_synthesizes_live() {
        let base = std::env::temp_dir().join("deepread-edge-tts-live");
        let result = edge_tts_audio(
            &base,
            EdgeTtsAudioRequest {
                text: "你好,这是深读的语音合成测试。".to_string(),
                voice: "zh-CN-XiaoxiaoNeural".to_string(),
                lang: Some("zh-CN".to_string()),
                rate: Some(1.0),
            },
        )
        .await
        .expect("live synthesis should succeed");
        let bytes = std::fs::read(&result.path).expect("cached file exists");
        assert!(bytes.len() > 10_000, "mp3 too small: {}", bytes.len());
        // Edge returns a raw MPEG stream: frame sync 0xFFF (no ID3 header).
        assert_eq!(bytes[0], 0xFF, "should start with an MPEG frame sync");
        assert_eq!(bytes[1] & 0xE0, 0xE0, "sync bits + version must be set");
    }

    #[tokio::test]
    async fn edge_audio_rejects_bad_input() {
        let base = std::env::temp_dir().join("deepread-edge-tts-test");
        let empty = edge_tts_audio(
            &base,
            EdgeTtsAudioRequest {
                text: "  ".to_string(),
                voice: "zh-CN-XiaoxiaoNeural".to_string(),
                lang: None,
                rate: None,
            },
        )
        .await;
        assert!(empty.is_err());
        let fast = edge_tts_audio(
            &base,
            EdgeTtsAudioRequest {
                text: "你好".to_string(),
                voice: "zh-CN-XiaoxiaoNeural".to_string(),
                lang: None,
                rate: Some(9.0),
            },
        )
        .await;
        assert!(fast.is_err());
    }
}
