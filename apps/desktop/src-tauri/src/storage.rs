//! SQLite storage (spec §23/§24): single database file, versioned migrations
//! via `PRAGMA user_version`, and a one-time import of the legacy JSON stores
//! (library/reader-state/ai-config/ai-index/ai-artifacts/dictionaries) that it
//! replaces. Imported files are renamed `.imported` — never deleted.

use std::path::Path;

use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{AppError, ErrorCode};

use std::sync::Mutex;

/// Handle shared with all commands. `std::sync::Mutex` is enough: no command
/// holds the lock across an `await`.
pub struct Db(pub Mutex<Connection>);

const MIGRATIONS: &[&str] = &[
    // v1 — initial schema
    r#"
    CREATE TABLE books (
        hash      TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        format    TEXT NOT NULL,
        path      TEXT NOT NULL,
        size      INTEGER NOT NULL,
        added_at  TEXT NOT NULL
    );

    CREATE TABLE progress (
        book_hash  TEXT PRIMARY KEY REFERENCES books(hash) ON DELETE CASCADE,
        cfi        TEXT NOT NULL,
        fraction   REAL NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE annotations (
        id        TEXT PRIMARY KEY,
        book_hash TEXT NOT NULL REFERENCES books(hash) ON DELETE CASCADE,
        cfi       TEXT NOT NULL,
        color     TEXT NOT NULL,
        note      TEXT,
        excerpt   TEXT
    );
    CREATE INDEX idx_annotations_book ON annotations(book_hash);

    CREATE TABLE bookmarks (
        id         TEXT PRIMARY KEY,
        book_hash  TEXT NOT NULL REFERENCES books(hash) ON DELETE CASCADE,
        cfi        TEXT NOT NULL,
        label      TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX idx_bookmarks_book ON bookmarks(book_hash);

    CREATE TABLE ai_providers (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        base_url        TEXT NOT NULL,
        model           TEXT NOT NULL,
        embedding_model TEXT
    );

    CREATE TABLE ai_index (
        book_hash       TEXT PRIMARY KEY,
        chunks          TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        created_at      TEXT NOT NULL
    );

    CREATE TABLE ai_artifacts (
        book_hash  TEXT NOT NULL,
        kind       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (book_hash, kind)
    );

    CREATE TABLE dictionaries (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        word_count        INTEGER NOT NULL,
        sametypesequence  TEXT,
        ifo_path          TEXT NOT NULL,
        idx_path          TEXT NOT NULL,
        dict_path         TEXT NOT NULL
    );
    "#,
    // v2 — Phase 5: learning cards (SM-2 lite state on the row) + per-provider
    // TTS model (spec §31: the TTS model configures independently of chat).
    r#"
    ALTER TABLE ai_providers ADD COLUMN tts_model TEXT;

    CREATE TABLE cards (
        id            TEXT PRIMARY KEY,
        book_hash     TEXT NOT NULL REFERENCES books(hash) ON DELETE CASCADE,
        front         TEXT NOT NULL,
        back          TEXT NOT NULL,
        source        TEXT NOT NULL,
        cfi           TEXT,
        ease          REAL NOT NULL DEFAULT 2.5,
        interval_days REAL NOT NULL DEFAULT 0,
        reps          INTEGER NOT NULL DEFAULT 0,
        lapses        INTEGER NOT NULL DEFAULT 0,
        due_at        TEXT NOT NULL,
        created_at    TEXT NOT NULL
    );
    CREATE INDEX idx_cards_book ON cards(book_hash);
    CREATE INDEX idx_cards_due ON cards(due_at);
    "#,
    // v3 — Phase 6 cloud sync: record-level timestamps + tombstones so the
    // merge engine can union annotations/bookmarks across devices, plus a
    // small key/value store for sync settings (device id, WebDAV endpoint).
    r#"
    ALTER TABLE annotations ADD COLUMN updated_at TEXT;
    ALTER TABLE annotations ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE bookmarks ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // v4 — shelf titles: the book's own metadata title, resolved lazily and
    // backfilled by the frontend (file names carry download-site garbage like
    // "(z-library…)" that must never reach the shelf).
    r#"
    ALTER TABLE books ADD COLUMN display_name TEXT;
    "#,
    // v5 — shelf tags (JSON array of strings): collections the user builds on
    // top of the flat shelf. Plain JSON keeps the column sync-friendly.
    r#"
    ALTER TABLE books ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
    "#,
    // v6 — reading time per book per day. The frontend reports deltas (it is
    // the only side that knows when the reader is actually on screen), and the
    // day key is local so "today" matches the user's calendar, not UTC.
    r#"
    CREATE TABLE reading_stats (
        book_hash TEXT NOT NULL,
        day       TEXT NOT NULL,
        seconds   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (book_hash, day)
    );
    "#,
];

pub fn open_db(path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to create data directory").with_cause(err)
        })?;
    }
    let conn = Connection::open(path).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to open database").with_cause(err)
    })?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|err| {
            // A file that is not a database surfaces here first (lazy open);
            // classify it as corruption so recovery can quarantine it.
            if err.sqlite_error_code() == Some(rusqlite::ffi::ErrorCode::NotADatabase) {
                AppError::new(ErrorCode::StorageCorrupt, "database file is not a database")
            } else {
                AppError::new(ErrorCode::StorageIo, "failed to set WAL mode").with_cause(err)
            }
        })?;
    migrate(&conn)?;
    Ok(conn)
}

/// Startup open with corruption recovery (spec §127): Detect (quick_check)
/// → Backup (quarantine the corrupt file, never deleted) → Recover (fresh
/// database). Reading history lost to corruption is the user's worst case;
/// silently crashing or wiping is worse.
pub fn open_db_with_recovery(path: &Path) -> Result<Connection, AppError> {
    match open_db(path) {
        Ok(conn) => {
            let check: String = conn
                .query_row("PRAGMA quick_check", [], |row| row.get(0))
                .unwrap_or_else(|_| "quick_check failed".to_string());
            if check == "ok" {
                return Ok(conn);
            }
            log::warn!("database integrity check failed: {check}");
            drop(conn);
            quarantine(path);
            open_db(path)
        }
        Err(err) if err.code == ErrorCode::StorageCorrupt => {
            log::warn!("database unreadable: {err}");
            quarantine(path);
            open_db(path)
        }
        Err(err) => Err(err),
    }
}

/// Rename the database (plus WAL/SHM sidecars) aside with a timestamp. Files
/// are preserved — the user may want to hand them to support or a future
/// recovery tool; they are never deleted here.
fn quarantine(path: &Path) {
    let stamp = crate::timestamps::rfc3339_now().replace([':', '.'], "-");
    for suffix in ["", "-wal", "-shm"] {
        let mut source = path.as_os_str().to_owned();
        source.push(suffix);
        let source = Path::new(&source);
        if !source.exists() {
            continue;
        }
        let mut quarantined = path.as_os_str().to_owned();
        quarantined.push(format!(".corrupt-{stamp}{suffix}"));
        if let Err(err) = std::fs::rename(source, Path::new(&quarantined)) {
            log::warn!("failed to quarantine {}: {err}", source.display());
        }
    }
}

pub fn migrate(conn: &Connection) -> Result<(), AppError> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read schema version").with_cause(err)
        })?;
    for (offset, sql) in MIGRATIONS.iter().enumerate() {
        let target = (offset + 1) as i64;
        if version < target {
            conn.execute_batch(sql).map_err(|err| {
                AppError::new(ErrorCode::StorageCorrupt, "migration failed").with_cause(err)
            })?;
            conn.pragma_update(None, "user_version", target)
                .map_err(|err| {
                    AppError::new(ErrorCode::StorageIo, "failed to set schema version")
                        .with_cause(err)
                })?;
        }
    }
    Ok(())
}

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

    #[test]
    fn migrations_are_idempotent_and_create_schema() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        conn.execute(
            "INSERT INTO books (hash, file_name, format, path, size, added_at) VALUES ('h', 'n', 'epub', '/p', 1, 't')",
            [],
        )
        .unwrap();
    }

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

// ---------- Backup / restore (spec §126) ----------

use serde::{Deserialize, Serialize};

pub fn file_checksum(path: &Path) -> Result<String, AppError> {
    let mut file = std::fs::File::open(path).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to open file for checksum").with_cause(err)
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = std::io::Read::read(&mut file, &mut buffer).map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read file").with_cause(err)
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Consistent snapshot via VACUUM INTO (fails if the destination exists).
pub fn backup_to(conn: &Connection, dest_path: &Path) -> Result<u64, AppError> {
    if dest_path.exists() {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "目标文件已存在,请选择新的位置",
        ));
    }
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to create backup directory").with_cause(err)
        })?;
    }
    // VACUUM INTO takes a literal, not a parameter — escape quotes so a path
    // containing an apostrophe (common in home-dir names) cannot break the SQL.
    let escaped = dest_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "''");
    let sql = format!("VACUUM INTO '{escaped}'");
    conn.execute_batch(&sql).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to write backup").with_cause(err)
    })?;
    let size = std::fs::metadata(dest_path)
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "backup file missing").with_cause(err))?
        .len();
    Ok(size)
}

/// Pre-restore validation: checksum then integrity_check on the snapshot.
pub fn validate_backup(path: &Path, checksum: &str) -> Result<(), AppError> {
    let actual = file_checksum(path)?;
    if actual != checksum {
        return Err(
            AppError::new(ErrorCode::StorageCorrupt, "校验和不匹配,备份文件可能已损坏")
                .with_context("expected", Value::String(checksum.to_string()))
                .with_context("actual", Value::String(actual)),
        );
    }
    let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to open backup").with_cause(err)
        })?;
    let integrity: String = source
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|err| {
            AppError::new(ErrorCode::StorageCorrupt, "integrity check failed").with_cause(err)
        })?;
    if integrity != "ok" {
        return Err(AppError::new(
            ErrorCode::StorageCorrupt,
            format!("integrity check: {integrity}"),
        ));
    }
    Ok(())
}

/// Restore a validated snapshot INTO the live connection (rusqlite backup
/// copies page-by-page), then run migrations in case the backup is older.
pub fn restore_from(live: &mut Connection, path: &Path, checksum: &str) -> Result<bool, AppError> {
    validate_backup(path, checksum)?;
    let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to open backup").with_cause(err)
        })?;
    let backup = rusqlite::backup::Backup::new(&source, live).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to start restore").with_cause(err)
    })?;
    backup
        .run_to_completion(5, std::time::Duration::from_millis(5), None)
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to restore").with_cause(err))?;
    drop(backup);
    drop(source);
    migrate(live)?;
    Ok(true)
}

// ---------- App settings (small key/value store) ----------

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, AppError> {
    match conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [key],
        |row| row.get(0),
    ) {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => {
            Err(AppError::new(ErrorCode::StorageIo, "failed to read setting").with_cause(err))
        }
    }
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    )
    .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to save setting").with_cause(err))?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageBackupRequest {
    pub path: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageBackupResponse {
    pub bytes: u64,
    pub checksum: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageRestoreRequest {
    pub path: String,
    pub checksum: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageRestoreResponse {
    pub restored: bool,
}

#[tauri::command(rename = "storage.backup")]
pub fn storage_backup(
    db: tauri::State<'_, Db>,
    request: StorageBackupRequest,
) -> Result<StorageBackupResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    let dest = Path::new(&request.path);
    let bytes = backup_to(&conn, dest)?;
    let checksum = file_checksum(dest)?;
    Ok(StorageBackupResponse { bytes, checksum })
}

#[tauri::command(rename = "storage.restore")]
pub fn storage_restore(
    db: tauri::State<'_, Db>,
    request: StorageRestoreRequest,
) -> Result<StorageRestoreResponse, AppError> {
    let mut conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    restore_from(&mut conn, Path::new(&request.path), &request.checksum)?;
    Ok(StorageRestoreResponse { restored: true })
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    fn temp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "reader-recovery-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn healthy_database_opens_untouched() {
        let path = temp_path("healthy");
        {
            let conn = open_db_with_recovery(&path).unwrap();
            conn.execute(
                "INSERT INTO books (hash, file_name, format, path, size, added_at) VALUES ('h', 'n', 'epub', '/p', 1, 't')",
                [],
            )
            .unwrap();
        }
        let conn = open_db_with_recovery(&path).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_database_is_quarantined_and_rebuilt() {
        let path = temp_path("corrupt");
        std::fs::write(&path, b"this is definitely not a sqlite database").unwrap();
        let conn = open_db_with_recovery(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        let quarantined: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        assert_eq!(quarantined.len(), 1, "corrupt file must be backed up");
        for file in quarantined {
            let _ = std::fs::remove_file(path.parent().unwrap().join(file));
        }
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod backup_tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "reader-backup-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn backup_creates_snapshot_and_checksum_round_trips() {
        let conn = memory_db();
        conn.execute(
            "INSERT INTO books (hash, file_name, format, path, size, added_at) VALUES ('h', 'n', 'epub', '/p', 1, 't')",
            [],
        )
        .unwrap();
        let base = temp_dir("round");
        let dest = base.join("backup.db");

        let bytes = backup_to(&conn, &dest).unwrap();
        assert!(bytes > 0);
        let checksum = file_checksum(&dest).unwrap();
        assert_eq!(checksum.len(), 64);

        // Corrupt the live DB, restore from snapshot, data returns.
        conn.execute("DELETE FROM books", []).unwrap();
        let mut live = conn;
        restore_from(&mut live, &dest, &checksum).unwrap();
        let count: i64 = live
            .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn restore_rejects_checksum_mismatch() {
        let conn = memory_db();
        let base = temp_dir("mismatch");
        let dest = base.join("backup.db");
        backup_to(&conn, &dest).unwrap();
        let mut live = conn;
        let err = restore_from(&mut live, &dest, &"0".repeat(64))
            .expect_err("checksum mismatch must fail");
        assert_eq!(err.code.as_str(), "STORAGE_CORRUPT");
    }

    #[test]
    fn backup_refuses_to_overwrite_existing_file() {
        let conn = memory_db();
        let base = temp_dir("exists");
        let dest = base.join("backup.db");
        backup_to(&conn, &dest).unwrap();
        let err = backup_to(&conn, &dest).expect_err("must refuse overwrite");
        assert_eq!(err.code.as_str(), "SYSTEM_VALIDATION");
    }
}
