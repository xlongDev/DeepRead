//! 有声书导出(ADR-0009 / plan B8)。
//!
//! 合成循环在 Rust(整书音频不过 IPC):前端用与听书同一套分块逻辑
//! (reader-core 的 `buildSpeechUnits`)产出块清单一次交付,这里逐块走
//! edge/provider 两条既有合成路径 —— 两者都落 `tts-cache/`,所以**听过的
//! 句子导出秒过,中断续跑天然免费**(缓存命中即跳过合成)。输出 = 用户选定
//! 目录下的 `chNN-章节名.mp3`(MP3 帧拼接即合法流,头部带 ID3v2.3 标签:
//! 书名/作者/章节/轨号;逐章原子提交:.part 写满才改名)+ `manifest.json`。m4b 不做(需要 ffmpeg,违反依赖纪律,见 ADR-0009)。
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

/// 文件系统安全的名字:非法字符换空格、压空白、截 60 字符(章节文件与
/// 书文件夹共用同一套清洗)。
fn sanitize_name(title: &str) -> String {
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
    if cleaned.is_empty() {
        "未命名".to_string()
    } else {
        cleaned.to_string()
    }
}

/// 章文件名:`chNN-章节名.mp3`(书名在书文件夹与 ID3 专辑上,文件名只管排序)。
pub fn chapter_file_name(index: u32, title: &str) -> String {
    format!("ch{index:02}-{}.mp3", sanitize_name(title))
}

/// 书文件夹名 = 清洗后的书名;同书重导(文件夹里 manifest 的 bookHash 一致或
/// 尚无 manifest)沿用原文件夹续跑,异书撞名才加 hash 前 6 位分家。
fn book_folder_name(title: &str, book_hash: &str, existing_manifest: Option<&str>) -> String {
    let base = sanitize_name(title);
    let same_book = existing_manifest
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|manifest| {
            manifest
                .get("bookHash")
                .and_then(|v| v.as_str())
                .map(|s| s == book_hash)
        })
        .unwrap_or(false);
    if same_book || existing_manifest.is_none() {
        base
    } else {
        let take = book_hash.chars().count().min(6);
        let suffix: String = book_hash.chars().take(take).collect();
        format!("{base} ({suffix})")
    }
}

/// 纯标点/符号块读不出声 —— Edge 对这类文本不返回音频,重试无济于事,
/// 导出时直接跳过(成片中它本来就是留白)。
pub fn pronounceable(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

/// ID3v2.3 文本帧:UTF-16LE + BOM 编码。v2.3 帧长是普通 32 位大端,
/// 只有头部长度用 syncsafe(每字节 7 位)。
fn id3_text_frame(id: &str, value: &str) -> Vec<u8> {
    let mut payload = vec![0x01, 0xFF, 0xFE];
    for unit in value.encode_utf16() {
        payload.extend_from_slice(&unit.to_le_bytes());
    }
    payload.extend_from_slice(&[0x00, 0x00]);
    let mut frame = Vec::with_capacity(10 + payload.len());
    frame.extend_from_slice(id.as_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&[0x00, 0x00]);
    frame.extend_from_slice(&payload);
    frame
}

/// 章节文件头部的 ID3v2.3 标签(TIT2 章节 / TALB 书名 / TPE1 作者 / TRCK 轨号),
/// 播放器按书归组显示而不是裸文件名。空值帧整个省掉。MP3 = 帧流,
/// ID3 前缀不破坏合法性。
pub fn id3_tag(book: &str, author: Option<&str>, chapter: &str, track: u32, total: u32) -> Vec<u8> {
    let values = [
        ("TIT2", chapter.to_string()),
        ("TALB", book.to_string()),
        ("TPE1", author.unwrap_or("").to_string()),
        ("TRCK", format!("{track}/{total}")),
    ];
    let mut body = Vec::new();
    for (id, value) in values {
        if !value.trim().is_empty() {
            body.extend_from_slice(&id3_text_frame(id, &value));
        }
    }
    let mut tag = Vec::with_capacity(10 + body.len());
    tag.extend_from_slice(b"ID3\x03\x00\x00");
    tag.push(((body.len() >> 21) & 0x7f) as u8);
    tag.push(((body.len() >> 14) & 0x7f) as u8);
    tag.push(((body.len() >> 7) & 0x7f) as u8);
    tag.push((body.len() & 0x7f) as u8);
    tag.extend_from_slice(&body);
    tag
}

/// 续跑的旧章(本功能之前导出)没有标签:文件不以 ID3 开头就在头部补一个。
/// 整文件重写(MB 级 IO),命中即原样返回。
fn retag_if_needed(path: &Path, tag: &[u8]) -> std::io::Result<()> {
    use std::io::{Read, Write};
    let mut head = [0u8; 3];
    let read = std::fs::File::open(path)?.read(&mut head)?;
    if read == 3 && head == *b"ID3" {
        return Ok(());
    }
    let existing = std::fs::read(path)?;
    let temp = path.with_extension("retag.part");
    {
        let mut out = std::fs::File::create(&temp)?;
        out.write_all(tag)?;
        out.write_all(&existing)?;
    }
    std::fs::rename(&temp, path)
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
    // 书文件夹:选中的目录下按书名再落一层,多本书不再混一地。异书撞名
    // (文件夹里 manifest 的 bookHash 不同)才加 hash 后缀分家,同书重导
    // 沿用原文件夹续跑。
    let existing_manifest = std::fs::read_to_string(
        output
            .join(sanitize_name(&request.title))
            .join("manifest.json"),
    )
    .ok();
    let book_dir = output.join(book_folder_name(
        &request.title,
        &book_hash,
        existing_manifest.as_deref(),
    ));
    if let Err(err) = std::fs::create_dir_all(&book_dir) {
        finish(
            state,
            &book_hash,
            TtsExportPhase::Error,
            Some(format!("无法创建书文件夹 {}:{err}", book_dir.display())),
        )
        .await;
        return;
    }
    // 状态里的 output_dir 从所选目录改为真实落盘的书文件夹,通知行直接可定位。
    update_status(state, &book_hash, |status| {
        status.output_dir = Some(book_dir.display().to_string())
    })
    .await;
    let mut bytes_total: u64 = 0;
    let mut manifest_chapters: Vec<serde_json::Value> = Vec::new();

    for (position, chapter) in request.chapters.iter().enumerate() {
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
        let final_path = book_dir.join(&file_name);
        let tag = id3_tag(
            &request.title,
            request.author.as_deref(),
            &chapter.title,
            (position + 1) as u32,
            request.chapters.len() as u32,
        );
        let chapter_bytes = if final_path.exists() {
            // 续跑:上一轮已提交的章按现稿计,不再重合成;旧文件缺标签就补上。
            if let Err(err) = retag_if_needed(&final_path, &tag) {
                finish(
                    state,
                    &book_hash,
                    TtsExportPhase::Error,
                    Some(format!("补写章节标签失败:{err}")),
                )
                .await;
                return;
            }
            std::fs::metadata(&final_path)
                .map(|meta| meta.len())
                .unwrap_or(0)
        } else {
            let part_path = book_dir.join(format!("{file_name}.part"));
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
            // 标签打头:小于 BufWriter 缓冲,write 只进内存必成;磁盘真坏了
            // 音频写入会再次报错走既有 chapter_failed 路径。
            let _ = std::io::Write::write_all(&mut out, &tag);
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
                if block.trim().is_empty() || !pronounceable(block) {
                    update_status(state, &book_hash, |status| status.block = (done + 1) as u32)
                        .await;
                    continue;
                }
                let mut audio = None;
                let mut last_error: Option<AppError> = None;
                let mut block_cancelled = false;
                for attempt in 0..3 {
                    match synthesize_block(&app, &base, &request, block).await {
                        Ok(bytes) => {
                            audio = Some(bytes);
                            break;
                        }
                        Err(err) => {
                            last_error = Some(err);
                            // Edge 免费端点对整书突发会抖:退避再试,零间隔连打只会连败。
                            if attempt + 1 < 3 {
                                // 取消旗标在重试空档同样生效:退避 + 再合成的
                                // 空档里被点取消,不该等下一次网络往返才看见。
                                let cancelled = state
                                    .tasks
                                    .lock()
                                    .await
                                    .get(&book_hash)
                                    .map(|task| task.flag.load(Ordering::Relaxed))
                                    .unwrap_or(false);
                                if cancelled {
                                    block_cancelled = true;
                                    break;
                                }
                                let backoff = if attempt == 0 { 1 } else { 3 };
                                tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                                let cancelled = state
                                    .tasks
                                    .lock()
                                    .await
                                    .get(&book_hash)
                                    .map(|task| task.flag.load(Ordering::Relaxed))
                                    .unwrap_or(false);
                                if cancelled {
                                    block_cancelled = true;
                                    break;
                                }
                            }
                        }
                    }
                }
                if block_cancelled {
                    // 与块间取消同待遇:终态落 Cancelled,.part 留盘无害。
                    finish(state, &book_hash, TtsExportPhase::Cancelled, None).await;
                    return;
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
        // 书文件夹的归属判据:同书名异书导出时靠它分家。
        "bookHash": book_hash,
        "book": { "title": request.title, "author": request.author },
        "engine": request.engine,
        "voice": request.voice,
        "speed": request.speed.unwrap_or(1.0),
        "createdAt": crate::timestamps::rfc3339_now(),
        "chapters": manifest_chapters,
    });
    let manifest_path = book_dir.join("manifest.json");
    let temp = book_dir.join("manifest.json.part");
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
    fn punctuation_only_blocks_are_not_pronounceable() {
        assert!(!pronounceable("——"));
        assert!(!pronounceable("……"));
        assert!(!pronounceable("　"));
        assert!(pronounceable("第496—499页。"));
        assert!(pronounceable("单纯的概率计算其实是非常简单的。"));
    }

    /// 解出文本帧内容(0x01 旗标 + BOM + UTF-16LE + 终止符)。
    fn decode_text_frame(payload: &[u8]) -> String {
        assert_eq!(payload[0], 0x01, "UTF-16 编码旗标");
        assert_eq!(&payload[1..3], &[0xFF, 0xFE], "BOM");
        let units: Vec<u16> = payload[3..payload.len() - 2]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        String::from_utf16(&units).unwrap()
    }

    /// 走完全部帧,锁定头部 syncsafe 尺寸与帧边界。
    fn walk_frames(tag: &[u8]) -> Vec<(String, String)> {
        assert_eq!(&tag[..5], b"ID3\x03\x00", "v2.3 头");
        let size = ((tag[6] as usize) << 21)
            | ((tag[7] as usize) << 14)
            | ((tag[8] as usize) << 7)
            | (tag[9] as usize);
        assert_eq!(size, tag.len() - 10, "头部尺寸与实际一致");
        let mut frames = Vec::new();
        let mut pos = 10;
        while pos + 10 <= tag.len() {
            let id = std::str::from_utf8(&tag[pos..pos + 4]).unwrap().to_string();
            let len = u32::from_be_bytes(tag[pos + 4..pos + 8].try_into().unwrap()) as usize;
            frames.push((id, decode_text_frame(&tag[pos + 10..pos + 10 + len])));
            pos += 10 + len;
        }
        assert_eq!(pos, tag.len(), "帧走完应正好到标签尾");
        frames
    }

    #[test]
    fn id3_tag_carries_book_author_and_track() {
        let tag = id3_tag("刘嘉概率论通识讲义", Some("刘嘉"), "第1章", 1, 20);
        let frames = walk_frames(&tag);
        let get = |id: &str| frames.iter().find(|(k, _)| k == id).map(|(_, v)| v.clone());
        assert_eq!(get("TIT2").as_deref(), Some("第1章"));
        assert_eq!(get("TALB").as_deref(), Some("刘嘉概率论通识讲义"));
        assert_eq!(get("TPE1").as_deref(), Some("刘嘉"));
        assert_eq!(get("TRCK").as_deref(), Some("1/20"));
        // 作者缺位:TPE1 帧整个省掉,不写空值
        let no_author = id3_tag("书", None, "一", 1, 2);
        assert!(walk_frames(&no_author).iter().all(|(k, _)| k != "TPE1"));
    }

    #[test]
    fn retag_prepends_only_once() {
        let dir = std::env::temp_dir().join(format!("deepread-retag-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ch00-x.mp3");
        std::fs::write(&path, b"\xff\xfb\x90\x00audio-bytes").unwrap();
        let tag = id3_tag("书", None, "第一章", 1, 1);
        retag_if_needed(&path, &tag).unwrap();
        let tagged = std::fs::read(&path).unwrap();
        assert!(tagged.starts_with(b"ID3"));
        assert!(tagged.ends_with(b"audio-bytes"), "原音频一字不动跟在标签后");
        retag_if_needed(&path, &tag).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), tagged, "已带标签不再重复加");
        std::fs::remove_dir_all(&dir).unwrap();
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

#[test]
fn book_folders_derive_from_title_and_split_on_collision() {
    // 无 manifest(新目录/中断过没写到 manifest)→ 纯书名,续跑落在原地。
    assert_eq!(
        book_folder_name("刘嘉概率论通识讲义", "abc123def", None),
        "刘嘉概率论通识讲义"
    );
    // 同书重导(manifest 同 hash)→ 沿用原文件夹,不换地方。
    assert_eq!(
        book_folder_name("书", "abc123def", Some(r#"{"bookHash":"abc123def"}"#)),
        "书"
    );
    // 异书撞名 → hash 前 6 位分家。
    assert_eq!(
        book_folder_name("书", "deadbeefcafe", Some(r#"{"bookHash":"abc123def"}"#)),
        "书 (deadbe)"
    );
    // 清洗规则与章节文件名同源:非法字符、空标题。
    assert_eq!(book_folder_name("a/b:c", "h1", None), "a b c");
    assert_eq!(book_folder_name("  ", "h1", None), "未命名");
}
