//! Deepread desktop backend.
//!
//! Layering (spec §2): commands are thin IPC wrappers around pure domain
//! functions; everything below `commands/` must stay runtime-agnostic and
//! unit-testable without a Tauri runtime.

mod ai;
mod cards;
mod cloud;
mod commands;
mod dictionary;
mod edge_tts;
// 这四个对集成测试(tests/integration.rs)开放 —— 那边要跨模块走完整链路
// 「导入 → 进度 → 批注 → 备份 → 恢复」,只能碰 pub 的东西。其余模块保持私有:
// 命令层之外的内部实现没有理由暴露出去。
pub mod error;
mod events;
mod fonts;
pub mod library;
mod secrets;
pub mod state;
pub mod storage;
mod timestamps;
mod tts;

use log::{info, warn};
use tauri::Emitter;

/// 进程级共享 HTTP 客户端(B2.1):连接池跨命令复用,且显式超时 —— 上游
/// 挂起时不再永久挂住任务。连接 3s(断网/丢包快速失败);不设总超时,
/// ai.chat 是流式长读,`read_timeout` 只掐「块间空闲 30s」,活着的流不受限。
pub fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(3))
            .read_timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client builds")
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            use tauri::Manager;
            // NOTE: Builder::setup REPLACES any previous closure — keep every
            // startup step inside this single closure.
            let base = app.path().app_data_dir()?;
            let conn = storage::open_db_with_recovery(&library::database_path(&base))?;
            storage::import_legacy(&conn, &base)?;
            // Asset-protocol scope is in-memory only: re-allow every stored
            // book on startup so covers and reading keep working after restart.
            for book in library::list_books(&conn)? {
                if let Err(err) = app.asset_protocol_scope().allow_file(&book.path) {
                    log::warn!("failed to re-allow asset path {}: {err}", book.path);
                }
            }
            // Cached TTS audio is served to the webview the same way.
            let fonts_dir = fonts::fonts_dir(&base);
            if let Err(err) = app
                .asset_protocol_scope()
                .allow_directory(&fonts_dir, false)
            {
                log::warn!("failed to allow fonts dir {}: {err}", fonts_dir.display());
            }
            // Cached covers are read straight from disk on every shelf paint.
            let covers_dir = library::covers_dir(&base);
            if let Err(err) = app
                .asset_protocol_scope()
                .allow_directory(&covers_dir, false)
            {
                log::warn!("failed to allow covers dir {}: {err}", covers_dir.display());
            }
            let tts_cache = tts::cache_dir(&base);
            if let Err(err) = app
                .asset_protocol_scope()
                .allow_directory(&tts_cache, false)
            {
                log::warn!("failed to allow tts cache {}: {err}", tts_cache.display());
            }
            app.manage(storage::Db(std::sync::Mutex::new(conn)));

            let payload = events::AppReadyPayload {
                started_at: timestamps::rfc3339_now(),
                app_version: app.package_info().version.to_string(),
            };
            let transport_name = events::transport_name(events::EVENT_APP_READY);
            if let Err(err) = app.handle().emit(&transport_name, payload) {
                warn!("failed to emit {} event: {err}", events::EVENT_APP_READY);
            }
            info!("Deepread backend started");
            Ok(())
        })
        .manage(ai::AiState::default())
        .manage(secrets::SecretStore::Keyring)
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::system::system_ping,
            commands::system::app_info,
            state::reader_state_get,
            state::reader_state_set,
            state::reader_stats_add,
            state::reader_stats_get,
            state::reader_stats_books,
            state::reader_notes_list,
            state::reader_note_update,
            library::library_list,
            library::library_import,
            library::library_remove,
            library::library_info_set,
            library::library_tag_set,
            library::library_cover_get,
            library::library_cover_put,
            library::notes_export,
            dictionary::dictionary_list,
            dictionary::dictionary_register,
            dictionary::dictionary_remove,
            ai::ai_config_list,
            ai::ai_config_save,
            ai::ai_config_remove,
            ai::ai_chat,
            ai::ai_cancel,
            ai::ai_embed,
            ai::ai_index_get,
            ai::ai_index_set,
            ai::ai_artifact_get,
            ai::ai_artifact_set,
            storage::storage_backup,
            storage::storage_restore,
            cards::cards_list,
            cards::cards_add,
            cards::cards_remove,
            cards::cards_review,
            tts::command_tts_audio,
            edge_tts::command_edge_tts_audio,
            edge_tts::command_edge_tts_voices,
            fonts::command_fonts_list,
            fonts::command_fonts_import,
            fonts::command_fonts_remove,
            cloud::cloud_config_get,
            cloud::cloud_config_save,
            cloud::cloud_config_test,
            cloud::cloud_config_clear,
            cloud::cloud_webdav_get,
            cloud::cloud_webdav_put,
            cloud::cloud_backup,
            cloud::cloud_restore,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Deepread");
}

#[cfg(test)]
mod http_tests {
    /// 共享 client 的全部意义就在"是同一个":连接池复用靠它。配置(3s 连接
    /// 超时 / 30s 空闲读超时)无法从 Client 实例反查,由代码评审与断网实测
    /// 验收,这里锁住单例性。
    #[test]
    fn http_client_is_a_shared_singleton() {
        let a = super::http() as *const reqwest::Client;
        let b = super::http() as *const reqwest::Client;
        assert_eq!(a, b);
    }
}
