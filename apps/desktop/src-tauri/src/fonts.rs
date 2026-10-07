//! User-imported reading fonts.
//!
//! Font files live under `<data>/fonts/` and are served to the webview via
//! the asset protocol; the reader injects matching `@font-face` rules into
//! the book document so custom typefaces apply to reflowable content.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::Digest;
use ts_rs::TS;

use crate::error::{AppError, ErrorCode};

const FONT_EXTENSIONS: &[&str] = &["ttf", "otf", "woff", "woff2"];

/// Absolute directory for imported fonts.
pub fn fonts_dir(base: &std::path::Path) -> PathBuf {
    base.join("fonts")
}

fn is_font_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    FONT_EXTENSIONS
        .iter()
        .any(|extension| lower.ends_with(extension))
}

#[derive(Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReadingFont {
    /// Stable id: hash of the file name (renames re-import as new fonts).
    pub id: String,
    /// Display name: file stem.
    pub name: String,
    pub file_name: String,
    /// Absolute path, for the asset-protocol @font-face src.
    pub path: String,
}

pub fn font_id(file_name: &str) -> String {
    let digest = sha2::Sha256::digest(file_name.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("font-{}", &hex[..16])
}

pub fn list_fonts(base: &std::path::Path) -> Vec<ReadingFont> {
    let dir = fonts_dir(base);
    let mut fonts: Vec<ReadingFont> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return fonts;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !is_font_file(&file_name) {
            continue;
        }
        let name = file_name
            .rsplit_once('.')
            .map(|(stem, _)| stem.to_string())
            .unwrap_or_else(|| file_name.clone());
        fonts.push(ReadingFont {
            id: font_id(&file_name),
            name,
            path: entry.path().to_string_lossy().to_string(),
            file_name,
        });
    }
    fonts.sort_by_key(|font| font.name.to_lowercase());
    fonts
}

/// Copy a user-picked font file into the managed directory.
pub fn import_font(base: &std::path::Path, source_path: &str) -> Result<ReadingFont, AppError> {
    let source = std::path::Path::new(source_path);
    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| {
            AppError::new(ErrorCode::SystemValidation, "路径没有文件名")
                .with_context("field", serde_json::Value::String("path".into()))
        })?;
    if !is_font_file(&file_name) {
        return Err(AppError::new(
            ErrorCode::BookUnsupportedFormat,
            "只支持 TTF / OTF / WOFF / WOFF2 字体文件",
        ));
    }
    let dir = fonts_dir(base);
    std::fs::create_dir_all(&dir)
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "无法创建字体目录").with_cause(err))?;
    let destination = dir.join(&file_name);
    std::fs::copy(source, &destination)
        .map_err(|err| AppError::new(ErrorCode::StorageIo, "字体文件复制失败").with_cause(err))?;
    Ok(ReadingFont {
        id: font_id(&file_name),
        name: file_name
            .rsplit_once('.')
            .map(|(stem, _)| stem.to_string())
            .unwrap_or_else(|| file_name.clone()),
        path: destination.to_string_lossy().to_string(),
        file_name,
    })
}

pub fn remove_font(base: &std::path::Path, id: &str) -> Result<bool, AppError> {
    for font in list_fonts(base) {
        if font.id == id {
            let path = fonts_dir(base).join(&font.file_name);
            std::fs::remove_file(&path).map_err(|err| {
                AppError::new(ErrorCode::StorageIo, "字体文件删除失败").with_cause(err)
            })?;
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command(rename = "fonts.list")]
pub fn command_fonts_list(app: tauri::AppHandle) -> Result<Vec<ReadingFont>, AppError> {
    let base = crate::ai::data_dir(&app)?;
    Ok(list_fonts(&base))
}

#[tauri::command(rename = "fonts.import")]
pub fn command_fonts_import(
    app: tauri::AppHandle,
    request: FontImportRequest,
) -> Result<ReadingFont, AppError> {
    let base = crate::ai::data_dir(&app)?;
    import_font(&base, &request.path)
}

#[tauri::command(rename = "fonts.remove")]
pub fn command_fonts_remove(
    app: tauri::AppHandle,
    request: FontRemoveRequest,
) -> Result<bool, AppError> {
    let base = crate::ai::data_dir(&app)?;
    remove_font(&base, &request.id)
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct FontImportRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct FontRemoveRequest {
    pub id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_id_is_stable_and_prefixed() {
        assert_eq!(font_id("A.ttf"), font_id("A.ttf"));
        assert_ne!(font_id("A.ttf"), font_id("B.ttf"));
        assert!(font_id("A.ttf").starts_with("font-"));
    }

    #[test]
    fn only_font_extensions_accepted() {
        let base = std::env::temp_dir().join("deepread-fonts-test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("fonts")).unwrap();
        let good = base.join("fonts").join("MyFont.ttf");
        std::fs::write(&good, b"fake").unwrap();
        let imported = import_font(&base, good.to_str().unwrap()).unwrap();
        assert_eq!(imported.name, "MyFont");
        assert_eq!(list_fonts(&base).len(), 1);

        let bad = base.join("notes.txt");
        std::fs::write(&bad, b"x").unwrap();
        assert!(import_font(&base, bad.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn remove_font_targets_by_id() {
        let base = std::env::temp_dir().join("deepread-fonts-rm-test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("fonts")).unwrap();
        let file = base.join("fonts").join("X.otf");
        std::fs::write(&file, b"fake").unwrap();
        let imported = import_font(&base, file.to_str().unwrap()).unwrap();
        assert!(remove_font(&base, &imported.id).unwrap());
        assert!(list_fonts(&base).is_empty());
        assert!(!remove_font(&base, "missing").unwrap());
        let _ = std::fs::remove_dir_all(&base);
    }
}
