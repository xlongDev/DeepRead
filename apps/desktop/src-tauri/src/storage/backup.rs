//! Backup / restore (spec §126): consistent SQLite snapshots with checksums,
//! plus import of the browser build's JSON snapshot.

use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
// `app.path()`(拿应用数据目录)由这个 trait 提供 —— 不导入的话编译器只会说
// "no method named `path`",不告诉你要导什么。
use tauri::Manager as _;

use crate::error::{AppError, ErrorCode};

use super::Db;
use super::migrations::migrate;

use ts_rs::TS;

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

// ---------- 浏览器备份(JSON)的导入 ----------
//
// 浏览器端(web 预览版)没有 SQLite,它把整个库序列化成一份 JSON —— 见
// `apps/desktop/src/lib/web-store.ts` 的 `exportSnapshot`。这里让桌面端能收下
// 那份文件,于是"在浏览器里读的书"可以接着在桌面版读。
//
// 只声明用得上的字段:`covers` 不收(封面能从书里重新提取),`checksum` 不读
// (理由见 `import_json_snapshot`)。

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSnapshot {
    version: u32,
    books: Vec<WebBook>,
    #[serde(default)]
    files: Vec<WebFile>,
    #[serde(default)]
    states: Vec<WebState>,
    #[serde(default)]
    stats: Vec<WebStat>,
    #[serde(default)]
    cards: Vec<WebCard>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebBook {
    hash: String,
    file_name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    subtitle: Option<String>,
    #[serde(default)]
    publisher: Option<String>,
    #[serde(default)]
    language: Option<String>,
    format: String,
    size: i64,
    added_at: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebFile {
    hash: String,
    file_name: String,
    /// 原始字节的 base64 —— 比原始字节多约 1/3,但那是唯一能塞进 JSON 的办法。
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebState {
    hash: String,
    #[serde(default)]
    progress: Option<WebProgress>,
    #[serde(default)]
    annotations: Vec<WebAnnotation>,
    #[serde(default)]
    bookmarks: Vec<WebBookmark>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WebProgress {
    cfi: String,
    fraction: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebAnnotation {
    id: String,
    cfi: String,
    color: String,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    excerpt: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    deleted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebBookmark {
    id: String,
    cfi: String,
    #[serde(default)]
    label: Option<String>,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebStat {
    day: String,
    hash: String,
    seconds: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebCard {
    id: String,
    book_hash: String,
    front: String,
    back: String,
    source: String,
    #[serde(default)]
    cfi: Option<String>,
    ease: f64,
    interval_days: f64,
    reps: i64,
    lapses: i64,
    due_at: String,
    created_at: String,
}

/// 从浏览器端的 JSON 备份导入,返回导入的书本数。
///
/// 与 `.db` 那条路的关键差异:SQLite 快照是整库替换,而 JSON 里**带着书籍字节**
/// —— 那些书原本只活在浏览器里,得先落到应用数据目录,`books.path` 再指向它。
///
/// **不校验 checksum。** 那个值是浏览器端对「除 checksum 外的 JSON 文本」算的,
/// 要在 Rust 侧重现,必须让两边的 JSON 规范化(键序、数字格式、转义)逐字节一致
/// —— 太脆,而且坏起来是"拒绝一份好备份"这种最难查的失败。这里的完整性由
/// serde 的严格解析兜底:结构对不上就整个拒绝,不会写进去一半。
pub fn import_json_snapshot(
    conn: &mut Connection,
    json_path: &Path,
    books_dir: &Path,
) -> Result<usize, AppError> {
    let text = std::fs::read_to_string(json_path)
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "读不到备份文件").with_cause(err))?;
    let snapshot: WebSnapshot = serde_json::from_str(&text).map_err(|err| {
        AppError::new(
            ErrorCode::SystemValidation,
            "这不是一份有效的浏览器备份(结构对不上)",
        )
        .with_cause(err)
    })?;
    if snapshot.version != 1 {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            format!("不认识的备份版本 {}", snapshot.version),
        ));
    }

    // 字节先落盘。文件系统操作回滚不了,所以必须早于动数据库 —— 反过来的话,
    // 写文件失败会留下「书在库里、文件不在」的坏状态,点开就是错的。
    std::fs::create_dir_all(books_dir)
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "建不了导入目录").with_cause(err))?;
    let mut paths: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for file in &snapshot.files {
        let bytes = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .decode(file.data.as_bytes())
                .map_err(|err| {
                    AppError::new(
                        ErrorCode::SystemValidation,
                        "备份里的书籍数据不是合法的 base64",
                    )
                    .with_cause(err)
                })?
        };
        let extension = Path::new(&file.file_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("bin");
        let dest = books_dir.join(format!("{}.{extension}", file.hash));
        std::fs::write(&dest, &bytes)
            .map_err(|err| AppError::new(ErrorCode::StorageIo, "写不了书籍文件").with_cause(err))?;
        paths.insert(file.hash.clone(), dest.to_string_lossy().into_owned());
    }

    let now = crate::timestamps::rfc3339_now();
    let tx = conn.transaction().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to start import").with_cause(err)
    })?;

    // 整表替换,与浏览器端的恢复语义一致:以备份为准,不合并 —— 合并出半新半旧
    // 更难解释。books 上的 ON DELETE CASCADE 会带走 progress / annotations /
    // bookmarks / cards;reading_stats 没有外键,得自己清。
    tx.execute("DELETE FROM books", [])
        .and_then(|_| tx.execute("DELETE FROM reading_stats", []))
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to clear").with_cause(err))?;

    for book in &snapshot.books {
        tx.execute(
            "INSERT INTO books (hash, file_name, display_name, author, subtitle, publisher, \
             language, format, path, size, added_at, tags) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                book.hash,
                book.file_name,
                book.display_name,
                book.author,
                book.subtitle,
                book.publisher,
                book.language,
                book.format,
                paths.get(&book.hash).cloned().unwrap_or_default(),
                book.size,
                book.added_at,
                serde_json::to_string(&book.tags).unwrap_or_else(|_| "[]".to_string()),
            ],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to write book").with_cause(err)
        })?;
    }

    for state in &snapshot.states {
        let updated_at = state.updated_at.clone().unwrap_or_else(|| now.clone());
        if let Some(progress) = &state.progress {
            tx.execute(
                "INSERT OR REPLACE INTO progress (book_hash, cfi, fraction, updated_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![state.hash, progress.cfi, progress.fraction, updated_at],
            )
            .map_err(|err| {
                AppError::new(ErrorCode::StorageIo, "failed to write progress").with_cause(err)
            })?;
        }
        for annotation in &state.annotations {
            tx.execute(
                "INSERT OR REPLACE INTO annotations \
                 (id, book_hash, cfi, color, note, excerpt, updated_at, deleted) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    annotation.id,
                    state.hash,
                    annotation.cfi,
                    annotation.color,
                    annotation.note,
                    annotation.excerpt,
                    annotation.updated_at,
                    i64::from(annotation.deleted),
                ],
            )
            .map_err(|err| {
                AppError::new(ErrorCode::StorageIo, "failed to write annotation").with_cause(err)
            })?;
        }
        for bookmark in &state.bookmarks {
            tx.execute(
                "INSERT OR REPLACE INTO bookmarks (id, book_hash, cfi, label, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    bookmark.id,
                    state.hash,
                    bookmark.cfi,
                    bookmark.label,
                    bookmark.created_at,
                ],
            )
            .map_err(|err| {
                AppError::new(ErrorCode::StorageIo, "failed to write bookmark").with_cause(err)
            })?;
        }
    }

    for card in &snapshot.cards {
        tx.execute(
            "INSERT OR REPLACE INTO cards \
             (id, book_hash, front, back, source, cfi, ease, interval_days, reps, lapses, \
              due_at, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                card.id,
                card.book_hash,
                card.front,
                card.back,
                card.source,
                card.cfi,
                card.ease,
                card.interval_days,
                card.reps,
                card.lapses,
                card.due_at,
                card.created_at,
            ],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to write card").with_cause(err)
        })?;
    }

    for stat in &snapshot.stats {
        tx.execute(
            "INSERT OR REPLACE INTO reading_stats (book_hash, day, seconds) VALUES (?1, ?2, ?3)",
            rusqlite::params![stat.hash, stat.day, stat.seconds],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to write stats").with_cause(err)
        })?;
    }

    tx.commit().map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to commit import").with_cause(err)
    })?;
    Ok(snapshot.books.len())
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct StorageBackupRequest {
    pub path: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StorageBackupResponse {
    pub bytes: u64,
    pub checksum: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct StorageRestoreRequest {
    pub path: String,
    pub checksum: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
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
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    request: StorageRestoreRequest,
) -> Result<StorageRestoreResponse, AppError> {
    let mut conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    let path = Path::new(&request.path);
    // 两种备份长得不一样,按扩展名分派:桌面端自己导的是 SQLite 快照(.db),
    // 浏览器端导出的是 JSON(里面带着书籍字节)。
    if path.extension().and_then(|value| value.to_str()) == Some("json") {
        let base = app.path().app_data_dir().map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "app data directory unavailable").with_cause(err)
        })?;
        import_json_snapshot(&mut conn, path, &crate::library::imported_books_dir(&base))?;
    } else {
        restore_from(&mut conn, path, &request.checksum)?;
    }
    Ok(StorageRestoreResponse { restored: true })
}

#[cfg(test)]
mod tests {
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

    // ---------- 浏览器备份(JSON)的导入 ----------

    /// 一份最小的浏览器备份。形状抄自 `apps/desktop/src/lib/web-store.ts` 的
    /// `exportSnapshot` —— 这两边是一份跨端契约,改了要一起改。
    fn browser_snapshot(hash: &str) -> serde_json::Value {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD.encode(b"epub-bytes");
        serde_json::json!({
            "version": 1,
            "createdAt": "2026-09-30T00:00:00.000Z",
            "books": [{
                "hash": hash,
                "fileName": "book.epub",
                "displayName": "示例书",
                "author": "某人",
                "subtitle": null,
                "publisher": null,
                "language": "zh",
                "format": "epub",
                "path": "",
                "size": 10,
                "addedAt": "2026-09-30T00:00:00.000Z",
                "progress": null,
                "tags": ["科技"]
            }],
            "files": [{ "hash": hash, "fileName": "book.epub", "data": bytes }],
            "covers": [],
            "states": [{
                "hash": hash,
                "progress": { "cfi": "epubcfi(/6/4)", "fraction": 0.42 },
                "annotations": [{
                    "id": "n1", "cfi": "epubcfi(/6/6)", "color": "yellow",
                    "note": "我的笔记", "excerpt": "原文"
                }],
                "bookmarks": [],
                "updatedAt": "2026-09-30T00:00:00.000Z"
            }],
            "stats": [{ "key": "k", "day": "2026-09-30", "hash": hash, "seconds": 600 }],
            "cards": [{
                "id": "c1", "bookHash": hash, "front": "问", "back": "答",
                "source": "highlight", "ease": 2.5, "intervalDays": 0,
                "reps": 0, "lapses": 0, "dueAt": "2026-09-30T00:00:00.000Z",
                "createdAt": "2026-09-30T00:00:00.000Z"
            }],
            // 故意给个假值:Rust 侧不读它(见 import_json_snapshot 的说明)。
            "checksum": "not-read-by-rust"
        })
    }

    fn write_snapshot(
        tag: &str,
        hash: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let base = temp_dir(tag);
        let books_dir = base.join("imported-books");
        let json_path = base.join("backup.json");
        std::fs::write(&json_path, browser_snapshot(hash).to_string()).unwrap();
        (base, books_dir, json_path)
    }

    #[test]
    fn json_snapshot_brings_over_books_progress_and_bytes() {
        let hash = "a".repeat(64);
        let (_base, books_dir, json_path) = write_snapshot("json-import", &hash);

        let mut conn = memory_db();
        assert_eq!(
            import_json_snapshot(&mut conn, &json_path, &books_dir).unwrap(),
            1
        );

        let books = crate::library::list_books(&conn).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].display_name.as_deref(), Some("示例书"));
        assert_eq!(books[0].tags, vec!["科技".to_string()]);
        // path 指向刚写出来的文件,而且内容就是备份里那份字节 —— 那些书原本
        // 只活在浏览器里,收下备份就必须自己存一份。
        assert!(books[0].path.starts_with(books_dir.to_str().unwrap()));
        assert_eq!(std::fs::read(&books[0].path).unwrap(), b"epub-bytes");

        let fraction: f64 = conn
            .query_row(
                "SELECT fraction FROM progress WHERE book_hash = ?1",
                [&hash],
                |row| row.get(0),
            )
            .unwrap();
        assert!((fraction - 0.42).abs() < 1e-9);

        let note: String = conn
            .query_row("SELECT note FROM annotations WHERE id = 'n1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(note, "我的笔记");

        let seconds: i64 = conn
            .query_row(
                "SELECT seconds FROM reading_stats WHERE book_hash = ?1",
                [&hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(seconds, 600);

        let cards: i64 = conn
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .unwrap();
        assert_eq!(cards, 1);
    }

    #[test]
    fn json_snapshot_replaces_instead_of_merging() {
        let hash = "a".repeat(64);
        let (_base, books_dir, json_path) = write_snapshot("json-replace", &hash);

        let mut conn = memory_db();
        // 先塞一本别的书:导入之后它该没了 —— 恢复是"以备份为准",不合并。
        conn.execute(
            "INSERT INTO books (hash, file_name, format, path, size, added_at) \
             VALUES ('old', 'o.epub', 'epub', '/o', 1, 't')",
            [],
        )
        .unwrap();

        import_json_snapshot(&mut conn, &json_path, &books_dir).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "旧书该被替换掉,而不是并进来");
        let survivor: String = conn
            .query_row("SELECT hash FROM books", [], |row| row.get(0))
            .unwrap();
        assert_eq!(survivor, hash);
    }

    #[test]
    fn json_snapshot_rejects_bad_input_without_touching_the_library() {
        let base = temp_dir("json-reject");
        let books_dir = base.join("imported-books");
        let mut conn = memory_db();
        conn.execute(
            "INSERT INTO books (hash, file_name, format, path, size, added_at) \
             VALUES ('keep', 'k.epub', 'epub', '/k', 1, 't')",
            [],
        )
        .unwrap();

        // 结构不对(books 缺了必填的 format)。
        let broken = base.join("broken.json");
        std::fs::write(&broken, r#"{"version":1,"books":[{"hash":"a"}]}"#).unwrap();
        let err =
            import_json_snapshot(&mut conn, &broken, &books_dir).expect_err("结构不对必须拒绝");
        assert_eq!(err.code.as_str(), "SYSTEM_VALIDATION");

        // 版本不认识。
        let future = base.join("future.json");
        std::fs::write(&future, r#"{"version":99,"books":[]}"#).unwrap();
        let err =
            import_json_snapshot(&mut conn, &future, &books_dir).expect_err("版本不对必须拒绝");
        assert_eq!(err.code.as_str(), "SYSTEM_VALIDATION");

        // 两次拒绝之后,原来那本书一根毫毛都没少。
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
