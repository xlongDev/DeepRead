//! StarDict dictionaries registered in SQLite. Files stay at their original
//! location; parsing happens in the frontend (see
//! `packages/reader-adapter/src/dictionary/stardict.ts`).

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use tauri::Manager;

use crate::error::{AppError, ErrorCode};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DictionaryMeta {
    pub id: String,
    pub name: String,
    pub word_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sametypesequence: Option<String>,
    pub ifo_path: String,
    pub idx_path: String,
    pub dict_path: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DictionaryRegisterRequest {
    pub path: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DictionaryListResponse {
    pub dictionaries: Vec<DictionaryMeta>,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DictionaryRegisterResponse {
    pub dictionary: DictionaryMeta,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DictionaryRemoveRequest {
    pub id: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DictionaryRemoveResponse {
    pub removed: bool,
}

/// Minimal `.ifo` parse: `key=value` lines; we need bookname, wordcount and
/// sametypesequence.
pub fn parse_ifo(text: &str) -> Result<(String, u64, Option<String>), AppError> {
    let mut bookname: Option<String> = None;
    let mut wordcount: Option<u64> = None;
    let mut sametypesequence: Option<String> = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "bookname" => bookname = Some(value.trim().to_string()),
            "wordcount" => wordcount = value.trim().parse::<u64>().ok(),
            "sametypesequence" => sametypesequence = Some(value.trim().to_string()),
            _ => {}
        }
    }
    match (bookname, wordcount) {
        (Some(name), Some(count)) => Ok((name, count, sametypesequence)),
        (None, _) => Err(AppError::new(
            ErrorCode::SystemValidation,
            "ifo is missing bookname",
        )),
        (_, None) => Err(AppError::new(
            ErrorCode::SystemValidation,
            "ifo is missing wordcount",
        )),
    }
}

fn sibling_with_extension(ifo_path: &Path, extension: &str) -> Option<PathBuf> {
    let stem = ifo_path.file_stem()?;
    let parent = ifo_path.parent()?;
    let mut name = stem.to_string_lossy().to_string();
    name.push_str(extension);
    let candidate = parent.join(name);
    candidate.exists().then_some(candidate)
}

fn row_to_dictionary(row: &rusqlite::Row<'_>) -> rusqlite::Result<DictionaryMeta> {
    Ok(DictionaryMeta {
        id: row.get("id")?,
        name: row.get("name")?,
        word_count: row.get::<_, i64>("word_count")? as u64,
        sametypesequence: row.get("sametypesequence")?,
        ifo_path: row.get("ifo_path")?,
        idx_path: row.get("idx_path")?,
        dict_path: row.get("dict_path")?,
    })
}

pub fn list_dictionaries(conn: &Connection) -> Result<Vec<DictionaryMeta>, AppError> {
    let mut statement = conn
        .prepare("SELECT id, name, word_count, sametypesequence, ifo_path, idx_path, dict_path FROM dictionaries ORDER BY name")
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to query dictionaries").with_cause(err))?;
    let dictionaries = statement
        .query_map([], row_to_dictionary)
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read dictionaries").with_cause(err)
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to read dictionary row").with_cause(err)
        })?;
    Ok(dictionaries)
}

pub fn remove_dictionary(conn: &Connection, id: &str) -> Result<bool, AppError> {
    let removed = conn
        .execute("DELETE FROM dictionaries WHERE id = ?1", [id])
        .map_err(|err| {
            AppError::new(ErrorCode::StorageIo, "failed to remove dictionary").with_cause(err)
        })?;
    Ok(removed > 0)
}

/// Register flow: validate the `.ifo`, require the sibling `.idx` and
/// `.dict(.dz)`, allow all three on the asset protocol, upsert the record.
pub fn register_dictionary(
    conn: &Connection,
    raw_path: &str,
    allow_asset: &dyn Fn(&Path) -> Result<(), AppError>,
) -> Result<DictionaryMeta, AppError> {
    let ifo_path = PathBuf::from(raw_path);
    if ifo_path.extension().map(|e| e != "ifo").unwrap_or(true) {
        return Err(AppError::new(
            ErrorCode::SystemValidation,
            "请选择 .ifo 词典文件",
        ));
    }
    let (name, word_count, sametypesequence) =
        parse_ifo(&std::fs::read_to_string(&ifo_path).map_err(|err| {
            AppError::new(ErrorCode::BookOpenFailed, "无法读取词典 .ifo").with_cause(err)
        })?)?;
    let idx = sibling_with_extension(&ifo_path, ".idx")
        .or_else(|| sibling_with_extension(&ifo_path, ".idx.gz"))
        .or_else(|| sibling_with_extension(&ifo_path, ".idx.dz"))
        .ok_or_else(|| AppError::new(ErrorCode::BookOpenFailed, "缺少同名的 .idx 索引文件"))?;
    let dict = sibling_with_extension(&ifo_path, ".dict")
        .or_else(|| sibling_with_extension(&ifo_path, ".dict.dz"))
        .or_else(|| sibling_with_extension(&ifo_path, ".dict.gz"))
        .ok_or_else(|| AppError::new(ErrorCode::BookOpenFailed, "缺少同名的 .dict 词典文件"))?;

    for path in [&ifo_path, &idx, &dict] {
        allow_asset(path)?;
    }

    let mut hasher = Sha256::new();
    hasher.update(raw_path.as_bytes());
    let digest = hasher.finalize();
    let id: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();

    let meta = DictionaryMeta {
        id: id[..32].to_string(),
        name,
        word_count,
        sametypesequence,
        ifo_path: raw_path.to_string(),
        idx_path: idx.to_string_lossy().to_string(),
        dict_path: dict.to_string_lossy().to_string(),
    };
    conn.execute(
        "INSERT OR REPLACE INTO dictionaries (id, name, word_count, sametypesequence, ifo_path, idx_path, dict_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            meta.id,
            meta.name,
            meta.word_count as i64,
            meta.sametypesequence,
            meta.ifo_path,
            meta.idx_path,
            meta.dict_path
        ],
    )
    .map_err(|err| AppError::new(ErrorCode::StorageIo, "failed to save dictionary").with_cause(err))?;
    Ok(meta)
}

#[tauri::command(rename = "dictionary.list")]
pub fn dictionary_list(
    db: tauri::State<'_, crate::storage::Db>,
) -> Result<DictionaryListResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(DictionaryListResponse {
        dictionaries: list_dictionaries(&conn)?,
    })
}

#[tauri::command(rename = "dictionary.register")]
pub fn dictionary_register(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::storage::Db>,
    request: DictionaryRegisterRequest,
) -> Result<DictionaryRegisterResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    let dictionary = register_dictionary(&conn, &request.path, &|path| {
        app.asset_protocol_scope().allow_file(path).map_err(|err| {
            AppError::new(
                ErrorCode::SecurityValidationFailed,
                "failed to allow dict path",
            )
            .with_cause(err)
        })
    })?;
    Ok(DictionaryRegisterResponse { dictionary })
}

#[tauri::command(rename = "dictionary.remove")]
pub fn dictionary_remove(
    db: tauri::State<'_, crate::storage::Db>,
    request: DictionaryRemoveRequest,
) -> Result<DictionaryRemoveResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(DictionaryRemoveResponse {
        removed: remove_dictionary(&conn, &request.id)?,
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

    fn no_asset(_path: &Path) -> Result<(), AppError> {
        Ok(())
    }

    #[test]
    fn parses_ifo_metadata() {
        let ifo = "StarDict's dict ifo file\nversion=2.4.2\nbookname=测试词典\nwordcount=1234\nsametypesequence=h\n";
        let (name, count, seq) = parse_ifo(ifo).unwrap();
        assert_eq!(name, "测试词典");
        assert_eq!(count, 1234);
        assert_eq!(seq.as_deref(), Some("h"));
    }

    #[test]
    fn ifo_without_bookname_is_rejected() {
        assert!(parse_ifo("version=2.4.2\nwordcount=1\n").is_err());
    }

    #[test]
    fn register_requires_idx_and_dict_siblings() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-dict-siblings-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let ifo = base.join("test.ifo");
        std::fs::write(&ifo, "bookname=T\nwordcount=1\n").unwrap();
        assert!(register_dictionary(&conn, ifo.to_str().unwrap(), &no_asset).is_err());

        std::fs::write(base.join("test.idx"), b"").unwrap();
        assert!(register_dictionary(&conn, ifo.to_str().unwrap(), &no_asset).is_err());

        std::fs::write(base.join("test.dict.dz"), b"").unwrap();
        let meta = register_dictionary(&conn, ifo.to_str().unwrap(), &no_asset).unwrap();
        assert_eq!(meta.name, "T");
        assert_eq!(meta.word_count, 1);
    }

    #[test]
    fn non_ifo_paths_are_rejected() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-dict-nonifo-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let txt = base.join("test.txt");
        std::fs::write(&txt, "x").unwrap();
        let err = register_dictionary(&conn, txt.to_str().unwrap(), &no_asset)
            .expect_err("non-ifo must be rejected");
        assert_eq!(err.code.as_str(), "SYSTEM_VALIDATION");
    }

    #[test]
    fn list_remove_round_trip() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-dict-roundtrip-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let ifo = base.join("d.ifo");
        std::fs::write(&ifo, "bookname=词典A\nwordcount=10\n").unwrap();
        std::fs::write(base.join("d.idx"), b"").unwrap();
        std::fs::write(base.join("d.dict"), b"").unwrap();
        let meta = register_dictionary(&conn, ifo.to_str().unwrap(), &no_asset).unwrap();

        assert_eq!(list_dictionaries(&conn).unwrap(), vec![meta.clone()]);
        assert!(remove_dictionary(&conn, &meta.id).unwrap());
        assert!(list_dictionaries(&conn).unwrap().is_empty());
    }

    #[test]
    fn register_is_an_upsert_by_path() {
        let conn = memory_db();
        let base = std::env::temp_dir().join(format!(
            "reader-dict-upsert-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let ifo = base.join("d.ifo");
        std::fs::write(&ifo, "bookname=词典A\nwordcount=10\n").unwrap();
        std::fs::write(base.join("d.idx"), b"").unwrap();
        std::fs::write(base.join("d.dict"), b"").unwrap();
        register_dictionary(&conn, ifo.to_str().unwrap(), &no_asset).unwrap();
        register_dictionary(&conn, ifo.to_str().unwrap(), &no_asset).unwrap();
        assert_eq!(list_dictionaries(&conn).unwrap().len(), 1);
    }
}
