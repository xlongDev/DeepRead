//! Versioned schema migrations, applied via `PRAGMA user_version`.

use rusqlite::Connection;

use crate::error::{AppError, ErrorCode};

pub const MIGRATIONS: &[&str] = &[
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
    // v7 — book metadata beyond the title: author (shown on the shelf card),
    // plus subtitle/publisher/language which the info panel edits and future
    // export/search will read. All nullable: absent means "the book didn't say".
    r#"
    ALTER TABLE books ADD COLUMN author TEXT;
    ALTER TABLE books ADD COLUMN subtitle TEXT;
    ALTER TABLE books ADD COLUMN publisher TEXT;
    ALTER TABLE books ADD COLUMN language TEXT;
    "#,
];

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
}
