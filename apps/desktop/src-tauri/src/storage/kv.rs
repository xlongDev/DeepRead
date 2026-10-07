//! Small key/value store (`app_settings`) for sync/TTS/reading-goal settings.

use rusqlite::Connection;

use crate::error::{AppError, ErrorCode};

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
