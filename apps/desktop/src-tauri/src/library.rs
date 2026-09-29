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
    /// Author from the book's own metadata (or edited by hand). Shown on the
    /// shelf card, so it lives here rather than behind a separate query.
    pub author: Option<String>,
    pub subtitle: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub format: String,
    pub path: String,
    pub size: u64,
    pub added_at: String,
    /// Reading fraction from `progress`, joined in so the shelf needs one query
    /// instead of one `reader.state.get` per book.
    pub progress: Option<f64>,
    /// User collections. Stored as a JSON array of strings in `books.tags`.
    pub tags: Vec<String>,
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
pub struct LibraryTagSetRequest {
    pub book_hash: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTagSetResponse {
    pub book: LibraryBook,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryCoverGetRequest {
    pub book_hash: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCoverGetResponse {
    /// Absolute path of the cached cover; `null` = not cached yet.
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryCoverPutRequest {
    pub book_hash: String,
    /// Base64 of the extracted cover image.
    pub data: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCoverPutResponse {
    pub path: String,
}

/// 书籍元数据的整表提交:面板一次给出全部字段,`None` / 空串 = 清空该项。
/// 不做"只写变化列"的局部更新 —— 那要动态拼 SQL,而面板本来就是整表编辑。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryInfoSetRequest {
    pub book_hash: String,
    pub display_name: Option<String>,
    pub author: Option<String>,
    pub subtitle: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfoSetResponse {
    pub book: LibraryBook,
}

/// 重新导入时要原样保留的既有元数据。不含 path/size —— 那两个每次都要刷新,
/// 保留它们反而是错的。
struct ExistingBookMeta {
    added_at: String,
    display_name: Option<String>,
    tags: Vec<String>,
    author: Option<String>,
    subtitle: Option<String>,
    publisher: Option<String>,
    language: Option<String>,
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
        author: row.get("author")?,
        subtitle: row.get("subtitle")?,
        publisher: row.get("publisher")?,
        language: row.get("language")?,
        format: row.get("format")?,
        path: row.get("path")?,
        size: row.get::<_, i64>("size")? as u64,
        added_at: row.get("added_at")?,
        progress: row.get("progress")?,
        tags: parse_tags(row.get::<_, String>("tags").unwrap_or_default().as_str()),
    })
}

/// Tags live as a JSON array; a malformed value degrades to "no tags" rather
/// than making the whole shelf unreadable.
fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

/// One row per book with its reading fraction (LEFT JOIN: unread books are
/// `None`). The shelf used to ask for `reader.state.get` per book, which
/// serialized on the global database lock.
pub fn list_books(conn: &Connection) -> Result<Vec<LibraryBook>, AppError> {
    let mut statement = conn
        .prepare(
            "SELECT b.hash, b.file_name, b.display_name, b.author, b.subtitle, b.publisher, b.language, b.format, b.path, b.size, b.added_at,
                    b.tags, p.fraction AS progress
             FROM books b
             LEFT JOIN progress p ON p.book_hash = b.hash
             ORDER BY b.added_at DESC, b.rowid DESC",
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to query library").with_cause(err)
        })?;
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
        "reading_stats",
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

/// Replace a book's tags. Input is normalized (trimmed, deduped, capped) so a
/// runaway UI can neither bloat the row nor store whitespace-only tags.
pub fn set_tags(conn: &Connection, hash: &str, tags: &[String]) -> Result<LibraryBook, AppError> {
    crate::state::validate_hash(hash)?;
    let mut normalized: Vec<String> = Vec::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() || trimmed.chars().count() > 32 {
            continue;
        }
        if !normalized.iter().any(|existing| existing == trimmed) {
            normalized.push(trimmed.to_string());
        }
        if normalized.len() >= 20 {
            break;
        }
    }
    let updated = conn
        .execute(
            "UPDATE books SET tags = ?1 WHERE hash = ?2",
            rusqlite::params![
                serde_json::to_string(&normalized).unwrap_or_else(|_| "[]".to_string()),
                hash
            ],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to save tags").with_cause(err)
        })?;
    if updated == 0 {
        return Err(AppError::new(
            ErrorCode::BookOpenFailed,
            "book not in library",
        ));
    }
    get_book(conn, hash)
}

/// Set the shelf title for a book (the frontend resolves it from the book's
/// own metadata and backfills older rows).
/// 写书籍元数据。空白项一律存 NULL —— 空串与"没填"在界面上是同一件事,
/// 存成两种值只会让后面每次判断都要兼顾。
pub fn set_book_info(
    conn: &Connection,
    hash: &str,
    request: &LibraryInfoSetRequest,
) -> Result<LibraryBook, AppError> {
    crate::state::validate_hash(hash)?;
    fn clean(value: &Option<String>) -> Option<String> {
        value
            .as_ref()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
    }
    let updated = conn
        .execute(
            "UPDATE books SET display_name = ?1, author = ?2, subtitle = ?3,
                    publisher = ?4, language = ?5
             WHERE hash = ?6",
            rusqlite::params![
                clean(&request.display_name),
                clean(&request.author),
                clean(&request.subtitle),
                clean(&request.publisher),
                clean(&request.language),
                hash,
            ],
        )
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to update book info").with_cause(err)
        })?;
    if updated == 0 {
        return Err(AppError::new(
            ErrorCode::BookOpenFailed,
            "book not in library",
        ));
    }
    get_book(conn, hash)
}

/// Import flow: validate the picked file, hash it, upsert the record keeping
/// the original `added_at`.
/// Read one book (with its progress) by hash.
fn get_book(conn: &Connection, hash: &str) -> Result<LibraryBook, AppError> {
    conn.query_row(
        "SELECT b.hash, b.file_name, b.display_name, b.author, b.subtitle, b.publisher, b.language, b.format, b.path, b.size, b.added_at,
                b.tags, p.fraction AS progress
         FROM books b
         LEFT JOIN progress p ON p.book_hash = b.hash
         WHERE b.hash = ?1",
        [hash],
        row_to_book,
    )
    .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to read book").with_cause(err))
}

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
    // Re-importing a known file keeps its added_at and everything the user or the
    // book itself已经填好的元数据 —— 重新导入通常是因为文件搬了位置,不是要重来一遍。
    let existing: Option<ExistingBookMeta> = conn
        .query_row(
            "SELECT added_at, display_name, tags, author, subtitle, publisher, language
             FROM books WHERE hash = ?1",
            [&hash],
            |row| {
                Ok(ExistingBookMeta {
                    added_at: row.get(0)?,
                    display_name: row.get(1)?,
                    tags: parse_tags(row.get::<_, String>(2)?.as_str()),
                    author: row.get(3)?,
                    subtitle: row.get(4)?,
                    publisher: row.get(5)?,
                    language: row.get(6)?,
                })
            },
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
        display_name: existing.as_ref().and_then(|meta| meta.display_name.clone()),
        author: existing.as_ref().and_then(|meta| meta.author.clone()),
        subtitle: existing.as_ref().and_then(|meta| meta.subtitle.clone()),
        publisher: existing.as_ref().and_then(|meta| meta.publisher.clone()),
        language: existing.as_ref().and_then(|meta| meta.language.clone()),
        format: format.to_string(),
        path: raw_path.to_string(),
        size,
        added_at: existing
            .as_ref()
            .map(|meta| meta.added_at.clone())
            .unwrap_or_else(crate::timestamps::rfc3339_now),
        progress: None,
        tags: existing
            .as_ref()
            .map(|meta| meta.tags.clone())
            .unwrap_or_default(),
    };
    conn.execute(
        "INSERT OR REPLACE INTO books
             (hash, file_name, display_name, format, path, size, added_at, tags,
              author, subtitle, publisher, language)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            book.hash,
            book.file_name,
            book.display_name,
            book.format,
            book.path,
            book.size as i64,
            book.added_at,
            serde_json::to_string(&book.tags).unwrap_or_else(|_| "[]".to_string()),
            book.author,
            book.subtitle,
            book.publisher,
            book.language,
        ],
    )
    .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to save book").with_cause(err))?;
    // Re-read so the caller gets the row the shelf renders (progress included).
    get_book(conn, &book.hash)
}

pub fn database_path(base: &Path) -> PathBuf {
    base.join("deepread.db")
}

/* ---------- Cover cache ----------
Covers cost a zip parse (EPUB/MOBI) or a PDF render each; paying that on
every app start is pure waste, so the first extraction is written next to
the database and the shelf only reads a file afterwards. */

pub fn covers_dir(base: &Path) -> PathBuf {
    base.join("covers")
}

/// Extensions we write; `get` probes them in this order.
const COVER_EXTENSIONS: [&str; 4] = ["png", "jpg", "webp", "gif"];

/// Sniff the real image type: the extension decides what the asset protocol
/// serves, and a wrong one makes `<img>` fail to decode.
fn cover_extension(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(b"GIF8") {
        "gif"
    } else {
        // Unknown magic: covers we produce are PNG, so that is the best guess.
        "png"
    }
}

fn cover_path(base: &Path, hash: &str, extension: &str) -> PathBuf {
    covers_dir(base).join(format!("{hash}.{extension}"))
}

/// Cached cover for a book, if we already extracted one.
pub fn cover_path_if_exists(base: &Path, hash: &str) -> Option<PathBuf> {
    COVER_EXTENSIONS
        .iter()
        .map(|extension| cover_path(base, hash, extension))
        .find(|path| path.exists())
}

/// Store a cover we just extracted. `data` is base64 (bytes over JSON IPC).
pub fn save_cover(base: &Path, hash: &str, data: &str) -> Result<PathBuf, AppError> {
    crate::state::validate_hash(hash)?;
    let bytes = base64_decode(data).ok_or_else(|| {
        AppError::new(ErrorCode::SystemValidation, "cover is not valid base64")
            .with_context("field", "data")
    })?;
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "cover size out of range",
        ));
    }
    let dir = covers_dir(base);
    std::fs::create_dir_all(&dir).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to create covers dir").with_cause(err)
    })?;
    let path = cover_path(base, hash, cover_extension(&bytes));
    std::fs::write(&path, &bytes).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to write cover").with_cause(err)
    })?;
    Ok(path)
}

/// Base64 (standard alphabet, with padding) — the only decoding this app needs.
fn base64_decode(data: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

/// Drop a cached cover when its book leaves the shelf (best effort).
pub fn delete_cover(base: &Path, hash: &str) {
    for extension in COVER_EXTENSIONS {
        let path = cover_path(base, hash, extension);
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
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
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    request: LibraryRemoveRequest,
) -> Result<LibraryRemoveResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    let removed = remove_book(&conn, &request.book_hash)?;
    if removed {
        // The cached cover goes with it; a missing file is not an error.
        if let Ok(base) = crate::ai::data_dir(&app) {
            delete_cover(&base, &request.book_hash);
        }
    }
    Ok(LibraryRemoveResponse { removed })
}

#[tauri::command(rename = "library.tag.set")]
pub fn library_tag_set(
    db: tauri::State<'_, Db>,
    request: LibraryTagSetRequest,
) -> Result<LibraryTagSetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(LibraryTagSetResponse {
        book: set_tags(&conn, &request.book_hash, &request.tags)?,
    })
}

#[tauri::command(rename = "library.cover.get")]
pub fn library_cover_get(
    app: tauri::AppHandle,
    request: LibraryCoverGetRequest,
) -> Result<LibraryCoverGetResponse, AppError> {
    crate::state::validate_hash(&request.book_hash)?;
    let base = crate::ai::data_dir(&app)?;
    Ok(LibraryCoverGetResponse {
        path: cover_path_if_exists(&base, &request.book_hash)
            .map(|path| path.to_string_lossy().to_string()),
    })
}

#[tauri::command(rename = "library.cover.put")]
pub fn library_cover_put(
    app: tauri::AppHandle,
    request: LibraryCoverPutRequest,
) -> Result<LibraryCoverPutResponse, AppError> {
    let base = crate::ai::data_dir(&app)?;
    let path = save_cover(&base, &request.book_hash, &request.data)?;
    // Same asset protocol as books/fonts: the webview can only read what we
    // allow, and this file is one we just wrote ourselves.
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|err| {
            AppError::new(
                ErrorCode::SecurityValidationFailed,
                "failed to allow cover path",
            )
            .with_cause(err)
        })?;
    Ok(LibraryCoverPutResponse {
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command(rename = "library.info.set")]
pub fn library_info_set(
    db: tauri::State<'_, Db>,
    request: LibraryInfoSetRequest,
) -> Result<LibraryInfoSetResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(LibraryInfoSetResponse {
        book: set_book_info(&conn, &request.book_hash, &request)?,
    })
}

/// 把批注写到本地 Markdown:桌面端走系统保存对话框,而不是浏览器 Blob
/// 下载 —— WebView 默认会拦截 `<a download>`,用户点了什么都不会发生。
/// 内容在 Rust 里 UTF-8 落盘,前端拿到 `path`/`cancelled` 之一。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotesExportRequest {
    /// 完整 Markdown 文本,UTF-8。
    pub markdown: String,
    /// 系统保存对话框的默认文件名(不含扩展名也接受,我们会拼上 `.md`)。
    pub default_name: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotesExportResponse {
    /// 用户最终选定的绝对路径;`null` = 用户取消了对话框。
    pub path: Option<String>,
}

#[tauri::command(rename = "notes.export")]
pub async fn notes_export<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: NotesExportRequest,
) -> Result<NotesExportResponse, AppError> {
    use tauri_plugin_dialog::DialogExt;
    // 默认名兜底:用户也可能传空串过来。
    let name = if request.default_name.trim().is_empty() {
        "批注".to_string()
    } else {
        request.default_name.trim().to_string()
    };
    let path = app
        .dialog()
        .file()
        .set_title("导出批注")
        .set_file_name(&format!("{name}.md"))
        .add_filter("Markdown", &["md"])
        .blocking_save_file();
    let Some(file_path) = path else {
        return Ok(NotesExportResponse { path: None });
    };
    let target = file_path
        .into_path()
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "invalid save path").with_cause(err))?;
    std::fs::write(&target, request.markdown.as_bytes()).map_err(|err| {
        AppError::new(ErrorCode::StorageIo, "failed to write markdown").with_cause(err)
    })?;
    Ok(NotesExportResponse {
        path: Some(target.to_string_lossy().to_string()),
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
            author: Some("A Writer".into()),
            subtitle: None,
            publisher: None,
            language: Some("zh".into()),
            format: "epub".into(),
            path: "/tmp/a.epub".into(),
            size: 3,
            added_at: "2026-09-09T00:00:00Z".into(),
            progress: Some(0.25),
            tags: vec!["技术".into()],
        };
        let json = serde_json::to_value(&book).unwrap();
        assert_eq!(json["fileName"], "a.epub");
        assert_eq!(json["displayName"], "A Book");
        // 新增的元数据也要按 camelCase 出线,前端才拿得到。
        assert_eq!(json["author"], "A Writer");
        assert_eq!(json["language"], "zh");
        assert_eq!(json["addedAt"], "2026-09-09T00:00:00Z");
        assert_eq!(json["progress"], 0.25);
        assert_eq!(json["tags"][0], "技术");
    }

    #[test]
    fn tags_round_trip_are_normalized_and_survive_reimport() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-lib-tags-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("book.epub");
        std::fs::write(&path, b"epub-bytes").unwrap();
        let book = import_book(&conn, path.to_str().unwrap()).unwrap();
        assert!(book.tags.is_empty());

        let tagged = set_tags(
            &conn,
            &book.hash,
            &[
                " 技术 ".into(),
                "技术".into(),
                "".into(),
                "在读".into(),
                "x".repeat(40),
            ],
        )
        .unwrap();
        assert_eq!(tagged.tags, vec!["技术".to_string(), "在读".to_string()]);
        assert_eq!(
            list_books(&conn).unwrap()[0].tags,
            tagged.tags,
            "joined row"
        );

        // Moving the file must not wipe the user's collections.
        let reimported = import_book(&conn, path.to_str().unwrap()).unwrap();
        assert_eq!(reimported.tags, tagged.tags);

        let cleared = set_tags(&conn, &book.hash, &[]).unwrap();
        assert!(cleared.tags.is_empty());
    }

    #[test]
    fn cover_cache_round_trips_and_sniffs_the_image_type() {
        let base = std::env::temp_dir().join(format!(
            "reader-cover-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let hash = "e".repeat(64);

        assert!(cover_path_if_exists(&base, &hash).is_none());

        // A real PNG signature, base64-encoded.
        let png = "iVBORw0KGgoAAAANSUhEUg==";
        let path = save_cover(&base, &hash, png).unwrap();
        assert_eq!(path.extension().unwrap(), "png");
        assert_eq!(cover_path_if_exists(&base, &hash), Some(path.clone()));
        assert!(path.exists());

        // A JPEG signature rewrites the same book's cover with a jpg name.
        let jpeg = "/9j/4AAQSkZJRg==";
        let jpeg_path = save_cover(&base, &hash, jpeg).unwrap();
        assert_eq!(jpeg_path.extension().unwrap(), "jpg");

        delete_cover(&base, &hash);
        assert!(cover_path_if_exists(&base, &hash).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cover_put_rejects_garbage_and_oversized_payloads() {
        let base = std::env::temp_dir().join("reader-cover-invalid");
        let hash = "f".repeat(64);
        assert!(save_cover(&base, &hash, "not base64 !!").is_err());
        assert!(save_cover(&base, &hash, "").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn listing_returns_progress_without_a_second_query_per_book() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-lib-join-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let read = base.join("read.epub");
        std::fs::write(&read, b"read-bytes").unwrap();
        let unread = base.join("unread.epub");
        std::fs::write(&unread, b"unread-bytes").unwrap();

        let read_book = import_book(&conn, read.to_str().unwrap()).unwrap();
        import_book(&conn, unread.to_str().unwrap()).unwrap();
        conn.execute(
            "INSERT INTO progress (book_hash, cfi, fraction, updated_at) VALUES (?1, 'c', 0.5, 'now')",
            [&read_book.hash],
        )
        .unwrap();

        let books = list_books(&conn).unwrap();
        let progress_of =
            |hash: &str| -> Option<f64> { books.iter().find(|book| book.hash == hash)?.progress };
        assert_eq!(progress_of(&read_book.hash), Some(0.5));
        assert!(
            books.iter().any(|book| book.progress.is_none()),
            "unread books must report no progress"
        );
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

        let renamed = set_book_info(
            &conn,
            &imported.hash,
            &LibraryInfoSetRequest {
                book_hash: imported.hash.clone(),
                display_name: Some("夜航书".to_string()),
                // 同一张表里的其它元数据:一次提交,一起落库。
                author: Some("圣埃克苏佩里".to_string()),
                subtitle: Some("   ".to_string()),
                publisher: None,
                language: Some("zh".to_string()),
            },
        )
        .unwrap();
        assert_eq!(renamed.display_name.as_deref(), Some("夜航书"));
        assert_eq!(renamed.author.as_deref(), Some("圣埃克苏佩里"));
        assert_eq!(renamed.language.as_deref(), Some("zh"));
        // 空白与 None 都是"没填":两者都存 NULL,免得后面每次判断都要兼顾两种空。
        assert_eq!(renamed.subtitle, None);
        assert_eq!(renamed.publisher, None);
        assert_eq!(renamed.file_name, "garbage (z-library).epub");

        // Moving/renaming the file re-imports the same content: the resolved
        // title must not be lost.
        let reimported = import_book(&conn, path.to_str().unwrap()).unwrap();
        assert_eq!(reimported.display_name.as_deref(), Some("夜航书"));
    }
}
