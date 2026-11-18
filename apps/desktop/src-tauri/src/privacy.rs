//! 隐蔽阅读模式(ADR-0014):全局热键隐藏/恢复主窗口。
//!
//! 注册与注销都发生在 Rust 侧(插件不给 webview 任何 permission 面)——
//! 开关落 `app_settings`(`privacy.hideHotkey`),setup 时读一次决定是否
//! 注册,设置页的开关经 `privacy.hotkey.set` 即时改注册。热键固定
//! `⌥⌘H`(Windows/Linux `Alt+Meta+H`),行为 = 可见则隐藏、不可见则恢复,
//! 与托盘菜单的「隐藏 / 恢复窗口」共享同一个 toggle。

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use ts_rs::TS;

use crate::error::{AppError, ErrorCode};
use crate::storage::{get_setting, set_setting};

pub const HIDE_HOTKEY_KEY: &str = "privacy.hideHotkey";
/// 全局热键:⌥⌘H(macOS)/ Alt+Meta+H(Windows/Linux)。
pub const HIDE_HOTKEY: &str = "alt+CmdOrMeta+h";

pub fn enabled_from_db(conn: &rusqlite::Connection) -> bool {
    matches!(
        get_setting(conn, HIDE_HOTKEY_KEY).ok().flatten().as_deref(),
        Some("on")
    )
}

/// 窗口可见则隐藏、不可见则恢复(最小化也算不可见,恢复时 unminimize)。
pub fn toggle_hide(app: &tauri::AppHandle) {
    use tauri::Emitter;
    if let Some(window) = app.get_webview_window("main") {
        let visible =
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
        if visible {
            let _ = window.hide();
            // 隐藏态广播给托盘菜单的勾选语义(菜单静态文案,不发也行)。
            let _ = app.emit("privacy:hidden", true);
        } else {
            super::show_main(app);
            let _ = app.emit("privacy:hidden", false);
        }
    }
}

fn register_shortcut(app: &tauri::AppHandle) -> Result<(), AppError> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    app.global_shortcut()
        .on_shortcut(HIDE_HOTKEY, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_hide(app);
            }
        })
        .map_err(|err| {
            AppError::new(
                ErrorCode::SystemValidation,
                "全局热键注册失败:可能被其他应用占用",
            )
            .with_cause(err)
        })
}

/// setup 时按库里存的开关注册(默认关,不注册)。
pub fn register_if_enabled(app: &tauri::AppHandle) {
    let db = app.state::<crate::storage::Db>();
    let enabled = match db.0.lock() {
        Ok(conn) => enabled_from_db(&conn),
        Err(_) => false,
    };
    if enabled && let Err(err) = register_shortcut(app) {
        log::warn!("privacy hotkey registration failed: {err}");
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct PrivacyHotkeySetRequest {
    pub enabled: bool,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrivacyHotkeyResponse {
    pub enabled: bool,
}

/// `privacy.hotkey.set` — 开关落库并即时改注册。注册失败(冲突)时不落
/// "on":设置页看到的值就是真实生效的值。
#[tauri::command(rename = "privacy.hotkey.set")]
pub fn privacy_hotkey_set(
    app: tauri::AppHandle,
    db: State<'_, crate::storage::Db>,
    request: PrivacyHotkeySetRequest,
) -> Result<PrivacyHotkeyResponse, AppError> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if request.enabled {
        register_shortcut(&app)?;
    } else {
        let _ = app.global_shortcut().unregister(HIDE_HOTKEY);
    }
    {
        let conn =
            db.0.lock()
                .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
        set_setting(
            &conn,
            HIDE_HOTKEY_KEY,
            if request.enabled { "on" } else { "off" },
        )?;
    }
    Ok(PrivacyHotkeyResponse {
        enabled: request.enabled,
    })
}

/// `privacy.hotkey.get` — 设置页开关的初值。
#[tauri::command(rename = "privacy.hotkey.get")]
pub fn privacy_hotkey_get(
    db: State<'_, crate::storage::Db>,
) -> Result<PrivacyHotkeyResponse, AppError> {
    let conn =
        db.0.lock()
            .map_err(|_| AppError::new(ErrorCode::StorageIo, "database busy"))?;
    Ok(PrivacyHotkeyResponse {
        enabled: enabled_from_db(&conn),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hotkey_key_matches_the_adr() {
        assert_eq!(HIDE_HOTKEY_KEY, "privacy.hideHotkey");
        assert_eq!(HIDE_HOTKEY, "alt+CmdOrMeta+h");
    }

    #[test]
    fn db_flag_defaults_off_and_round_trips() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::storage::migrate(&conn).unwrap();
        assert!(!enabled_from_db(&conn));
        set_setting(&conn, HIDE_HOTKEY_KEY, "on").unwrap();
        assert!(enabled_from_db(&conn));
        set_setting(&conn, HIDE_HOTKEY_KEY, "off").unwrap();
        assert!(!enabled_from_db(&conn));
    }
}
