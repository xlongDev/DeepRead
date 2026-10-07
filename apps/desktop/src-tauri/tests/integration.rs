//! 集成测试:跨模块的完整链路。
//!
//! `docs/development/testing.md` 的第 4 层要求「导入 → 打开 → 进度 → 批注 →
//! 备份 → 恢复(真实文件、真实 SQLite)」。单元测试各管一段,这里验证它们
//! **接起来**能工作 —— 模块边界上的错(比如备份漏了某张表)只有这样才能发现。
//!
//! 用 TXT 而不是 EPUB:导入管线对两者走同一条路(哈希 → 落库 → 解析元数据),
//! 而 TXT 不需要在测试里现造一个合法 zip。EPUB 的真书回归是另一件事
//! (README 里标着「真书样本回归待补」)。

use std::path::{Path, PathBuf};

use deepread_desktop_lib::library::{import_book, list_books};
use deepread_desktop_lib::state::{
    ReaderState, StoredAnnotation, StoredBookmark, StoredProgress, load_state, store_state,
};
use deepread_desktop_lib::storage::{
    backup_to, file_checksum, open_db_with_recovery, restore_from,
};

/// 每次跑用一个独立目录 —— 集成测试是并行执行的,共用路径会互相踩。
fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "deepread-integration-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_book(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    path
}

fn sample_state() -> ReaderState {
    ReaderState {
        progress: Some(StoredProgress {
            cfi: "epubcfi(/6/4)".into(),
            fraction: 0.37,
        }),
        annotations: vec![StoredAnnotation {
            id: "note-1".into(),
            cfi: "epubcfi(/6/6)".into(),
            color: "yellow".into(),
            note: Some("我的笔记".into()),
            excerpt: Some("正文内容。".into()),
            updated_at: None,
            deleted: false,
        }],
        bookmarks: vec![StoredBookmark {
            id: "bm-1".into(),
            cfi: "epubcfi(/6/8)".into(),
            label: Some("标记".into()),
            created_at: "2026-09-30T00:00:00Z".into(),
            deleted: false,
        }],
        updated_at: "2026-09-30T00:00:00Z".into(),
    }
}

#[test]
fn full_round_trip_survives_backup_and_restore() {
    let dir = scratch("round-trip");
    let db_path = dir.join("deepread.db");
    let book_path = write_book(&dir, "夜航书.txt", "第一章\n\n正文内容。\n");

    // 1. 导入:真实文件 → 真实 SQLite。
    let mut conn = open_db_with_recovery(&db_path).unwrap();
    let book = import_book(&conn, book_path.to_str().unwrap()).unwrap();
    assert_eq!(list_books(&conn).unwrap().len(), 1);

    // 2. 进度 + 批注 + 书签。
    store_state(&conn, &book.hash, &sample_state()).unwrap();

    // 3. 备份。
    let backup_path = dir.join("snapshot.db");
    backup_to(&conn, &backup_path).unwrap();
    let checksum = file_checksum(&backup_path).unwrap();

    // 4. 把库改脏 —— 否则"恢复成功"可能只是"本来就在"。
    conn.execute("DELETE FROM books", []).unwrap();
    conn.execute("DELETE FROM reading_stats", []).unwrap();
    assert!(list_books(&conn).unwrap().is_empty(), "清干净了才测得准");

    // 5. 恢复。
    restore_from(&mut conn, &backup_path, &checksum).unwrap();

    // 6. 书、进度、批注、书签全都回来。
    assert_eq!(list_books(&conn).unwrap().len(), 1, "书该回来");
    let state = load_state(&conn, &book.hash).unwrap().expect("状态该在");
    let progress = state.progress.expect("进度该在");
    assert!((progress.fraction - 0.37).abs() < 1e-9, "进度分数");
    assert_eq!(state.annotations.len(), 1);
    assert_eq!(state.annotations[0].note.as_deref(), Some("我的笔记"));
    assert_eq!(state.bookmarks.len(), 1);
}

#[test]
fn a_corrupted_snapshot_is_refused_and_the_library_is_untouched() {
    let dir = scratch("corrupt");
    let db_path = dir.join("deepread.db");
    let book_path = write_book(&dir, "书.txt", "正文。\n");

    let mut conn = open_db_with_recovery(&db_path).unwrap();
    let book = import_book(&conn, book_path.to_str().unwrap()).unwrap();
    store_state(&conn, &book.hash, &sample_state()).unwrap();

    let backup_path = dir.join("snapshot.db");
    backup_to(&conn, &backup_path).unwrap();
    let good_checksum = file_checksum(&backup_path).unwrap();

    // 篡改快照:校验和必须挡住它。挡不住的后果是拿一份坏数据覆盖用户的好数据。
    let mut bytes = std::fs::read(&backup_path).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    std::fs::write(&backup_path, &bytes).unwrap();

    let err =
        restore_from(&mut conn, &backup_path, &good_checksum).expect_err("损坏的快照必须被拒绝");
    assert_eq!(err.code.as_str(), "STORAGE_CORRUPT");

    // 现有数据一根毫毛都没少。
    assert_eq!(list_books(&conn).unwrap().len(), 1);
    let state = load_state(&conn, &book.hash).unwrap().expect("状态还在");
    assert!((state.progress.unwrap().fraction - 0.37).abs() < 1e-9);
}
