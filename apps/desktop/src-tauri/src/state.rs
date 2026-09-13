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
