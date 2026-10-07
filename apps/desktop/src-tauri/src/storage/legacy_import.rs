//! One-time import of the legacy JSON stores (library/reader-state/ai-config/
//! ai-index/ai-artifacts/dictionaries) that the SQLite database replaces.
//! Imported files are renamed `.imported` — never deleted.

use std::path::Path;

use rusqlite::Connection;
use serde_json::Value;

use crate::error::{AppError, ErrorCode};

fn read_json(path: &Path) -> Result<Option<Value>, AppError> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|err| {
            AppError::new(ErrorCode::StorageCorrupt, "legacy file is corrupted").with_cause(err)
        }),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => {
            Err(AppError::new(ErrorCode::StorageIo, "failed to read legacy file").with_cause(err))
        }
    }
}

/// Rename a legacy file after a successful import so it never runs twice.
fn retire(path: &Path) {
    let mut renamed = path.as_os_str().to_owned();
    renamed.push(".imported");
    let _ = std::fs::rename(path, Path::new(&renamed));
}

/// One-time import of every legacy JSON store. Safe to run repeatedly:
/// each source is retired right after a successful import.
pub fn import_legacy(conn: &Connection, base: &Path) -> Result<(), AppError> {
    import_library(conn, base)?;
    import_reader_states(conn, base)?;
    import_ai_config(conn, base)?;
    import_dictionaries(conn, base)?;
    import_ai_indexes(conn, base)?;
    import_ai_artifacts(conn, base)?;
    Ok(())
}

fn import_library(conn: &Connection, base: &Path) -> Result<(), AppError> {
    let path = base.join("library.json");
    let Some(value) = read_json(&path)? else {
        return Ok(());
    };
    if let Some(books) = value.get("books").and_then(|v| v.as_array()) {
        for book in books {
            conn.execute(
                "INSERT OR IGNORE INTO books (hash, file_name, format, path, size, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    book.get("hash")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    book.get("fileName")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    book.get("format")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    book.get("path")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    book.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
                    book.get("addedAt")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                ],
            )
            .map_err(|err| {
                AppError::new(ErrorCode::StorageCorrupt, "legacy book import failed")
                    .with_cause(err)
            })?;
        }
    }
    retire(&path);
    Ok(())
}

fn import_one_reader_state(conn: &Connection, hash: &str, value: &Value) -> Result<(), AppError> {
    // Reader states may reference books whose file was imported in a previous
    // install (library.json empty after a data-dir move). Seed a placeholder
    // book row so the foreign key holds; re-importing the same file later
    // replaces the placeholder with real metadata (same content hash).
    conn.execute(
        "INSERT OR IGNORE INTO books (hash, file_name, format, path, size, added_at)
         VALUES (?1, ?1, 'unknown', '', 0, ?2)",
        rusqlite::params![hash, crate::timestamps::rfc3339_now()],
    )
    .map_err(|err| {
        AppError::new(ErrorCode::StorageCorrupt, "placeholder book failed").with_cause(err)
    })?;
    if let Some(progress) = value.get("progress") {
        conn.execute(
            "INSERT OR REPLACE INTO progress (book_hash, cfi, fraction, updated_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                hash,
                progress.get("cfi").and_then(|v| v.as_str()).unwrap_or_default(),
                progress.get("fraction").and_then(|v| v.as_f64()).unwrap_or(0.0),
                value.get("updatedAt").and_then(|v| v.as_str()).unwrap_or_default(),
            ],
        )
        .map_err(|err| AppError::new(ErrorCode::StorageCorrupt, "legacy progress import failed").with_cause(err))?;
    }
    if let Some(annotations) = value.get("annotations").and_then(|v| v.as_array()) {
        for a in annotations {
            conn.execute(
                "INSERT OR REPLACE INTO annotations (id, book_hash, cfi, color, note, excerpt)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    a.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                    hash,
                    a.get("cfi").and_then(|v| v.as_str()).unwrap_or_default(),
                    a.get("color").and_then(|v| v.as_str()).unwrap_or_default(),
                    a.get("note").and_then(|v| v.as_str()),
                    a.get("excerpt").and_then(|v| v.as_str()),
                ],
            )
            .map_err(|err| {
                AppError::new(ErrorCode::StorageCorrupt, "legacy annotation import failed")
                    .with_cause(err)
            })?;
        }
    }
    if let Some(bookmarks) = value.get("bookmarks").and_then(|v| v.as_array()) {
        for b in bookmarks {
            conn.execute(
                "INSERT OR REPLACE INTO bookmarks (id, book_hash, cfi, label, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    b.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                    hash,
                    b.get("cfi").and_then(|v| v.as_str()).unwrap_or_default(),
                    b.get("label").and_then(|v| v.as_str()),
                    b.get("createdAt")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                ],
            )
            .map_err(|err| {
                AppError::new(ErrorCode::StorageCorrupt, "legacy bookmark import failed")
                    .with_cause(err)
            })?;
        }
    }
    Ok(())
}

fn import_reader_states(conn: &Connection, base: &Path) -> Result<(), AppError> {
    let dir = base.join("reader-state");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(
                AppError::new(ErrorCode::StorageIo, "failed to read legacy states").with_cause(err),
            );
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e != "json").unwrap_or(true) {
            continue;
        }
        let Some(hash) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        if crate::state::is_book_hash(&hash) {
            if let Some(value) = read_json(&path)? {
                import_one_reader_state(conn, &hash, &value)?;
            }
        }
        retire(&path);
    }
    Ok(())
}

fn import_ai_config(conn: &Connection, base: &Path) -> Result<(), AppError> {
    let path = base.join("ai-config.json");
    let Some(value) = read_json(&path)? else {
        return Ok(());
    };
    if let Some(providers) = value.get("providers").and_then(|v| v.as_array()) {
        for provider in providers {
            conn.execute(
                "INSERT OR REPLACE INTO ai_providers (id, name, base_url, model, embedding_model)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    provider
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    provider
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    provider
                        .get("baseUrl")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    provider
                        .get("model")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    provider.get("embeddingModel").and_then(|v| v.as_str()),
                ],
            )
            .map_err(|err| {
                AppError::new(ErrorCode::StorageCorrupt, "legacy provider import failed")
                    .with_cause(err)
            })?;
        }
    }
    retire(&path);
    Ok(())
}

fn import_dictionaries(conn: &Connection, base: &Path) -> Result<(), AppError> {
    let path = base.join("dictionaries.json");
    let Some(value) = read_json(&path)? else {
        return Ok(());
    };
    if let Some(dictionaries) = value.get("dictionaries").and_then(|v| v.as_array()) {
        for dictionary in dictionaries {
            conn.execute(
                "INSERT OR REPLACE INTO dictionaries (id, name, word_count, sametypesequence, ifo_path, idx_path, dict_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    dictionary.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                    dictionary.get("name").and_then(|v| v.as_str()).unwrap_or_default(),
                    dictionary.get("wordCount").and_then(|v| v.as_i64()).unwrap_or(0),
                    dictionary.get("sametypesequence").and_then(|v| v.as_str()),
                    dictionary.get("ifoPath").and_then(|v| v.as_str()).unwrap_or_default(),
                    dictionary.get("idxPath").and_then(|v| v.as_str()).unwrap_or_default(),
                    dictionary.get("dictPath").and_then(|v| v.as_str()).unwrap_or_default(),
                ],
            )
            .map_err(|err| AppError::new(ErrorCode::StorageCorrupt, "legacy dictionary import failed").with_cause(err))?;
        }
    }
    retire(&path);
    Ok(())
}

fn import_ai_indexes(conn: &Connection, base: &Path) -> Result<(), AppError> {
    let dir = base.join("ai-index");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(
                AppError::new(ErrorCode::StorageIo, "failed to read legacy indexes")
                    .with_cause(err),
            );
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e != "json").unwrap_or(true) {
            continue;
        }
        let Some(hash) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        if crate::state::is_book_hash(&hash) {
            if let Some(value) = read_json(&path)? {
                conn.execute(
                    "INSERT OR REPLACE INTO ai_index (book_hash, chunks, embedding_model, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        hash,
                        value.get("chunks").map(|c| c.to_string()).unwrap_or_default(),
                        value.get("embeddingModel").and_then(|v| v.as_str()).unwrap_or_default(),
                        value.get("createdAt").and_then(|v| v.as_str()).unwrap_or_default(),
                    ],
                )
                .map_err(|err| AppError::new(ErrorCode::StorageCorrupt, "legacy index import failed").with_cause(err))?;
            }
        }
        retire(&path);
    }
    Ok(())
}

fn import_ai_artifacts(conn: &Connection, base: &Path) -> Result<(), AppError> {
    let dir = base.join("ai-artifact");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(
                AppError::new(ErrorCode::StorageIo, "failed to read legacy artifacts")
                    .with_cause(err),
            );
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e != "json").unwrap_or(true) {
            continue;
        }
        let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let Some((hash, kind)) = stem.split_once('-') else {
            continue;
        };
        if crate::state::is_book_hash(hash) {
            if let Some(value) = read_json(&path)? {
                conn.execute(
                    "INSERT OR REPLACE INTO ai_artifacts (book_hash, kind, payload, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        hash,
                        kind,
                        value
                            .get("payload")
                            .map(|p| p.to_string())
                            .unwrap_or_else(|| "{}".into()),
                        value
                            .get("createdAt")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default(),
                    ],
                )
                .map_err(|err| {
                    AppError::new(ErrorCode::StorageCorrupt, "legacy artifact import failed")
                        .with_cause(err)
                })?;
            }
        }
        retire(&path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::migrate;

    #[test]
    fn legacy_library_import_retires_the_file() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let base = std::env::temp_dir().join(format!(
            "reader-legacy-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(
            base.join("library.json"),
            r#"{"books":[{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fileName":"书.epub","format":"epub","path":"/b.epub","size":3,"addedAt":"2026-09-13T00:00:00Z"}]}"#,
        )
        .unwrap();

        import_legacy(&conn, &base).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert!(!base.join("library.json").exists());
        assert!(base.join("library.json.imported").exists());
    }

    #[test]
    fn reader_state_import_seeds_placeholder_book_for_missing_hash() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let base = std::env::temp_dir().join(format!(
            "reader-legacy-state-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let hash = "13d9bcd5b62d7ca949743f5ce18ef6c6845e273534556eb5fa70630a1808e457";
        let dir = base.join("reader-state");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{hash}.json")),
            r#"{"progress":{"cfi":"x","fraction":0.84},"annotations":[],"bookmarks":[],"updatedAt":"2026-09-13T00:00:00Z"}"#,
        )
        .unwrap();

        import_legacy(&conn, &base).unwrap();

        let book_hash: String = conn
            .query_row("SELECT hash FROM books WHERE hash = ?1", [hash], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(book_hash, hash);
        let progress: f64 = conn
            .query_row(
                "SELECT fraction FROM progress WHERE book_hash = ?1",
                [hash],
                |r| r.get(0),
            )
            .unwrap();
        assert!((progress - 0.84).abs() < 1e-9);
    }

    #[test]
    fn corrupted_legacy_file_is_reported_not_silently_skipped() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let base = std::env::temp_dir().join(format!(
            "reader-legacy-bad-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("library.json"), "{broken").unwrap();
        let err = import_legacy(&conn, &base).expect_err("corrupt legacy must error");
        assert_eq!(err.code.as_str(), "STORAGE_CORRUPT");
    }
}
