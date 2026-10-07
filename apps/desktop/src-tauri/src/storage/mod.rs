//! SQLite storage (spec §23/§24): single database file, versioned migrations
//! via `PRAGMA user_version`, a one-time import of the legacy JSON stores it
//! replaces, corruption recovery, backup/restore and a small KV store.
//!
//! B3 拆分为五个子模块(纯移动,行为不变):`migrations` / `recovery` /
//! `legacy_import` / `backup` / `kv`。对 crate 其余部分,这里仍是唯一的
//! `crate::storage::` 命名空间 —— 下列重导出让既有调用点(lib.rs 装配、
//! 各命令模块、集成测试)一行都不用改。

// 子模块设为 pub:`generate_handler!` 的命令宏 helper 必须能从 crate 根以
// `storage::backup::<cmd>` 解析(它们不随 `pub use fn` 迁移);形状项反正都
// 在下面的 `pub use` 里以平铺路径提供。
pub mod backup;
pub mod kv;
pub mod legacy_import;
pub mod migrations;
pub mod recovery;

pub use backup::{
    StorageBackupRequest, StorageBackupResponse, StorageRestoreRequest, StorageRestoreResponse,
    backup_to, file_checksum, import_json_snapshot, restore_from, validate_backup,
};
pub use kv::{get_setting, set_setting};
pub use legacy_import::import_legacy;
pub use migrations::{MIGRATIONS, migrate};
pub use recovery::{open_db, open_db_with_recovery};

// 注意:`storage_backup` / `storage_restore` 两条命令不经重导出提供 —— tauri
// 的 `generate_handler!` 宏要在命令**定义所在模块**里解析其隐藏 helper
// (`__cmd__*`),所以 lib.rs 直接写 `storage::backup::storage_backup`。

use rusqlite::Connection;
use std::sync::Mutex;

/// Handle shared with all commands. `std::sync::Mutex` is enough: no command
/// holds the lock across an `await`.
pub struct Db(pub Mutex<Connection>);
