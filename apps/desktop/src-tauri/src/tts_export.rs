//! 有声书导出(ADR-0009 / plan B8)。
//!
//! 合成循环在 Rust(整书音频不过 IPC):前端用与听书同一套分块逻辑
//! (reader-core 的 `buildSpeechUnits`)产出块清单一次交付,这里逐块走
//! edge/provider 两条既有合成路径 —— 两者都落 `tts-cache/`,所以**听过的
//! 句子导出秒过,中断续跑天然免费**(缓存命中即跳过合成)。输出 = 用户选定
//! 目录下的 `chNN-章节名.mp3`(MP3 帧拼接即合法流,逐章原子提交:.part 写满
//! 才改名)+ `manifest.json`。m4b 不做(需要 ffmpeg,违反依赖纪律,见 ADR-0009)。
//!
//! 进度/取消走轮询而非事件系统:v1 的 UI(抽屉内进度 + 书架侧栏一行)轮询
//! `tts.export.status` 每秒一次足够,省掉 EventMap 扩展与双端事件管线的全部
//! 面积;同一本书同时只允许一个导出任务。

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::ai::data_dir;
use crate::error::{AppError, ErrorCode};
use crate::tts::TtsAudioRequest;

/// 磁盘预检的体积估算:Edge 的 mp3 约 24kbps ≈ 3KB/s,朗读 ~4 字/秒,
/// 每字不足 1KB;取 1.5KB/字覆盖云供应商的更高码率。
pub const ESTIMATED_BYTES_PER_CHAR: u64 = 1500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TtsExportEngine {
    Edge,
    Cloud,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TtsExportChapter {
    pub index: u32,
    pub title: String,
    pub blocks: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TtsExportStartRequest {
    pub book_hash: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub engine: TtsExportEngine,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_id: Option<String>,
    pub voice: String,
    /// 合成语速。Edge 的合成固定 1.0(播放期才拉伸,缓存与语速无关 ——
    /// 见 edge_tts.rs),此字段只对 cloud 生效。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    pub output_dir: String,
    pub chapters: Vec<TtsExportChapter>,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TtsExportStartResponse {
    pub total_blocks: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TtsExportPhase {
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TtsExportTaskStatus {
    pub phase: TtsExportPhase,
    /// 当前章的 index(请求里的原值,展示用)。
    pub chapter: u32,
    /// 当前章内已完成块数(0..=该章块数)。
    pub block: u32,
    pub total_blocks: u32,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

struct ExportTask {
    /// 取消开关。任务结束后条目保留(终态要给 status 轮询看),flag 随之作废。
    flag: Arc<AtomicBool>,
    status: StdMutex<TtsExportTaskStatus>,
}

#[derive(Default)]
pub struct TtsExportState {
    /// bookHash → 任务。同书并发 start 被拒;不同书可并行。
    tasks: Mutex<HashMap<String, ExportTask>>,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TtsExportTaskEntry {
    pub book_hash: String,
    pub status: TtsExportTaskStatus,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TtsExportStatusRequest {
    /// 省略 = 返回全部任务(书架侧栏只要"有没有在跑")。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book_hash: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TtsExportStatusResponse {
    pub tasks: Vec<TtsExportTaskEntry>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct TtsExportCancelRequest {
    pub book_hash: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TtsExportCancelResponse {
    pub cancelled: bool,
}

/// 磁盘剩余空间(字节)。标准库没有此 API,退回系统工具:unix `df -k -P`
/// (POSIX 格式第 4 列 = 可用 KB),Windows `wmic`。拿不到 = None,预检放行
/// (写盘失败会让任务报错,不至于静默丢数据)。
pub fn free_space_bytes(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        let output = Command::new("df")
            .args(["-k", "-P"])
            .arg(path)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        parse_df_available(&text)
    }
    #[cfg(windows)]
    {
        let output = Command::new("wmic")
            .args([
                "logicaldisk",
                "where",
                &format!("DeviceID='{}'", windows_drive(path)?),
                "get",
                "FreeSpace",
                "/value",
            ])
            .output()
            .ok()?;
        parse_wmic_free_space(&String::from_utf8_lossy(&output.stdout))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        None
    }
}

/// `df -P` 的最后一行:第 4 列(0-based)是可用 KB。
pub fn parse_df_available(text: &str) -> Option<u64> {
    let line = text.lines().rev().find(|l| l.starts_with('/'))?;
    let available = line.split_whitespace().nth(3)?;
    available.trim().parse::<u64>().ok().map(|kb| kb * 1024)
}

#[cfg(windows)]
fn windows_drive(path: &Path) -> Option<String> {
    let prefix = path.canonicalize().ok()?.to_string_lossy().to_string();
    let prefix = prefix.strip_prefix(r"\\?\")?;
    Some(prefix.chars().take(2).collect())
}

/// `wmic /value` 输出里的 `FreeSpace=<字节>` 行。
#[cfg(windows)]
pub fn parse_wmic_free_space(text: &str) -> Option<u64> {
    for line in text.lines() {
        if let Some(value) = line.trim().strip_prefix("FreeSpace=") {
            return value.trim().parse::<u64>().ok();
        }
    }
    None
}

/// 纯估算:整书预计字节(块字符总数 × 每字系数)。
pub fn estimate_bytes(chapters: &[TtsExportChapter]) -> u64 {
    let chars: u64 = chapters
        .iter()
        .map(|chapter| {
            chapter
                .blocks
                .iter()
                .map(|b| b.chars().count() as u64)
                .sum::<u64>()
        })
        .sum();
    chars * ESTIMATED_BYTES_PER_CHAR
}

/// 章文件名:`chNN-章节名.mp3`。清洗文件系统不安全字符,同名落空标题回退。
pub fn chapter_file_name(index: u32, title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.chars().take(60).collect::<String>();
    let cleaned = cleaned.trim();
    let name = if cleaned.is_empty() {
        "未命名"
    } else {
        cleaned
    };
    format!("ch{index:02}-{name}.mp3")
}

fn validate_request(request: &TtsExportStartRequest) -> Result<(), AppError> {
    if request.voice.trim().is_empty() {
        return Err(AppError::new(ErrorCode::SystemValidation, "语音不能为空"));
    }
    if request.chapters.is_empty() {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "没有可导出的章节",
        ));
    }
    if request.engine == TtsExportEngine::Cloud && request.config_id.is_none() {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "云引擎导出需要指定 AI 服务配置",
        ));
    }
    if let Some(speed) = request.speed
        && !(0.25..=4.0).contains(&speed)
    {
        return Err(AppError::new(ErrorCode::SystemValidation, "语速超出范围"));
    }
    for chapter in &request.chapters {
        for block in &chapter.blocks {
            if block.trim().is_empty() {
                continue;
            }
            if block.chars().count() > crate::tts::MAX_TTS_TEXT_CHARS {
                return Err(AppError::new(
                    ErrorCode::SystemValidation,
                    "导出块超过单次合成上限",
                ));
            }
        }
    }
    Ok(())
}

async fn update_status(
    state: &TtsExportState,
    book_hash: &str,
    apply: impl FnOnce(&mut TtsExportTaskStatus),
) {
    let tasks = state.tasks.lock().await;
    if let Some(task) = tasks.get(book_hash)
        && let Ok(mut status) = task.status.lock()
    {
        apply(&mut status);
    }
}

fn snapshot_status(task: &ExportTask) -> TtsExportTaskStatus {
    task.status.lock().expect("task status mutex").clone()
}

async fn finish(
    state: &TtsExportState,
    book_hash: &str,
    phase: TtsExportPhase,
    error: Option<String>,
) {
    let stamp = crate::timestamps::rfc3339_now();
    update_status(state, book_hash, |status| {
        status.phase = phase;
        status.error = error;
        status.finished_at = Some(stamp);
    })
    .await;
}

/// 合成一块,返回音频字节。两条既有路径都自带缓存:命中即读盘,未命中
/// 合成后落缓存。失败时上层再重试一次(与播放同节奏)。
async fn synthesize_block(
    app: &tauri::AppHandle,
    base: &Path,
    request: &TtsExportStartRequest,
    text: &str,
) -> Result<Vec<u8>, AppError> {
    match request.engine {
        TtsExportEngine::Edge => {
            let response = crate::edge_tts::edge_tts_audio(
                base,
                crate::edge_tts::EdgeTtsAudioRequest {
                    text: text.to_string(),
                    voice: request.voice.clone(),
                    lang: None,
                },
            )
            .await?;
            use base64::engine::general_purpose::STANDARD;
            STANDARD.decode(response.audio).map_err(|err| {
                AppError::new(ErrorCode::TtsProviderError, "缓存音频解码失败").with_cause(err)
            })
        }
        TtsExportEngine::Cloud => {
            let config_id = request
                .config_id
                .as_deref()
                .expect("cloud engine validated config_id at start");
            let response = crate::tts::tts_audio(
                app.clone(),
                app.state::<crate::secrets::SecretStore>(),
                app.state::<crate::storage::Db>(),
                TtsAudioRequest {
                    config_id: config_id.to_string(),
                    text: text.to_string(),
                    voice: request.voice.clone(),
                    speed: request.speed,
                },
            )
            .await?;
            std::fs::read(&response.path).map_err(|err| {
                AppError::new(ErrorCode::StorageIo, "缓存音频读取失败").with_cause(err)
            })
        }
    }
}

/// 逐章导出循环。每章先查终稿(resume:上次跑完的章直接跳过),块级缓存
/// 命中让"重跑当前章"只花网络请求里真正未合成过的那几块。
async fn run_export(app: tauri::AppHandle, book_hash: String, request: TtsExportStartRequest) {
    let state = app.state::<TtsExportState>();
    let state = state.inner();
    let base = match data_dir(&app) {
        Ok(base) => base,
        Err(err) => {
            finish(state, &book_hash, TtsExportPhase::Error, Some(err.message)).await;
            return;
        }
    };
    let output = std::path::PathBuf::from(&request.output_dir);
    let mut bytes_total: u64 = 0;
    let mut manifest_chapters: Vec<serde_json::Value> = Vec::new();

    for chapter in &request.chapters {
        let cancelled = state
            .tasks
            .lock()
            .await
            .get(&book_hash)
            .map(|task| task.flag.load(Ordering::Relaxed))
            .unwrap_or(false);
        if cancelled {
            finish(state, &book_hash, TtsExportPhase::Cancelled, None).await;
            return;
        }
        let file_name = chapter_file_name(chapter.index, &chapter.title);
        let final_path = output.join(&file_name);
        let chapter_bytes = if final_path.exists() {
            // 续跑:上一轮已提交的章按现稿计,不再重合成。
            std::fs::metadata(&final_path)
                .map(|meta| meta.len())
                .unwrap_or(0)
        } else {
            let part_path = output.join(format!("{file_name}.part"));
            let mut chapter_bytes: u64 = 0;
            let mut chapter_failed: Option<String> = None;
            let file = std::fs::File::create(&part_path);
            let mut out = match file {
                Ok(file) => std::io::BufWriter::new(file),
                Err(err) => {
                    finish(
                        state,
                        &book_hash,
                        TtsExportPhase::Error,
                        Some(format!("无法创建 {}:{err}", part_path.display())),
                    )
                    .await;
                    return;
                }
            };
            for (done, block) in chapter.blocks.iter().enumerate() {
                if state
                    .tasks
                    .lock()
                    .await
                    .get(&book_hash)
                    .map(|task| task.flag.load(Ordering::Relaxed))
                    .unwrap_or(false)
                {
                    // 取消:半成品 .part 留在盘上无害(下次重写),终稿不提交。
                    finish(state, &book_hash, TtsExportPhase::Cancelled, None).await;
                    return;
                }
                if block.trim().is_empty() {
                    update_status(state, &book_hash, |status| status.block = (done + 1) as u32)
                        .await;
                    continue;
                }
                let mut audio = None;
                let mut last_error: Option<AppError> = None;
                for attempt in 0..2 {
                    match synthesize_block(&app, &base, &request, block).await {
                        Ok(bytes) => {
                            audio = Some(bytes);
                            break;
                        }
                        Err(err) if attempt == 0 => last_error = Some(err),
                        Err(err) => last_error = Some(err),
                    }
                }
                match audio {
                    Some(bytes) => {
                        chapter_bytes += bytes.len() as u64;
                        bytes_total += bytes.len() as u64;
                        if let Err(err) = std::io::Write::write_all(&mut out, &bytes) {
                            chapter_failed = Some(format!("写盘失败:{err}"));
                            break;
                        }
                    }
                    None => {
                        let err = last_error.expect("two attempts recorded");
                        chapter_failed = Some(format!(
                            "第 {} 章第 {} 块合成失败:{}",
                            chapter.index,
                            done + 1,
                            err.message
                        ));
                        break;
                    }
                }
                update_status(state, &book_hash, |status| {
                    status.chapter = chapter.index;
                    status.block = (done + 1) as u32;
                    status.bytes = bytes_total;
                })
                .await;
            }
            let _ = std::io::Write::flush(&mut out);
            drop(out);
            if let Some(message) = chapter_failed {
                let _ = std::fs::remove_file(&part_path);
                finish(state, &book_hash, TtsExportPhase::Error, Some(message)).await;
                return;
            }
            // 原子提交:改名的瞬间这一章才算数 —— 断电/取消都不留半个 mp3。
            if let Err(err) = std::fs::rename(&part_path, &final_path) {
                finish(
                    state,
                    &book_hash,
                    TtsExportPhase::Error,
                    Some(format!("章节提交失败:{err}")),
                )
                .await;
                return;
            }
            chapter_bytes
        };
        update_status(state, &book_hash, |status| {
            status.chapter = chapter.index;
            status.block = chapter.blocks.len() as u32;
            status.bytes = bytes_total;
        })
        .await;
        manifest_chapters.push(serde_json::json!({
            "index": chapter.index,
            "title": chapter.title,
            "file": file_name,
            "blocks": chapter.blocks.len(),
            "bytes": chapter_bytes,
        }));
    }

    let manifest = serde_json::json!({
        "version": 1,
        "book": { "title": request.title, "author": request.author },
        "engine": request.engine,
        "voice": request.voice,
        "speed": request.speed.unwrap_or(1.0),
        "createdAt": crate::timestamps::rfc3339_now(),
        "chapters": manifest_chapters,
    });
    let manifest_path = output.join("manifest.json");
    let temp = output.join("manifest.json.part");
    let manifest_bytes = serde_json::to_vec_pretty(&manifest);
    match manifest_bytes
        .map_err(|err| err.to_string())
        .and_then(|raw| {
            std::fs::write(&temp, &raw)
                .and_then(|()| std::fs::rename(&temp, &manifest_path))
                .map_err(|err| err.to_string())
        }) {
        Ok(()) => {}
        Err(message) => {
            // manifest 失败不回滚音频:分章 mp3 已是合法产物,只如实报错。
            finish(
                state,
                &book_hash,
                TtsExportPhase::Error,
                Some(format!("manifest 写入失败:{message}")),
            )
            .await;
            return;
        }
    }
    finish(state, &book_hash, TtsExportPhase::Done, None).await;
}

#[tauri::command(rename = "tts.export.start")]
pub async fn tts_export_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, TtsExportState>,
    request: TtsExportStartRequest,
) -> Result<TtsExportStartResponse, AppError> {
    validate_request(&request)?;
    let total: u32 = request.chapters.iter().map(|c| c.blocks.len() as u32).sum();

    // 磁盘预检:预计体积与剩余空间都要说清,不获批就拒绝并给两个数。
    let output = std::path::PathBuf::from(&request.output_dir);
    let estimate = estimate_bytes(&request.chapters);
    if let Some(free) = free_space_bytes(&output)
        && free < estimate
    {
        return Err(AppError::new(
            ErrorCode::StorageIo,
            format!(
                "磁盘空间不足:预计需要约 {} MB,{} 剩余 {} MB",
                estimate / (1024 * 1024),
                output.display(),
                free / (1024 * 1024)
            ),
        ));
    }

    {
        let mut tasks = state.tasks.lock().await;
        if tasks.get(&request.book_hash).is_some_and(|task| {
            task.status.lock().expect("task mutex").phase == TtsExportPhase::Running
        }) {
            return Err(AppError::new(
                ErrorCode::SystemValidation,
                "这本书已有导出任务在进行",
            ));
        }
        tasks.insert(
            request.book_hash.clone(),
            ExportTask {
                flag: Arc::new(AtomicBool::new(false)),
                status: StdMutex::new(TtsExportTaskStatus {
                    phase: TtsExportPhase::Running,
                    chapter: request.chapters[0].index,
                    block: 0,
                    total_blocks: total,
                    bytes: 0,
                    error: None,
                    output_dir: Some(request.output_dir.clone()),
                    finished_at: None,
                }),
            },
        );
    }

    std::fs::create_dir_all(&output)
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "无法创建输出目录").with_cause(err))?;

    let book_hash = request.book_hash.clone();
    // 任务的取消旗标经 app.state 与命令侧共享;状态条目留在注册表里供轮询。
    tauri::async_runtime::spawn(async move {
        run_export(app, book_hash, request).await;
    });
    Ok(TtsExportStartResponse {
        total_blocks: total,
    })
}

#[tauri::command(rename = "tts.export.status")]
pub async fn tts_export_status(
    state: tauri::State<'_, TtsExportState>,
    request: TtsExportStatusRequest,
) -> Result<TtsExportStatusResponse, AppError> {
    let tasks = state.tasks.lock().await;
    let entries = tasks
        .iter()
        .filter(|(hash, _)| {
            request
                .book_hash
                .as_ref()
                .map(|want| want == *hash)
                .unwrap_or(true)
        })
        .map(|(hash, task)| TtsExportTaskEntry {
            book_hash: hash.clone(),
            status: snapshot_status(task),
        })
        .collect();
    Ok(TtsExportStatusResponse { tasks: entries })
}

#[tauri::command(rename = "tts.export.cancel")]
pub async fn tts_export_cancel(
    state: tauri::State<'_, TtsExportState>,
    request: TtsExportCancelRequest,
) -> Result<TtsExportCancelResponse, AppError> {
    let tasks = state.tasks.lock().await;
    let cancelled = match tasks.get(&request.book_hash) {
        Some(task) => {
            task.flag.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    };
    Ok(TtsExportCancelResponse { cancelled })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chapter_file_names_are_safe_and_ordered() {
        assert_eq!(chapter_file_name(1, "第一章 灯"), "ch01-第一章 灯.mp3");
        assert_eq!(chapter_file_name(3, "a/b:c*d?"), "ch03-a b c d.mp3");
        // 控制字符与超长标题:截到 60 字符,空标题回退。
        let long = "章".repeat(80);
        let name = chapter_file_name(12, &long);
        let inner = name.trim_start_matches("ch12-").trim_end_matches(".mp3");
        assert_eq!(inner.chars().count(), 60);
        assert_eq!(chapter_file_name(2, "   "), "ch02-未命名.mp3");
        assert_eq!(chapter_file_name(100, "第百章"), "ch100-第百章.mp3");
    }

    #[test]
    fn df_output_parses_to_available_bytes() {
        let output = "Filesystem 1024-blocks Used Available Capacity Mounted on\n\
                      /dev/disk1s1 482456720 402113440 80343280 84% /\n";
        assert_eq!(parse_df_available(output), Some(80_343_280 * 1024));
        assert_eq!(parse_df_available("no mount lines"), None);
    }

    #[test]
    fn estimate_scales_with_characters() {
        let chapters = vec![TtsExportChapter {
            index: 1,
            title: "一".into(),
            blocks: vec!["12345".into(), "678".into()],
        }];
        assert_eq!(estimate_bytes(&chapters), 8 * ESTIMATED_BYTES_PER_CHAR);
    }

    #[test]
    fn requests_carry_the_wire_shape() {
        // deny_unknown_fields:前端多传一个字段就是协议错误,不是静默忽略。
        let raw = serde_json::json!({
            "bookHash": "abc", "title": "书", "engine": "edge",
            "voice": "zh-CN-XiaoxiaoNeural", "outputDir": "/tmp/x",
            "chapters": [{ "index": 0, "title": "一", "blocks": ["句子。"] }]
        });
        let parsed: TtsExportStartRequest = serde_json::from_value(raw).expect("parses");
        assert_eq!(parsed.chapters[0].blocks[0], "句子。");
        assert!(matches!(parsed.engine, TtsExportEngine::Edge));
    }

    #[test]
    fn validation_rejects_empty_voice_and_cloud_without_config() {
        let base = TtsExportStartRequest {
            book_hash: "abc".into(),
            title: "书".into(),
            author: None,
            engine: TtsExportEngine::Edge,
            config_id: None,
            voice: "v".into(),
            speed: None,
            output_dir: "/tmp/x".into(),
            chapters: vec![TtsExportChapter {
                index: 0,
                title: "一".into(),
                blocks: vec!["句子。".into()],
            }],
        };
        let empty_voice = TtsExportStartRequest {
            voice: "  ".into(),
            ..base.clone()
        };
        assert!(validate_request(&empty_voice).is_err());
        let no_chapters = TtsExportStartRequest {
            chapters: vec![],
            ..base.clone()
        };
        assert!(validate_request(&no_chapters).is_err());
        let cloud_no_config = TtsExportStartRequest {
            engine: TtsExportEngine::Cloud,
            ..base.clone()
        };
        assert!(validate_request(&cloud_no_config).is_err());
        let bad_speed = TtsExportStartRequest {
            engine: TtsExportEngine::Cloud,
            config_id: Some("c".into()),
            speed: Some(9.0),
            ..base
        };
        assert!(validate_request(&bad_speed).is_err());
    }
}
