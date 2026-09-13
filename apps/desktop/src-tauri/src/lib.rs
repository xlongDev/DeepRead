//! Deepread desktop backend.
//!
//! Layering (spec §2): commands are thin IPC wrappers around pure domain
//! functions; everything below `commands/` must stay runtime-agnostic and
//! unit-testable without a Tauri runtime.

mod ai;
mod cards;
mod commands;
mod dictionary;
mod error;
mod events;
mod library;
mod secrets;
mod state;
mod storage;
mod timestamps;
mod tts;

use log::{info, warn};
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;
            // NOTE: Builder::setup REPLACES any previous closure — keep every
            // startup step inside this single closure.
            let base = app.path().app_data_dir()?;
            let conn = storage::open_db(&library::database_path(&base))?;
            storage::import_legacy(&conn, &base)?;
            // Asset-protocol scope is in-memory only: re-allow every stored
            // book on startup so covers and reading keep working after restart.
            for book in library::list_books(&conn)? {
                if let Err(err) = app.asset_protocol_scope().allow_file(&book.path) {
                    log::warn!("failed to re-allow asset path {}: {err}", book.path);
                }
            }
            // Cached TTS audio is served to the webview the same way.
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
            library::library_list,
            library::library_import,
            library::library_remove,
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
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Deepread");
}
