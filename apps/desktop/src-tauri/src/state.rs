//! Per-book reader state (progress + annotations + bookmarks), persisted in
//! SQLite via a transaction on `reader.state.set`. Legacy per-hash JSON files
//! are imported once by `storage::import_legacy`.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{AppError, ErrorCode};

pub const MAX_ANNOTATIONS: usize = 10_000;

pub fn is_book_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn validate_hash(hash: &str) -> Result<(), AppError> {
    if is_book_hash(hash) {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::SystemValidation,
            "book hash must be a sha-256 hex digest",
        )
        .with_context("field", "bookHash"))
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StoredProgress {
    pub cfi: String,
    pub fraction: f64,
}

/// 划线样式:预迁移行(v7 及更早)没有这一列,读出来统一当背景高亮。
/// 取值集合由前端墨水行和三处渲染路径共同约定:highlight / underline / squiggly。
pub fn default_annotation_style() -> String {
    "highlight".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StoredAnnotation {
    pub id: String,
    pub cfi: String,
    pub color: String,
    #[serde(default = "default_annotation_style")]
    pub style: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    /// Record-level merge timestamp (sync §51); None for pre-v3 rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Tombstone: the record was deleted here and must not resurrect on merge.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StoredBookmark {
    pub id: String,
    pub cfi: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Default, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReaderState {
    #[serde(default)]
    pub progress: Option<StoredProgress>,
    #[serde(default)]
    pub annotations: Vec<StoredAnnotation>,
    #[serde(default)]
    pub bookmarks: Vec<StoredBookmark>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateGetRequest {
    pub book_hash: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StateGetResponse {
    pub state: Option<ReaderState>,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateSetRequest {
    pub book_hash: String,
    pub state: ReaderState,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StateSetResponse {
    pub saved_at: String,
}

/// 读回某本书的全部批注(rowid 序)。load_state 与 store_state 的
/// 「没变就不重写」判定共用同一读取路径,比较口径天然一致。
fn read_annotations(conn: &Connection, hash: &str) -> Result<Vec<StoredAnnotation>, AppError> {
    let mut statement = conn
        .prepare("SELECT id, cfi, color, style, note, excerpt, updated_at, deleted FROM annotations WHERE book_hash = ?1 ORDER BY rowid")
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to query annotations").with_cause(err))?;
    let annotations = statement
        .query_map([hash], |row| {
            Ok(StoredAnnotation {
                id: row.get(0)?,
                cfi: row.get(1)?,
                color: row.get(2)?,
                // 迁移前的行 style 为空串,归一回 highlight(渲染层同样只认三种)。
                style: {
                    let style: String = row.get(3)?;
                    if style.is_empty() {
                        default_annotation_style()
                    } else {
                        style
                    }
                },
                note: row.get(4)?,
                excerpt: row.get(5)?,
                updated_at: row.get(6)?,
                deleted: row.get(7)?,
            })
        })
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read annotations").with_cause(err)
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read annotation row").with_cause(err)
        })?;
    Ok(annotations)
}

fn read_bookmarks(conn: &Connection, hash: &str) -> Result<Vec<StoredBookmark>, AppError> {
    let mut statement = conn
        .prepare("SELECT id, cfi, label, created_at, deleted FROM bookmarks WHERE book_hash = ?1 ORDER BY created_at, rowid")
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to query bookmarks").with_cause(err))?;
    let bookmarks = statement
        .query_map([hash], |row| {
            Ok(StoredBookmark {
                id: row.get(0)?,
                cfi: row.get(1)?,
                label: row.get(2)?,
                created_at: row.get(3)?,
                deleted: row.get(4)?,
            })
        })
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read bookmarks").with_cause(err)
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read bookmark row").with_cause(err)
        })?;
    Ok(bookmarks)
}

pub fn load_state(conn: &Connection, hash: &str) -> Result<Option<ReaderState>, AppError> {
    validate_hash(hash)?;
    let progress = conn
        .query_row(
            "SELECT cfi, fraction, updated_at FROM progress WHERE book_hash = ?1",
            [hash],
            |row| {
                Ok(StoredProgress {
                    cfi: row.get(0)?,
                    fraction: row.get(1)?,
                })
            },
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(
                AppError::new(ErrorCode::StorageIo, "failed to read progress").with_cause(other),
            ),
        })?;

    let annotations = read_annotations(conn, hash)?;
    let bookmarks = read_bookmarks(conn, hash)?;

    if progress.is_none() && annotations.is_empty() && bookmarks.is_empty() {
        return Ok(None);
    }
    let updated_at = conn
        .query_row(
            "SELECT updated_at FROM progress WHERE book_hash = ?1",
            [hash],
            |row| row.get(0),
        )
        .unwrap_or_default();

    Ok(Some(ReaderState {
        progress,
        annotations,
        bookmarks,
        updated_at,
    }))
}

pub fn store_state(conn: &Connection, hash: &str, state: &ReaderState) -> Result<(), AppError> {
    validate_hash(hash)?;
    if state.annotations.len() > MAX_ANNOTATIONS {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "too many annotations",
        ));
    }
    // 批注/书签没变就不重写:阅读中高频保存的只有进度(15s 一次),
    // 全量 DELETE+INSERT 会成倍放大 WAL 写。比较用与读取同一路径的内存快照,
    // 顺序不一致按「变了」处理(重写是正确路径,只是不省)。
    let annotations_changed = read_annotations(conn, hash)? != state.annotations;
    let bookmarks_changed = read_bookmarks(conn, hash)? != state.bookmarks;
    let tx = conn.unchecked_transaction().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to begin transaction").with_cause(err)
    })?;
    tx.execute("DELETE FROM progress WHERE book_hash = ?1", [hash])
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to reset progress").with_cause(err)
        })?;
    if annotations_changed {
        tx.execute("DELETE FROM annotations WHERE book_hash = ?1", [hash])
            .map_err(|err| {
                AppError::new(ErrorCode::StorageIo, "failed to reset annotations").with_cause(err)
            })?;
    }
    if bookmarks_changed {
        tx.execute("DELETE FROM bookmarks WHERE book_hash = ?1", [hash])
            .map_err(|err| {
                AppError::new(ErrorCode::StorageIo, "failed to reset bookmarks").with_cause(err)
            })?;
    }

    if let Some(progress) = &state.progress {
        tx.execute(
            "INSERT INTO progress (book_hash, cfi, fraction, updated_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![hash, progress.cfi, progress.fraction, state.updated_at],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to save progress").with_cause(err)
        })?;
        // 读完盖章:进度第一次到 100% 时记下这一刻 —— 年度目标按它数"今年读完
        // 几本"。只盖一次(WHERE finished_at IS NULL):回头重读、手动改进度都不
        // 改写完成时间;books 行不存在时这条 UPDATE 匹配 0 行,静默通过。
        if progress.fraction >= 1.0 {
            tx.execute(
                "UPDATE books SET finished_at = ?2 WHERE hash = ?1 AND finished_at IS NULL",
                rusqlite::params![hash, state.updated_at],
            )
            .map_err(|err| {
                AppError::new(ErrorCode::StorageIo, "failed to stamp finish time").with_cause(err)
            })?;
        }
    }
    if annotations_changed {
        for annotation in &state.annotations {
            tx.execute(
                "INSERT INTO annotations (id, book_hash, cfi, color, style, note, excerpt, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    annotation.id,
                    hash,
                    annotation.cfi,
                    annotation.color,
                    annotation.style,
                    annotation.note,
                    annotation.excerpt,
                    annotation.updated_at,
                    annotation.deleted
                ],
            )
            .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to save annotation").with_cause(err))?;
        }
    }
    if bookmarks_changed {
        for bookmark in &state.bookmarks {
            tx.execute(
                "INSERT INTO bookmarks (id, book_hash, cfi, label, created_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    bookmark.id,
                    hash,
                    bookmark.cfi,
                    bookmark.label,
                    bookmark.created_at,
                    bookmark.deleted
                ],
            )
            .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to save bookmark").with_cause(err))?;
        }
    }
    tx.commit().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to commit reader state").with_cause(err)
    })
}

#[tauri::command(rename = "reader.state.get")]
pub fn reader_state_get(
    db: tauri::State<'_, crate::storage::Db>,
    request: StateGetRequest,
) -> Result<StateGetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(StateGetResponse {
        state: load_state(&conn, &request.book_hash)?,
    })
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReaderStateGetAllResponse {
    /// `bookHash → state`;只含有状态的书 —— 没有进度/批注/书签的书不占键。
    pub states: std::collections::HashMap<String, ReaderState>,
}

/// 跨书聚合全部阅读状态(B3 批量同步):一次 IPC 替代同步引擎对每本书的
/// `reader.state.get`。三张表 UNION 出有状态的 hash,再逐个走 `load_state`
/// —— 复用同一套校验与行装配,量级(个人书库)下足够快。
pub fn load_all_states(
    conn: &Connection,
) -> Result<std::collections::HashMap<String, ReaderState>, AppError> {
    let mut statement = conn
        .prepare(
            "SELECT DISTINCT book_hash FROM progress
             UNION SELECT DISTINCT book_hash FROM annotations
             UNION SELECT DISTINCT book_hash FROM bookmarks",
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to query state hashes").with_cause(err)
        })?;
    let hashes = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read state hashes").with_cause(err)
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read state hash").with_cause(err)
        })?;
    let mut states = std::collections::HashMap::with_capacity(hashes.len());
    for hash in hashes {
        if let Some(state) = load_state(conn, &hash)? {
            states.insert(hash, state);
        }
    }
    Ok(states)
}

#[tauri::command(rename = "reader.state.getAll")]
pub fn reader_state_get_all(
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<ReaderStateGetAllResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(ReaderStateGetAllResponse {
        states: load_all_states(&conn)?,
    })
}

#[tauri::command(rename = "reader.state.set")]
pub fn reader_state_set(
    db: tauri::State<'_, crate::storage::Db>,
    request: StateSetRequest,
) -> Result<StateSetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    store_state(&conn, &request.book_hash, &request.state)?;
    Ok(StateSetResponse {
        saved_at: crate::timestamps::rfc3339_now(),
    })
}

/* ---------- Reading stats ----------
The frontend owns the clock (it knows when the reader is really on screen)
and reports deltas; this side only accumulates them per local day. */

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    pub day: String,
    pub seconds: u64,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatsAddRequest {
    pub book_hash: String,
    /// Local calendar day, `YYYY-MM-DD`.
    pub day: String,
    pub seconds: u64,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StatsAddResponse {
    /// Total for that book on that day after the update.
    pub day_seconds: u64,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StatsGetResponse {
    /// Newest first.
    pub days: Vec<DayStat>,
    pub total_seconds: u64,
}

/// A day key must be a plain calendar date; anything else would make "today"
/// unqueryable and could grow the table without bound.
fn validate_day(day: &str) -> Result<(), AppError> {
    let bytes = day.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());
    if shaped {
        Ok(())
    } else {
        Err(
            AppError::new(ErrorCode::SystemValidation, "day must be YYYY-MM-DD")
                .with_context("field", "day"),
        )
    }
}

/// Cap per report: the frontend flushes every 30s, so anything larger than an
/// hour means a clock jump (sleep/resume) rather than real reading.
const MAX_REPORTED_SECONDS: u64 = 3600;

pub fn add_reading_seconds(
    conn: &Connection,
    hash: &str,
    day: &str,
    seconds: u64,
) -> Result<u64, AppError> {
    validate_hash(hash)?;
    validate_day(day)?;
    let seconds = seconds.min(MAX_REPORTED_SECONDS);
    conn.execute(
        "INSERT INTO reading_stats (book_hash, day, seconds) VALUES (?1, ?2, ?3)
         ON CONFLICT (book_hash, day) DO UPDATE SET seconds = seconds + excluded.seconds",
        rusqlite::params![hash, day, seconds as i64],
    )
    .map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to record reading time").with_cause(err)
    })?;
    load_day_seconds(conn, hash, day)
}

fn load_day_seconds(conn: &Connection, hash: &str, day: &str) -> Result<u64, AppError> {
    conn.query_row(
        "SELECT seconds FROM reading_stats WHERE book_hash = ?1 AND day = ?2",
        rusqlite::params![hash, day],
        |row| row.get::<_, i64>(0),
    )
    .map(|seconds| seconds.max(0) as u64)
    .map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to read reading time").with_cause(err)
    })
}

/// Per-day totals across all books, newest first. `limit_days` keeps the
/// payload bounded (the UI shows a week plus a streak).
pub fn load_reading_stats(
    conn: &Connection,
    limit_days: u32,
) -> Result<StatsGetResponse, AppError> {
    let mut statement = conn
        .prepare(
            "SELECT day, SUM(seconds) FROM reading_stats
             GROUP BY day ORDER BY day DESC LIMIT ?1",
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to prepare stats query").with_cause(err)
        })?;
    let rows = statement
        .query_map([limit_days], |row| {
            Ok(DayStat {
                day: row.get(0)?,
                seconds: row.get::<_, i64>(1)?.max(0) as u64,
            })
        })
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read stats").with_cause(err)
        })?;
    let mut days = Vec::new();
    for row in rows {
        days.push(row.map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read stats row").with_cause(err)
        })?);
    }
    let total_seconds = conn
        .query_row(
            "SELECT COALESCE(SUM(seconds), 0) FROM reading_stats",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|total| total.max(0) as u64)
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to total reading time").with_cause(err)
        })?;
    Ok(StatsGetResponse {
        days,
        total_seconds,
    })
}

#[tauri::command(rename = "reader.stats.add")]
pub fn reader_stats_add(
    db: tauri::State<'_, crate::storage::Db>,
    request: StatsAddRequest,
) -> Result<StatsAddResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(StatsAddResponse {
        day_seconds: add_reading_seconds(&conn, &request.book_hash, &request.day, request.seconds)?,
    })
}

/// 一条跨书聚合的批注:笔记页要知道「哪本书的哪句话」,所以标题的两个来源
/// 都给出去 —— 文件名清洗规则属于前端(`cleanBookTitle`),Rust 不猜。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    pub id: String,
    pub book_hash: String,
    pub display_name: Option<String>,
    pub file_name: String,
    pub cfi: String,
    pub color: String,
    pub note: Option<String>,
    pub excerpt: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NotesListResponse {
    pub notes: Vec<NoteEntry>,
}

/// 跨书批注聚合:只取未删除的,新→旧,没有时间戳的沉底。
///
/// 书签刻意不在里面 —— 这条路给的是"有内容的批注",书签没有正文可展示,
/// 混进来只会让笔记页多一半空行。
// ponytail: 一次全取 + LIMIT,超过这个量级再谈分页。
pub fn list_notes(conn: &Connection) -> Result<Vec<NoteEntry>, AppError> {
    const MAX_NOTES: usize = 2000;
    let mut statement = conn
        .prepare(
            "SELECT a.id, a.book_hash, b.display_name, b.file_name, a.cfi, a.color,
                    a.note, a.excerpt, a.updated_at
             FROM annotations a
             JOIN books b ON b.hash = a.book_hash
             WHERE a.deleted = 0
             ORDER BY a.updated_at IS NULL, a.updated_at DESC, a.rowid DESC
             LIMIT ?1",
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to query notes").with_cause(err)
        })?;
    let notes = statement
        .query_map([MAX_NOTES], |row| {
            Ok(NoteEntry {
                id: row.get(0)?,
                book_hash: row.get(1)?,
                display_name: row.get(2)?,
                file_name: row.get(3)?,
                cfi: row.get(4)?,
                color: row.get(5)?,
                note: row.get(6)?,
                excerpt: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to read notes").with_cause(err))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read note row").with_cause(err)
        })?;
    Ok(notes)
}

/// 一本书累计读了多少(排行榜用)。标题两个来源都给,清洗是前端的事。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct BookReadingStat {
    pub book_hash: String,
    pub display_name: Option<String>,
    pub file_name: String,
    pub seconds: u64,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StatsBooksResponse {
    pub books: Vec<BookReadingStat>,
}

/// 按书聚合阅读时长,降序。
///
/// 只统计**还在书架上的书**(内连接 books):已经移出的书不该占着排行榜,
/// 尽管它的历史时长还留在表里(外键 CASCADE 没开,时长是显式清理的)。
pub fn list_book_stats(conn: &Connection, limit: usize) -> Result<Vec<BookReadingStat>, AppError> {
    let mut statement = conn
        .prepare(
            "SELECT b.hash, b.display_name, b.file_name, COALESCE(SUM(s.seconds), 0) AS total
             FROM reading_stats s
             JOIN books b ON b.hash = s.book_hash
             GROUP BY b.hash
             ORDER BY total DESC, b.hash ASC
             LIMIT ?1",
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to query per-book stats").with_cause(err)
        })?;
    let rows = statement
        .query_map([limit], |row| {
            Ok(BookReadingStat {
                book_hash: row.get(0)?,
                display_name: row.get(1)?,
                file_name: row.get(2)?,
                seconds: row.get::<_, i64>(3)?.max(0) as u64,
            })
        })
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read per-book stats").with_cause(err)
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read per-book stat row").with_cause(err)
        })?;
    Ok(rows)
}

#[tauri::command(rename = "reader.stats.books")]
pub fn reader_stats_books(
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<StatsBooksResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(StatsBooksResponse {
        books: list_book_stats(&conn, 20)?,
    })
}

/* ---------- Reading goals ----------
阅读目标是一组三个数字(每日时长 / 每周天数 / 年度本数),全部存在
`app_settings` KV 里:备份走 VACUUM INTO 全量快照,天然带上,不需要为这
三个数字新开表。每个键独立存取 —— 缺键 = 0 = 没设这一项,读路径统一过滤
脏值,与旧版单键 `reading.goal.dailyMinutes` 和平共处(老键继续被 dailyMinutes
读取,迁移零动作)。 */

/// `app_settings` key: daily reading goal in minutes.
pub const READING_GOAL_DAILY_KEY: &str = "reading.goal.dailyMinutes";
/// `app_settings` key: weekly reading-days goal (1…7).
pub const READING_GOAL_WEEKLY_KEY: &str = "reading.goal.weeklyDays";
/// `app_settings` key: yearly finished-books goal.
pub const READING_GOAL_YEARLY_KEY: &str = "reading.goal.yearlyBooks";

/// 上限 24h:再大就不是"每日目标"而是自罚;0 合法 = 清除目标。
const MAX_GOAL_MINUTES: u32 = 24 * 60;
const MAX_GOAL_WEEKLY_DAYS: u32 = 7;
/// 一年最多 366 天,每天一本也读不出更多;0 合法 = 清除目标。
const MAX_GOAL_YEARLY_BOOKS: u32 = 366;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReadingGoals {
    /// 每日阅读目标(分钟);0 = 没有目标。
    pub daily_minutes: u32,
    /// 每周阅读天数目标(1…7);0 = 没有目标。
    pub weekly_days: u32,
    /// 年度读完本数目标;0 = 没有目标。
    pub yearly_books: u32,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReadingGoalGetResponse {
    pub goals: ReadingGoals,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadingGoalSetRequest {
    pub goals: ReadingGoals,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReadingGoalSetResponse {
    /// 落库后的生效值(清洗过:越界/非法一律回 0)。
    pub goals: ReadingGoals,
}

/// 读出一个数字目标:存进去的值可能是旧版本遗留的非法内容,一律按"没有目标"
/// 处理,与 `tts.rs::cache_limit` 同一条规矩 —— 设置项永远有一份干净的默认值可回。
fn load_goal_minutes(conn: &Connection, key: &str, max: u32) -> u32 {
    crate::storage::get_setting(conn, key)
        .ok()
        .flatten()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|value| *value > 0 && *value <= max)
        .unwrap_or(0)
}

pub fn load_reading_goals(conn: &Connection) -> ReadingGoals {
    ReadingGoals {
        daily_minutes: load_goal_minutes(conn, READING_GOAL_DAILY_KEY, MAX_GOAL_MINUTES),
        weekly_days: load_goal_minutes(conn, READING_GOAL_WEEKLY_KEY, MAX_GOAL_WEEKLY_DAYS),
        yearly_books: load_goal_minutes(conn, READING_GOAL_YEARLY_KEY, MAX_GOAL_YEARLY_BOOKS),
    }
}

/// 0 也落库(而不是删行):读路径统一过滤,少一条 DELETE 的错处理路径。
fn save_goal_minutes(conn: &Connection, key: &str, minutes: u32, max: u32) -> Result<(), AppError> {
    if minutes > max {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            format!("goal must be between 0 and {max}"),
        )
        .with_context("field", key));
    }
    crate::storage::set_setting(conn, key, &minutes.to_string())
}

pub fn save_reading_goals(
    conn: &Connection,
    goals: &ReadingGoals,
) -> Result<ReadingGoals, AppError> {
    save_goal_minutes(
        conn,
        READING_GOAL_DAILY_KEY,
        goals.daily_minutes,
        MAX_GOAL_MINUTES,
    )?;
    save_goal_minutes(
        conn,
        READING_GOAL_WEEKLY_KEY,
        goals.weekly_days,
        MAX_GOAL_WEEKLY_DAYS,
    )?;
    save_goal_minutes(
        conn,
        READING_GOAL_YEARLY_KEY,
        goals.yearly_books,
        MAX_GOAL_YEARLY_BOOKS,
    )?;
    Ok(ReadingGoals {
        daily_minutes: goals.daily_minutes.min(MAX_GOAL_MINUTES),
        weekly_days: goals.weekly_days.min(MAX_GOAL_WEEKLY_DAYS),
        yearly_books: goals.yearly_books.min(MAX_GOAL_YEARLY_BOOKS),
    })
}

#[tauri::command(rename = "reading.goal.get")]
pub fn reading_goal_get(
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<ReadingGoalGetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(ReadingGoalGetResponse {
        goals: load_reading_goals(&conn),
    })
}

#[tauri::command(rename = "reading.goal.set")]
pub fn reading_goal_set(
    db: tauri::State<'_, crate::storage::Db>,
    request: ReadingGoalSetRequest,
) -> Result<ReadingGoalSetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(ReadingGoalSetResponse {
        goals: save_reading_goals(&conn, &request.goals)?,
    })
}

/* ---------- Chapter rules ----------
TXT 章节规则(spec §15)存在 `app_settings` KV(JSON 数组):备份走 VACUUM INTO
全量快照天然带上,零迁移。Rust 侧只做形状校验(条数/字段/长度);正则能否编译、
有无灾难性回溯风险由 ai-core 在 UI 保存前判定 —— pattern 只在 webview 里执行,
Rust 编译它没有意义,也不该为这一点引 regex 依赖。 */

/// `app_settings` key: JSON array of chapter rules.
pub const CHAPTER_RULES_KEY: &str = "chapter.rules";

const MAX_RULES_STORED: usize = 20;
const MAX_PATTERN_CHARS: usize = 200;
const MAX_NAME_CHARS: usize = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChapterRule {
    pub id: String,
    pub name: String,
    /// 正则源码;按整段(trim 后)匹配,只在 webview 执行。
    pub pattern: String,
    /// 越大越先认领一行;内置规则是 0。
    pub priority: i32,
    pub enabled: bool,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChapterRulesGetResponse {
    pub rules: Vec<ChapterRule>,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChapterRulesSetRequest {
    pub rules: Vec<ChapterRule>,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChapterRulesSetResponse {
    /// 落库后的生效规则(清洗过:形状非法的条目被剔除)。
    pub rules: Vec<ChapterRule>,
}

/// 形状校验:字段非空、pattern 不超长。正则本身的合法性在 UI 侧(ai-core)判定。
fn valid_rule_shape(rule: &ChapterRule) -> bool {
    !rule.id.trim().is_empty()
        && !rule.name.trim().is_empty()
        && rule.name.chars().count() <= MAX_NAME_CHARS
        && !rule.pattern.trim().is_empty()
        && rule.pattern.chars().count() <= MAX_PATTERN_CHARS
}

/// 读规则:旧版本遗留的脏内容(不是数组/字段缺失/超长)一律按"没有规则"处理,
/// 与 `load_reading_goals` 同一条规矩 —— 设置项永远有一份干净的默认值可回。
pub fn load_chapter_rules(conn: &Connection) -> Result<Vec<ChapterRule>, AppError> {
    let Some(raw) = crate::storage::get_setting(conn, CHAPTER_RULES_KEY)? else {
        return Ok(Vec::new());
    };
    let parsed: Vec<ChapterRule> = match serde_json::from_str(&raw) {
        Ok(rules) => rules,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(parsed
        .into_iter()
        .filter(valid_rule_shape)
        .take(MAX_RULES_STORED)
        .collect())
}

pub fn save_chapter_rules(
    conn: &Connection,
    rules: &[ChapterRule],
) -> Result<Vec<ChapterRule>, AppError> {
    let cleaned: Vec<ChapterRule> = rules
        .iter()
        .filter(|rule| valid_rule_shape(rule))
        .take(MAX_RULES_STORED)
        .cloned()
        .collect();
    let json = serde_json::to_string(&cleaned).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "serialize chapter rules").with_cause(err)
    })?;
    crate::storage::set_setting(conn, CHAPTER_RULES_KEY, &json)?;
    Ok(cleaned)
}

#[tauri::command(rename = "chapter.rules.get")]
pub fn chapter_rules_get(
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<ChapterRulesGetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(ChapterRulesGetResponse {
        rules: load_chapter_rules(&conn)?,
    })
}

#[tauri::command(rename = "chapter.rules.set")]
pub fn chapter_rules_set(
    db: tauri::State<'_, crate::storage::Db>,
    request: ChapterRulesSetRequest,
) -> Result<ChapterRulesSetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(ChapterRulesSetResponse {
        rules: save_chapter_rules(&conn, &request.rules)?,
    })
}

#[tauri::command(rename = "reader.notes.list")]
pub fn reader_notes_list(
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<NotesListResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(NotesListResponse {
        notes: list_notes(&conn)?,
    })
}

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteUpdateRequest {
    pub note_id: String,
    /// 与 noteEntrySchema 的 note 上限一致(4000 字);空串 = 清空回纯高亮。
    pub note: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdateResponse {
    pub entry: NoteEntry,
}

/// 改一条批注「自己写的那句话」,其余字段(摘录/位置/颜色)都不归它管。
///
/// 写完把这一行按 notes.list 的同一条 JOIN 读回来 —— 前端拿到的就是列表里
/// 该出现的样子,不用自己拼。
pub fn update_note(conn: &Connection, note_id: &str, note: &str) -> Result<NoteEntry, AppError> {
    const MAX_NOTE_LENGTH: usize = 4000;
    if note.chars().count() > MAX_NOTE_LENGTH {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "note text too long",
        ));
    }
    if note_id.is_empty() || note_id.len() > 128 {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "invalid note id",
        ));
    }
    let trimmed = note.trim();
    let stored: Option<String> = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };
    let updated = conn
        .execute(
            "UPDATE annotations SET note = ?1, updated_at = ?2 WHERE id = ?3 AND deleted = 0",
            rusqlite::params![stored, crate::timestamps::rfc3339_now(), note_id],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to update note").with_cause(err)
        })?;
    if updated == 0 {
        return Err(AppError::new(ErrorCode::SystemValidation, "note not found"));
    }
    let mut statement = conn
        .prepare(
            "SELECT a.id, a.book_hash, b.display_name, b.file_name, a.cfi, a.color,
                    a.note, a.excerpt, a.updated_at
             FROM annotations a
             JOIN books b ON b.hash = a.book_hash
             WHERE a.id = ?1",
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to query note").with_cause(err)
        })?;
    statement
        .query_row([note_id], |row| {
            Ok(NoteEntry {
                id: row.get(0)?,
                book_hash: row.get(1)?,
                display_name: row.get(2)?,
                file_name: row.get(3)?,
                cfi: row.get(4)?,
                color: row.get(5)?,
                note: row.get(6)?,
                excerpt: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to read note").with_cause(err))
}

#[tauri::command(rename = "reader.note.update")]
pub fn reader_note_update(
    db: tauri::State<'_, crate::storage::Db>,
    request: NoteUpdateRequest,
) -> Result<NoteUpdateResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(NoteUpdateResponse {
        entry: update_note(&conn, &request.note_id, &request.note)?,
    })
}

#[tauri::command(rename = "reader.stats.get")]
pub fn reader_stats_get(
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<StatsGetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    load_reading_stats(&conn, 400)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::storage::migrate(&conn).unwrap();
        conn
    }

    /// Reader state references books(hash); tests seed a matching book row.
    fn seed_book(conn: &Connection, hash: &str) {
        conn.execute(
            "INSERT INTO books (hash, file_name, format, path, size, added_at) VALUES (?1, 't', 'epub', '/p', 1, '2026-09-09T00:00:00Z')",
            [hash],
        )
        .unwrap();
    }

    fn sample() -> ReaderState {
        ReaderState {
            progress: Some(StoredProgress {
                cfi: "epubcfi(/6/4)".into(),
                fraction: 0.42,
            }),
            annotations: vec![StoredAnnotation {
                id: "a1".into(),
                cfi: "epubcfi(/6/4!2/2)".into(),
                color: "#f5d76e".into(),
                style: "highlight".into(),
                note: None,
                excerpt: Some("被高亮的句子".into()),
                updated_at: Some("2026-09-09T00:00:00Z".into()),
                deleted: false,
            }],
            bookmarks: vec![StoredBookmark {
                id: "bm1".into(),
                cfi: "epubcfi(/6/4)".into(),
                label: Some("第一章".into()),
                created_at: "2026-09-09T00:00:00Z".into(),
                deleted: false,
            }],
            updated_at: "2026-09-09T00:00:00Z".into(),
        }
    }

    #[test]
    fn store_state_skips_rewrite_when_annotations_and_bookmarks_unchanged() {
        let conn = memory_db();
        let hash = "c".repeat(64);
        seed_book(&conn, &hash);

        let mut state = sample();
        store_state(&conn, &hash, &state).unwrap();
        // 只推进进度(阅读中 15s 一次的就是这种保存):批注/书签原样保留,
        // 分离写的意义就在这 —— 以前这次保存会 DELETE+重插全部划线。
        state.progress = Some(StoredProgress {
            cfi: "epubcfi(/6/6)".into(),
            fraction: 0.57,
        });
        state.updated_at = "2026-09-09T00:05:00Z".into();
        store_state(&conn, &hash, &state).unwrap();
        let reloaded = load_state(&conn, &hash).unwrap().unwrap();
        assert_eq!(reloaded.annotations, state.annotations);
        assert_eq!(reloaded.bookmarks, state.bookmarks);
        assert_eq!(reloaded.progress.as_ref().unwrap().fraction, 0.57);

        // 批注真变了(改 note):必须如实落库,省写不能吞掉变化。
        state.annotations[0].note = Some("AI 解释已写入".into());
        store_state(&conn, &hash, &state).unwrap();
        let reloaded = load_state(&conn, &hash).unwrap().unwrap();
        assert_eq!(
            reloaded.annotations[0].note.as_deref(),
            Some("AI 解释已写入")
        );
    }

    #[test]
    fn per_book_stats_aggregate_across_days_and_rank_by_total() {
        let conn = memory_db();
        let first = "a".repeat(64);
        let second = "b".repeat(64);
        seed_book(&conn, &first);
        seed_book(&conn, &second);
        conn.execute(
            "UPDATE books SET display_name = '夜航书' WHERE hash = ?1",
            [&first],
        )
        .unwrap();

        // 第一本跨两天共 90 分钟,第二本一天 30 分钟 —— 聚合必须跨天累加。
        add_reading_seconds(&conn, &first, "2026-09-27", 3600).unwrap();
        add_reading_seconds(&conn, &first, "2026-09-28", 1800).unwrap();
        add_reading_seconds(&conn, &second, "2026-09-28", 1800).unwrap();

        let ranked = list_book_stats(&conn, 20).unwrap();
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].book_hash, first);
        assert_eq!(ranked[0].seconds, 5400);
        assert_eq!(ranked[0].display_name.as_deref(), Some("夜航书"));
        assert_eq!(ranked[1].seconds, 1800);
        // 第二本没有元数据标题:fileName 原样带出,回退是前端的事。
        assert_eq!(ranked[1].display_name, None);
        assert_eq!(ranked[1].file_name, "t");
    }

    #[test]
    fn per_book_stats_skip_books_gone_from_the_shelf() {
        let conn = memory_db();
        let hash = "a".repeat(64);
        seed_book(&conn, &hash);
        add_reading_seconds(&conn, &hash, "2026-09-28", 600).unwrap();
        assert_eq!(list_book_stats(&conn, 20).unwrap().len(), 1);

        // 移出书架后,它的历史时长不该再占着排行榜。
        conn.execute("DELETE FROM books WHERE hash = ?1", [&hash])
            .unwrap();
        assert!(list_book_stats(&conn, 20).unwrap().is_empty());
    }

    #[test]
    fn notes_aggregate_across_books_newest_first_and_skip_tombstones() {
        let conn = memory_db();
        let first = "a".repeat(64);
        let second = "b".repeat(64);
        seed_book(&conn, &first);
        seed_book(&conn, &second);
        conn.execute(
            "UPDATE books SET display_name = '夜航书' WHERE hash = ?1",
            [&first],
        )
        .unwrap();

        let mut state = sample();
        state.annotations = vec![
            StoredAnnotation {
                id: "a1".into(),
                cfi: "cfi-1".into(),
                color: "#f5d76e".into(),
                style: "highlight".into(),
                note: Some("我自己写的".into()),
                excerpt: Some("原文一".into()),
                updated_at: Some("2026-09-09T00:00:00Z".into()),
                deleted: false,
            },
            StoredAnnotation {
                id: "a2".into(),
                cfi: "cfi-2".into(),
                color: "#f5d76e".into(),
                style: "highlight".into(),
                note: None,
                excerpt: Some("原文二".into()),
                updated_at: Some("2026-09-10T00:00:00Z".into()),
                deleted: false,
            },
            StoredAnnotation {
                id: "a3".into(),
                cfi: "cfi-3".into(),
                color: "#f5d76e".into(),
                style: "highlight".into(),
                note: None,
                excerpt: Some("删掉的".into()),
                updated_at: Some("2026-09-11T00:00:00Z".into()),
                deleted: true,
            },
        ];
        store_state(&conn, &first, &state).unwrap();

        let mut other = sample();
        // bookmarks.id 是全局主键:两本书不能用同一个 id,而这本书不需要书签。
        other.bookmarks = vec![];
        other.annotations = vec![StoredAnnotation {
            id: "b1".into(),
            cfi: "cfi-b1".into(),
            color: "#a5d6f5".into(),
            style: "underline".into(),
            note: None,
            excerpt: Some("另一本的摘录".into()),
            updated_at: None,
            deleted: false,
        }];
        store_state(&conn, &second, &other).unwrap();

        let notes = list_notes(&conn).unwrap();
        // 新→旧,没有时间戳的沉底;被软删除的 a3 不出现。
        assert_eq!(
            notes
                .iter()
                .map(|note| note.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a2", "a1", "b1"]
        );
        // 标题原样带出两个来源:清洗是前端的事。
        assert_eq!(notes[0].display_name.as_deref(), Some("夜航书"));
        assert_eq!(notes[2].display_name, None);
        assert_eq!(notes[2].file_name, "t");
        assert_eq!(notes[0].note, None);
        assert_eq!(notes[1].note.as_deref(), Some("我自己写的"));
    }

    /// 编辑用例共用的三条批注(与聚合测试同一套种子,省一份 fixture)。
    fn seed_notes() -> Connection {
        let conn = memory_db();
        let hash = "a".repeat(64);
        seed_book(&conn, &hash);
        let mut state = sample();
        state.annotations = vec![
            StoredAnnotation {
                id: "a1".into(),
                cfi: "cfi-1".into(),
                color: "#f5d76e".into(),
                style: "highlight".into(),
                note: Some("我自己写的".into()),
                excerpt: Some("原文一".into()),
                updated_at: Some("2026-09-09T00:00:00Z".into()),
                deleted: false,
            },
            StoredAnnotation {
                id: "a3".into(),
                cfi: "cfi-3".into(),
                color: "#f5d76e".into(),
                style: "highlight".into(),
                note: None,
                excerpt: Some("删掉的".into()),
                updated_at: Some("2026-09-11T00:00:00Z".into()),
                deleted: true,
            },
        ];
        store_state(&conn, &hash, &state).unwrap();
        conn
    }

    #[test]
    fn note_update_rewrites_text_and_reads_the_row_back() {
        let conn = seed_notes();
        let entry = update_note(&conn, "a1", "  改过的话  ").unwrap();
        assert_eq!(entry.note.as_deref(), Some("改过的话"), "写入前去首尾空白");
        assert!(
            entry.updated_at.as_deref() > Some("2026-09-09T00:00:00Z"),
            "时间戳要刷新,同步靠它"
        );
        // 摘录/位置不归这条命令管。
        assert_eq!(entry.excerpt.as_deref(), Some("原文一"));
        assert_eq!(entry.cfi, "cfi-1");
        assert_eq!(entry.display_name.as_deref(), None);
    }

    #[test]
    fn note_update_clearing_text_falls_back_to_pure_highlight() {
        let conn = seed_notes();
        let entry = update_note(&conn, "a1", "   ").unwrap();
        assert_eq!(entry.note, None);
        // 软删除的批注改不到,未知 id 也一样。
        assert!(update_note(&conn, "a3", "x").is_err());
        assert!(update_note(&conn, "missing", "x").is_err());
    }

    #[test]
    fn note_update_rejects_overlong_text_and_bad_ids() {
        let conn = seed_notes();
        let too_long = "长".repeat(4001);
        assert!(update_note(&conn, "a1", &too_long).is_err());
        assert!(update_note(&conn, "", "x").is_err());
        assert!(update_note(&conn, &"i".repeat(129), "x").is_err());
        // 恰好在限内的能过。
        update_note(&conn, "a1", &"好".repeat(4000)).unwrap();
    }

    #[test]
    fn reading_time_accumulates_per_day_and_clamps_clock_jumps() {
        let conn = memory_db();
        let first = &"a".repeat(64);
        let second = &"b".repeat(64);

        assert_eq!(
            add_reading_seconds(&conn, first, "2026-09-28", 60).unwrap(),
            60
        );
        assert_eq!(
            add_reading_seconds(&conn, first, "2026-09-28", 30).unwrap(),
            90,
            "same day accumulates"
        );
        add_reading_seconds(&conn, second, "2026-09-28", 30).unwrap();
        add_reading_seconds(&conn, first, "2026-09-27", 10).unwrap();

        // A resume-after-sleep delta must not be booked as real reading.
        assert_eq!(
            add_reading_seconds(&conn, first, "2026-09-29", 99_999).unwrap(),
            MAX_REPORTED_SECONDS
        );

        let stats = load_reading_stats(&conn, 400).unwrap();
        assert_eq!(
            stats.days,
            vec![
                DayStat {
                    day: "2026-09-29".into(),
                    seconds: MAX_REPORTED_SECONDS
                },
                DayStat {
                    day: "2026-09-28".into(),
                    seconds: 120
                },
                DayStat {
                    day: "2026-09-27".into(),
                    seconds: 10
                },
            ],
            "days group across books, newest first"
        );
        assert_eq!(stats.total_seconds, 3600 + 120 + 10);
    }

    #[test]
    fn reading_time_rejects_malformed_inputs() {
        let conn = memory_db();
        let hash = &"a".repeat(64);
        assert!(add_reading_seconds(&conn, hash, "2026-9-28", 60).is_err());
        assert!(add_reading_seconds(&conn, hash, "today", 60).is_err());
        assert!(validate_day("2026-09-28").is_ok());
        assert!(add_reading_seconds(&conn, "not-a-hash", "2026-09-28", 60).is_err());
    }

    #[test]
    fn rejects_malformed_hashes_before_touching_storage() {
        assert!(validate_hash(&"a".repeat(64)).is_ok());
        assert!(validate_hash("").is_err());
        assert!(validate_hash("ABCDEF").is_err());
        assert!(validate_hash("../etc/passwd").is_err());
    }

    #[test]
    fn store_and_load_round_trip() {
        let conn = memory_db();
        let hash = &"a".repeat(64);
        seed_book(&conn, hash);
        let state = sample();
        store_state(&conn, hash, &state).unwrap();
        assert_eq!(load_state(&conn, hash).unwrap(), Some(state));
    }

    /// 年度目标靠 `books.finished_at` 数"今年读完几本":第一次到 100% 盖章,
    /// 之后重读/回退都不改写 —— 盖成"最后一次读完"会把年份算错。
    #[test]
    fn finishing_a_book_stamps_finished_at_once() {
        let conn = memory_db();
        let hash = &"e".repeat(64);
        seed_book(&conn, hash);
        let finished_at = |conn: &Connection| -> Option<String> {
            conn.query_row(
                "SELECT finished_at FROM books WHERE hash = ?1",
                [hash.as_str()],
                |row| row.get(0),
            )
            .unwrap()
        };

        let mut half = sample();
        half.progress = Some(StoredProgress {
            cfi: "epubcfi(/6/4)".into(),
            fraction: 0.5,
        });
        half.updated_at = "2026-01-02T00:00:00Z".into();
        store_state(&conn, hash, &half).unwrap();
        assert_eq!(finished_at(&conn), None);

        let mut done = sample();
        done.progress = Some(StoredProgress {
            cfi: "epubcfi(/6/999)".into(),
            fraction: 1.0,
        });
        done.updated_at = "2026-03-04T00:00:00Z".into();
        store_state(&conn, hash, &done).unwrap();
        assert_eq!(finished_at(&conn).as_deref(), Some("2026-03-04T00:00:00Z"));

        // 回头重读到 100%:完成时间保持第一次的那一刻。
        let mut again = ReaderState {
            progress: Some(StoredProgress {
                cfi: "epubcfi(/6/999)".into(),
                fraction: 1.0,
            }),
            annotations: vec![],
            bookmarks: vec![],
            updated_at: "2026-06-07T00:00:00Z".into(),
        };
        store_state(&conn, hash, &again).unwrap();
        assert_eq!(finished_at(&conn).as_deref(), Some("2026-03-04T00:00:00Z"));
        // 进度回退到一半也不清章 —— 那本书确实被读完过一次。
        again.progress = Some(StoredProgress {
            cfi: "epubcfi(/6/4)".into(),
            fraction: 0.4,
        });
        store_state(&conn, hash, &again).unwrap();
        assert_eq!(finished_at(&conn).as_deref(), Some("2026-03-04T00:00:00Z"));
    }

    #[test]
    fn re_set_replaces_previous_content() {
        let conn = memory_db();
        let hash = &"b".repeat(64);
        seed_book(&conn, hash);
        store_state(&conn, hash, &sample()).unwrap();
        let mut second = sample();
        second.annotations.clear();
        second.bookmarks.clear();
        second.progress = None;
        store_state(&conn, hash, &second).unwrap();
        // A fully emptied state reads back as None (nothing stored).
        assert_eq!(load_state(&conn, hash).unwrap(), None);
    }

    #[test]
    fn empty_state_reads_as_none() {
        let conn = memory_db();
        let hash = &"c".repeat(64);
        assert_eq!(load_state(&conn, hash).unwrap(), None);
        store_state(&conn, hash, &ReaderState::default()).unwrap();
        assert_eq!(load_state(&conn, hash).unwrap(), None);
    }

    #[test]
    fn removing_a_book_cascades_its_state() {
        let conn = memory_db();
        let hash = &"d".repeat(64);
        seed_book(&conn, hash);
        store_state(&conn, hash, &sample()).unwrap();
        conn.execute("DELETE FROM books WHERE hash = ?1", [hash.as_str()])
            .unwrap();
        assert_eq!(load_state(&conn, hash).unwrap(), None);
    }

    #[test]
    fn get_all_returns_only_books_that_have_state() {
        let conn = memory_db();
        let (a, b, c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
        for hash in [&a, &b, &c] {
            seed_book(&conn, hash);
        }
        store_state(&conn, &a, &sample()).unwrap();
        // b 存过一个完全空的状态:读回来是 None,不该占 getAll 的一个键。
        store_state(&conn, &b, &ReaderState::default()).unwrap();

        let states = load_all_states(&conn).unwrap();
        assert_eq!(states.len(), 1, "只含有状态的书");
        assert!(states.contains_key(&a));

        // wire 形状:顶层 states,键是 book hash,行内容 camelCase。
        let response = ReaderStateGetAllResponse { states };
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["states"][a.as_str()]["annotations"][0]["id"], "a1");
        assert!(
            json.get("states")
                .map(|s| s.as_object().unwrap().len() == 1)
                .unwrap()
        );
    }

    #[test]
    fn wire_shapes_are_camel_case() {
        let state = ReaderState {
            progress: Some(StoredProgress {
                cfi: "x".into(),
                fraction: 1.0,
            }),
            annotations: vec![],
            bookmarks: vec![],
            updated_at: "2026-09-09T00:00:00Z".into(),
        };
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["updatedAt"], "2026-09-09T00:00:00Z");

        // Old payloads without bookmarks still load (serde default).
        let legacy: ReaderState =
            serde_json::from_str(r#"{"updatedAt":"2026-01-01T00:00:00Z"}"#).unwrap();
        assert!(legacy.bookmarks.is_empty());
    }

    #[test]
    fn reading_goals_default_to_zero_and_round_trip() {
        let conn = memory_db();
        assert_eq!(load_reading_goals(&conn), ReadingGoals::default());
        let goals = ReadingGoals {
            daily_minutes: 45,
            weekly_days: 5,
            yearly_books: 24,
        };
        assert_eq!(save_reading_goals(&conn, &goals).unwrap(), goals);
        assert_eq!(load_reading_goals(&conn), goals);
    }

    #[test]
    fn reading_goals_zero_means_no_goal() {
        let conn = memory_db();
        save_reading_goals(
            &conn,
            &ReadingGoals {
                daily_minutes: 45,
                weekly_days: 3,
                yearly_books: 12,
            },
        )
        .unwrap();
        save_reading_goals(&conn, &ReadingGoals::default()).unwrap();
        assert_eq!(load_reading_goals(&conn), ReadingGoals::default());
    }

    #[test]
    fn reading_goals_reject_absurd_and_garbage_values() {
        let conn = memory_db();
        // 上限之外(25h / 8 天 / 400 本)是校验错误,不是静默截断。
        for goals in [
            ReadingGoals {
                daily_minutes: MAX_GOAL_MINUTES + 1,
                ..ReadingGoals::default()
            },
            ReadingGoals {
                weekly_days: MAX_GOAL_WEEKLY_DAYS + 1,
                ..ReadingGoals::default()
            },
            ReadingGoals {
                yearly_books: MAX_GOAL_YEARLY_BOOKS + 1,
                ..ReadingGoals::default()
            },
        ] {
            let err = save_reading_goals(&conn, &goals).unwrap_err();
            assert_eq!(err.code, ErrorCode::SystemValidation);
        }
        // 旧版本遗留的非法值按"没有目标"读,不让统计环画出一个怪东西。
        for key in [
            READING_GOAL_DAILY_KEY,
            READING_GOAL_WEEKLY_KEY,
            READING_GOAL_YEARLY_KEY,
        ] {
            crate::storage::set_setting(&conn, key, "abc").unwrap();
            crate::storage::set_setting(&conn, key, "99999").unwrap();
        }
        assert_eq!(load_reading_goals(&conn), ReadingGoals::default());
    }

    fn sample_rule(id: &str, priority: i32) -> ChapterRule {
        ChapterRule {
            id: id.into(),
            name: format!("规则{id}"),
            pattern: "^第.+卷".into(),
            priority,
            enabled: true,
        }
    }

    #[test]
    fn chapter_rules_round_trip_and_filter_dirty_entries() {
        let conn = memory_db();
        assert!(load_chapter_rules(&conn).unwrap().is_empty());
        let rules = vec![sample_rule("a", 10), sample_rule("b", 0)];
        assert_eq!(save_chapter_rules(&conn, &rules).unwrap(), rules);
        assert_eq!(load_chapter_rules(&conn).unwrap(), rules);
    }

    #[test]
    fn chapter_rules_drop_shape_invalid_entries_on_write() {
        let conn = memory_db();
        let mut too_long = sample_rule("long", 1);
        too_long.pattern = "x".repeat(MAX_PATTERN_CHARS + 1);
        let mut no_name = sample_rule("nameless", 1);
        no_name.name = "  ".into();
        let kept = save_chapter_rules(&conn, &[sample_rule("keep", 1), too_long, no_name]).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "keep");
    }

    #[test]
    fn chapter_rules_read_falls_back_to_empty_on_garbage() {
        let conn = memory_db();
        // 旧版本遗留的脏内容按"没有规则"读,与 reading goal 同规矩。
        crate::storage::set_setting(&conn, CHAPTER_RULES_KEY, "not json").unwrap();
        assert!(load_chapter_rules(&conn).unwrap().is_empty());
        crate::storage::set_setting(&conn, CHAPTER_RULES_KEY, "{\"rules\":[]}").unwrap();
        assert!(load_chapter_rules(&conn).unwrap().is_empty());
    }
}
