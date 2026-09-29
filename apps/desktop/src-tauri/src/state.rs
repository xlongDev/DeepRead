//! Per-book reader state (progress + annotations + bookmarks), persisted in
//! SQLite via a transaction on `reader.state.set`. Legacy per-hash JSON files
//! are imported once by `storage::import_legacy`.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredProgress {
    pub cfi: String,
    pub fraction: f64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredAnnotation {
    pub id: String,
    pub cfi: String,
    pub color: String,
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

#[derive(Debug, Serialize, Deserialize, PartialEq)]
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

#[derive(Debug, Serialize, Deserialize, PartialEq, Default)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateGetRequest {
    pub book_hash: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StateGetResponse {
    pub state: Option<ReaderState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateSetRequest {
    pub book_hash: String,
    pub state: ReaderState,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StateSetResponse {
    pub saved_at: String,
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

    let mut statement = conn
        .prepare("SELECT id, cfi, color, note, excerpt, updated_at, deleted FROM annotations WHERE book_hash = ?1 ORDER BY rowid")
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to query annotations").with_cause(err))?;
    let annotations = statement
        .query_map([hash], |row| {
            Ok(StoredAnnotation {
                id: row.get(0)?,
                cfi: row.get(1)?,
                color: row.get(2)?,
                note: row.get(3)?,
                excerpt: row.get(4)?,
                updated_at: row.get(5)?,
                deleted: row.get(6)?,
            })
        })
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read annotations").with_cause(err)
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read annotation row").with_cause(err)
        })?;

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
    let tx = conn.unchecked_transaction().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to begin transaction").with_cause(err)
    })?;
    tx.execute("DELETE FROM progress WHERE book_hash = ?1", [hash])
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to reset progress").with_cause(err)
        })?;
    tx.execute("DELETE FROM annotations WHERE book_hash = ?1", [hash])
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to reset annotations").with_cause(err)
        })?;
    tx.execute("DELETE FROM bookmarks WHERE book_hash = ?1", [hash])
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to reset bookmarks").with_cause(err)
        })?;

    if let Some(progress) = &state.progress {
        tx.execute(
            "INSERT INTO progress (book_hash, cfi, fraction, updated_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![hash, progress.cfi, progress.fraction, state.updated_at],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to save progress").with_cause(err)
        })?;
    }
    for annotation in &state.annotations {
        tx.execute(
            "INSERT INTO annotations (id, book_hash, cfi, color, note, excerpt, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                annotation.id,
                hash,
                annotation.cfi,
                annotation.color,
                annotation.note,
                annotation.excerpt,
                annotation.updated_at,
                annotation.deleted
            ],
        )
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to save annotation").with_cause(err))?;
    }
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

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    pub day: String,
    pub seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatsAddRequest {
    pub book_hash: String,
    /// Local calendar day, `YYYY-MM-DD`.
    pub day: String,
    pub seconds: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatsAddResponse {
    /// Total for that book on that day after the update.
    pub day_seconds: u64,
}

#[derive(Debug, Serialize, PartialEq)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

#[derive(Debug, Serialize, PartialEq)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookReadingStat {
    pub book_hash: String,
    pub display_name: Option<String>,
    pub file_name: String,
    pub seconds: u64,
}

#[derive(Debug, Serialize, PartialEq)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteUpdateRequest {
    pub note_id: String,
    /// 与 noteEntrySchema 的 note 上限一致(4000 字);空串 = 清空回纯高亮。
    pub note: String,
}

#[derive(Debug, Serialize, PartialEq)]
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
                note: Some("我自己写的".into()),
                excerpt: Some("原文一".into()),
                updated_at: Some("2026-09-09T00:00:00Z".into()),
                deleted: false,
            },
            StoredAnnotation {
                id: "a2".into(),
                cfi: "cfi-2".into(),
                color: "#f5d76e".into(),
                note: None,
                excerpt: Some("原文二".into()),
                updated_at: Some("2026-09-10T00:00:00Z".into()),
                deleted: false,
            },
            StoredAnnotation {
                id: "a3".into(),
                cfi: "cfi-3".into(),
                color: "#f5d76e".into(),
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
                note: Some("我自己写的".into()),
                excerpt: Some("原文一".into()),
                updated_at: Some("2026-09-09T00:00:00Z".into()),
                deleted: false,
            },
            StoredAnnotation {
                id: "a3".into(),
                cfi: "cfi-3".into(),
                color: "#f5d76e".into(),
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
}
