//! Library: registered books, persisted in SQLite (storage.rs migrations).
//! Book files stay at their original location; removing a book never touches
//! the user's file. Legacy `library.json` is imported once by `storage::import_legacy`.

use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::storage::Db;

use crate::error::{AppError, ErrorCode};

/// Extensions this app really supports; mirrors `detectFormat` in
/// `packages/reader-adapter/src/format.ts`.
const SUPPORTED_EXTENSIONS: &[(&str, &str)] = &[
    ("epub", "epub"),
    ("mobi", "mobi"),
    ("prc", "mobi"),
    ("azw", "mobi"),
    ("azw3", "azw3"),
    ("kf8", "azw3"),
    ("fb2", "fb2"),
    ("fbz", "fb2"),
    ("cbz", "cbz"),
    ("pdf", "pdf"),
    ("txt", "txt"),
    ("md", "md"),
    ("markdown", "md"),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBook {
    pub hash: String,
    pub file_name: String,
    /// Clean title from the book's own metadata; `None` until resolved.
    pub display_name: Option<String>,
    pub format: String,
    pub path: String,
    pub size: u64,
    pub added_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryImportRequest {
    pub path: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryListResponse {
    pub books: Vec<LibraryBook>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryImportResponse {
    pub book: LibraryBook,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryRemoveRequest {
    pub book_hash: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRemoveResponse {
    pub removed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryRenameRequest {
    pub book_hash: String,
    pub display_name: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRenameResponse {
    pub book: LibraryBook,
}

pub fn detect_format(file_name: &str) -> Option<&'static str> {
    let lower = file_name.to_lowercase();
    let extension = lower.rsplit('.').next()?;
    SUPPORTED_EXTENSIONS
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, format)| *format)
}

/// Streaming SHA-256 so 100MB+ books never sit in memory (spec §70).
pub fn hash_file(path: &Path) -> Result<(String, u64), AppError> {
    let mut file = std::fs::File::open(path).map_err(|err| {
        AppError::new(ErrorCode::BookOpenFailed, "failed to open book file").with_cause(err)
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read book file").with_cause(err)
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((hex, size))
}

fn row_to_book(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryBook> {
    Ok(LibraryBook {
        hash: row.get("hash")?,
        file_name: row.get("file_name")?,
        display_name: row.get("display_name")?,
        format: row.get("format")?,
        path: row.get("path")?,
        size: row.get::<_, i64>("size")? as u64,
        added_at: row.get("added_at")?,
    })
}

pub fn list_books(conn: &Connection) -> Result<Vec<LibraryBook>, AppError> {
    let mut statement = conn
        .prepare("SELECT hash, file_name, display_name, format, path, size, added_at FROM books ORDER BY added_at DESC, rowid DESC")
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to query library").with_cause(err))?;
    let books = statement
        .query_map([], row_to_book)
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read library").with_cause(err)
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read library row").with_cause(err)
        })?;
    Ok(books)
}

/// Remove a book **and everything derived from it**. The `books` row used to be
/// deleted alone, orphaning progress/annotations/bookmarks/cards/AI state that
/// then rode along in every WebDAV sync forever.
pub fn remove_book(conn: &Connection, hash: &str) -> Result<bool, AppError> {
    crate::state::validate_hash(hash)?;
    let tx = conn.unchecked_transaction().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to begin transaction").with_cause(err)
    })?;
    // Foreign keys are declared ON DELETE CASCADE but SQLite only enforces
    // them when `PRAGMA foreign_keys` is on, so the deletes stay explicit.
    for table in [
        "progress",
        "annotations",
        "bookmarks",
        "cards",
        "ai_index",
        "ai_artifacts",
    ] {
        tx.execute(&format!("DELETE FROM {table} WHERE book_hash = ?1"), [hash])
            .map_err(|err| {
                AppError::new(ErrorCode::StorageIo, "failed to remove book data").with_cause(err)
            })?;
    }
    let removed = tx
        .execute("DELETE FROM books WHERE hash = ?1", [hash])
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to remove book").with_cause(err)
        })?;
    tx.commit().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to commit removal").with_cause(err)
    })?;
    Ok(removed > 0)
}

/// Set the shelf title for a book (the frontend resolves it from the book's
/// own metadata and backfills older rows).
pub fn rename_book(
    conn: &Connection,
    hash: &str,
    display_name: &str,
) -> Result<LibraryBook, AppError> {
    crate::state::validate_hash(hash)?;
    let updated = conn
        .execute(
            "UPDATE books SET display_name = ?1 WHERE hash = ?2",
            rusqlite::params![display_name, hash],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to rename book").with_cause(err)
        })?;
    if updated == 0 {
        return Err(AppError::new(
            ErrorCode::BookOpenFailed,
            "book not in library",
        ));
    }
    conn.query_row(
        "SELECT hash, file_name, display_name, format, path, size, added_at FROM books WHERE hash = ?1",
        [hash],
        row_to_book,
    )
    .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to read renamed book").with_cause(err))
}

/// Import flow: validate the picked file, hash it, upsert the record keeping
/// the original `added_at`.
pub fn import_book(conn: &Connection, raw_path: &str) -> Result<LibraryBook, AppError> {
    let path = PathBuf::from(raw_path);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| {
            AppError::new(ErrorCode::SystemValidation, "path has no file name")
                .with_context("field", "path")
        })?;
    let format = detect_format(&file_name).ok_or_else(|| {
        AppError::new(ErrorCode::BookUnsupportedFormat, "unsupported book format")
            .with_context("fileName", file_name.clone())
    })?;
    let meta = std::fs::metadata(&path).map_err(|err| {
        AppError::new(ErrorCode::BookOpenFailed, "book file is not readable").with_cause(err)
    })?;
    if !meta.is_file() {
        return Err(AppError::new(
            ErrorCode::BookOpenFailed,
            "path is not a file",
        ));
    }

    let (hash, size) = hash_file(&path)?;
    // Re-importing a known file keeps its added_at and the title we already
    // resolved — the point of re-import is usually a moved file, not a reset.
    let existing: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT added_at, display_name FROM books WHERE hash = ?1",
            [&hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => {
                Err(AppError::new(ErrorCode::StorageIo, "failed to look up book").with_cause(other))
            }
        })?;

    let book = LibraryBook {
        hash: hash.clone(),
        file_name,
        display_name: existing.as_ref().and_then(|(_, name)| name.clone()),
        format: format.to_string(),
        path: raw_path.to_string(),
        size,
        added_at: existing
            .as_ref()
            .map(|(added_at, _)| added_at.clone())
            .unwrap_or_else(crate::timestamps::rfc3339_now),
    };
    conn.execute(
        "INSERT OR REPLACE INTO books (hash, file_name, display_name, format, path, size, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            book.hash,
            book.file_name,
            book.display_name,
            book.format,
            book.path,
            book.size as i64,
            book.added_at
        ],
    )
    .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to save book").with_cause(err))?;
    Ok(book)
}

pub fn database_path(base: &Path) -> PathBuf {
    base.join("deepread.db")
}

#[tauri::command(rename = "library.list")]
pub fn library_list(db: tauri::State<'_, Db>) -> Result<LibraryListResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(LibraryListResponse {
        books: list_books(&conn)?,
    })
}

#[tauri::command(rename = "library.import")]
pub fn library_import(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    request: LibraryImportRequest,
) -> Result<LibraryImportResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    let book = import_book(&conn, &request.path)?;
    // Allow the asset protocol to serve exactly this file (user picked it, so
    // this does not widen the scope to any directory).
    app.asset_protocol_scope()
        .allow_file(&book.path)
        .map_err(|err| {
            AppError::new(
                ErrorCode::SecurityValidationFailed,
                "failed to allow book path",
            )
            .with_cause(err)
        })?;
    Ok(LibraryImportResponse { book })
}

#[tauri::command(rename = "library.remove")]
pub fn library_remove(
    db: tauri::State<'_, Db>,
    request: LibraryRemoveRequest,
) -> Result<LibraryRemoveResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(LibraryRemoveResponse {
        removed: remove_book(&conn, &request.book_hash)?,
    })
}

#[tauri::command(rename = "library.rename")]
pub fn library_rename(
    db: tauri::State<'_, Db>,
    request: LibraryRenameRequest,
) -> Result<LibraryRenameResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(LibraryRenameResponse {
        book: rename_book(&conn, &request.book_hash, &request.display_name)?,
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

    #[test]
    fn detects_supported_formats_and_rejects_others() {
        assert_eq!(detect_format("夜航书.EPUB"), Some("epub"));
        assert_eq!(detect_format("book.azw3"), Some("azw3"));
        assert_eq!(detect_format("scan.CBZ"), Some("cbz"));
        assert_eq!(detect_format("file.xyz"), None);
    }

    #[test]
    fn hashes_files_streaming_and_deterministically() {
        let base = std::env::temp_dir().join(format!(
            "reader-lib-hash-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("a.txt");
        std::fs::write(&path, b"hello ai reader").unwrap();
        let (hash, size) = hash_file(&path).unwrap();
        assert_eq!(size, 15);
        assert_eq!(hash.len(), 64);
        let (again, _) = hash_file(&path).unwrap();
        assert_eq!(hash, again);
    }

    #[test]
    fn import_is_an_upsert_that_keeps_the_original_added_at() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-lib-upsert-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("book.epub");
        std::fs::write(&path, b"epub-bytes").unwrap();

        let first = import_book(&conn, path.to_str().unwrap()).unwrap();
        assert_eq!(first.format, "epub");
        assert_eq!(list_books(&conn).unwrap().len(), 1);

        let second = import_book(&conn, path.to_str().unwrap()).unwrap();
        assert_eq!(second.hash, first.hash);
        assert_eq!(second.added_at, first.added_at, "re-import keeps addedAt");
        assert_eq!(list_books(&conn).unwrap().len(), 1);
    }

    #[test]
    fn imports_files_with_chinese_names() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-lib-cn-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("深入理解 AI Agent: 设计原理与工程实践.epub");
        std::fs::write(&path, b"epub-bytes").unwrap();
        let book = import_book(&conn, path.to_str().unwrap()).unwrap();
        assert_eq!(book.format, "epub");
        assert!(book.path.contains("深入理解"));
    }

    #[test]
    fn import_rejects_unsupported_formats_before_touching_storage() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-lib-reject-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("help.chm");
        std::fs::write(&path, b"chm").unwrap();
        let err = import_book(&conn, path.to_str().unwrap()).expect_err("chm must be rejected");
        assert_eq!(err.code.as_str(), "BOOK_UNSUPPORTED_FORMAT");
        assert!(list_books(&conn).unwrap().is_empty());
    }

    #[test]
    fn remove_deletes_only_the_record() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-lib-remove-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("book.epub");
        std::fs::write(&path, b"epub-bytes").unwrap();
        let book = import_book(&conn, path.to_str().unwrap()).unwrap();

        assert!(remove_book(&conn, &book.hash).unwrap());
        assert!(
            !remove_book(&conn, &book.hash).unwrap(),
            "second remove is a no-op"
        );
        assert!(list_books(&conn).unwrap().is_empty());
        assert!(path.exists(), "the user's file must never be deleted");
    }

    #[test]
    fn wire_shapes_are_camel_case() {
        let book = LibraryBook {
            hash: "0".repeat(64),
            file_name: "a.epub".into(),
            display_name: Some("A Book".into()),
            format: "epub".into(),
            path: "/tmp/a.epub".into(),
            size: 3,
            added_at: "2026-09-09T00:00:00Z".into(),
        };
        let json = serde_json::to_value(&book).unwrap();
        assert_eq!(json["fileName"], "a.epub");
        assert_eq!(json["displayName"], "A Book");
        assert_eq!(json["addedAt"], "2026-09-09T00:00:00Z");
    }

    #[test]
    fn removing_a_book_removes_everything_derived_from_it() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-lib-cascade-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("book.epub");
        std::fs::write(&path, b"epub-bytes").unwrap();
        let book = import_book(&conn, path.to_str().unwrap()).unwrap();

        conn.execute(
            "INSERT INTO progress (book_hash, cfi, fraction, updated_at) VALUES (?1, 'c', 0.5, 'now')",
            [&book.hash],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO annotations (id, book_hash, cfi, color) VALUES ('a1', ?1, 'c', 'yellow')",
            [&book.hash],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO bookmarks (id, book_hash, cfi, created_at) VALUES ('b1', ?1, 'c', 'now')",
            [&book.hash],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id, book_hash, front, back, source, due_at, created_at)
             VALUES ('c1', ?1, 'q', 'a', 'manual', 'now', 'now')",
            [&book.hash],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_index (book_hash, chunks, embedding_model, created_at)
             VALUES (?1, '[]', 'm', 'now')",
            [&book.hash],
        )
        .unwrap();

        assert!(remove_book(&conn, &book.hash).unwrap());

        let count = |table: &str| -> i64 {
            conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE book_hash = ?1"),
                [&book.hash],
                |row| row.get(0),
            )
            .unwrap()
        };
        for table in [
            "progress",
            "annotations",
            "bookmarks",
            "cards",
            "ai_index",
            "ai_artifacts",
        ] {
            assert_eq!(count(table), 0, "{table} must not keep orphan rows");
        }
    }

    #[test]
    fn rename_persists_the_shelf_title_and_survives_reimport() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-lib-rename-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("garbage (z-library).epub");
        std::fs::write(&path, b"epub-bytes").unwrap();

        let imported = import_book(&conn, path.to_str().unwrap()).unwrap();
        assert!(imported.display_name.is_none());

        let renamed = rename_book(&conn, &imported.hash, "夜航书").unwrap();
        assert_eq!(renamed.display_name.as_deref(), Some("夜航书"));
        assert_eq!(renamed.file_name, "garbage (z-library).epub");

        // Moving/renaming the file re-imports the same content: the resolved
        // title must not be lost.
        let reimported = import_book(&conn, path.to_str().unwrap()).unwrap();
        assert_eq!(reimported.display_name.as_deref(), Some("夜航书"));
    }
}
