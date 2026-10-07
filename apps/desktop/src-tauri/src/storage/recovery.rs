//! Startup open with corruption recovery (spec §127): Detect (quick_check)
//! → Backup (quarantine the corrupt file, never deleted) → Recover (fresh
//! database).

use std::path::Path;

use rusqlite::Connection;

use crate::error::{AppError, ErrorCode};

use super::migrations::migrate;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MIGRATIONS;

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
