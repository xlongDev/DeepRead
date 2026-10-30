//! Event catalog — the Rust mirror of `packages/shared/src/protocol/events.ts`.
//!
//! Logical names use dots (`app.ready`); Tauri event names forbid dots, so the
//! transport name replaces `.` with `:` (`app:ready`). The frontend
//! `listenEvent` helper applies the same mapping — the two sides must stay in
//! sync, and both are covered by tests.

use serde::Serialize;
use ts_rs::TS;

pub const EVENT_APP_READY: &str = "app.ready";
/// ADR-0013: 文件关联/第二实例/冷启动 argv 把书文件路径交给首实例的前端。
pub const EVENT_APP_OPEN_FILE: &str = "app.open_file";

pub fn transport_name(logical: &str) -> String {
    logical.replace('.', ":")
}

/// ADR-0008: event payload types are generated from this struct — keep it the
/// wire truth and let `cargo test` refresh `protocol/generated/`.
#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AppReadyPayload {
    pub started_at: String,
    pub app_version: String,
}

/// 路径在后端只过了一次扩展名筛(`library::detect_format`)—— 前端导入命令
/// 按内容二次校验,失败如实走书架问题条。
#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct OpenFilePayload {
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;

    #[test]
    fn maps_dots_to_colons_for_transport() {
        assert_eq!(transport_name(EVENT_APP_OPEN_FILE), "app:open_file");
        assert_eq!(transport_name("app.ready"), "app:ready");
        assert_eq!(
            transport_name("reader.progress.changed"),
            "reader:progress:changed"
        );
    }

    #[test]
    fn app_ready_payload_serializes_camel_case() {
        let payload = AppReadyPayload {
            started_at: "2026-09-08T00:00:00Z".into(),
            app_version: "0.1.0".into(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["startedAt"], "2026-09-08T00:00:00Z");
        assert_eq!(json["appVersion"], "0.1.0");
        assert!(json.get("started_at").is_none());
    }

    #[test]
    fn app_ready_timestamp_is_iso8601() {
        let stamp = crate::timestamps::rfc3339_now();
        assert!(OffsetDateTime::parse(&stamp, &Rfc3339).is_ok());
    }

    #[test]
    fn open_file_payload_serializes_camel_case() {
        let payload = OpenFilePayload {
            path: "/books/夜航书.epub".into(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["path"], "/books/夜航书.epub");
        assert!(json.get("Path").is_none());
    }
}
