//! System-scoped commands (Phase 0): `system.ping` proves the typed IPC
//! round-trip; `app.info` feeds the shell.
//!
//! Each command is a thin wrapper: validation + payload assembly live in a
//! pure `*_impl` / builder function that is unit-tested without a runtime.

use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

use crate::error::{AppError, ErrorCode};
use crate::timestamps::rfc3339_now;

pub const MAX_NONCE_LENGTH: usize = 128;

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PingRequest {
    pub nonce: String,
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PingResponse {
    pub nonce: String,
    pub server_time: String,
    pub app_version: String,
}

pub fn system_ping_impl(
    nonce: &str,
    server_time: String,
    app_version: String,
) -> Result<PingResponse, AppError> {
    if nonce.is_empty() {
        return Err(
            AppError::new(ErrorCode::SystemValidation, "nonce must not be empty")
                .with_context("field", "nonce"),
        );
    }
    if nonce.len() > MAX_NONCE_LENGTH {
        return Err(
            AppError::new(ErrorCode::SystemValidation, "nonce is too long")
                .with_context("field", "nonce")
                .with_context("maxLength", json!(MAX_NONCE_LENGTH)),
        );
    }
    Ok(PingResponse {
        nonce: nonce.to_string(),
        server_time,
        app_version,
    })
}

#[tauri::command(rename = "system.ping")]
pub fn system_ping(request: PingRequest) -> Result<PingResponse, AppError> {
    system_ping_impl(
        &request.nonce,
        rfc3339_now(),
        env!("CARGO_PKG_VERSION").to_string(),
    )
}

#[derive(Debug, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_name: String,
    pub app_version: String,
    pub os: String,
    pub arch: String,
}

pub fn build_app_info(app_name: &str, app_version: &str, os: &str, arch: &str) -> AppInfo {
    AppInfo {
        app_name: app_name.to_string(),
        app_version: app_version.to_string(),
        os: os.to_string(),
        arch: arch.to_string(),
    }
}

#[tauri::command(rename = "app.info")]
pub fn app_info(app: tauri::AppHandle) -> Result<AppInfo, AppError> {
    let package = app.package_info();
    Ok(build_app_info(
        &package.name,
        &package.version.to_string(),
        std::env::consts::OS,
        std::env::consts::ARCH,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;

    #[test]
    fn ping_echoes_nonce_and_returns_iso8601_time() {
        let response =
            system_ping_impl("abc", rfc3339_now(), "0.1.0".to_string()).expect("must succeed");
        assert_eq!(response.nonce, "abc");
        assert_eq!(response.app_version, "0.1.0");
        assert!(OffsetDateTime::parse(&response.server_time, &Rfc3339).is_ok());
    }

    #[test]
    fn ping_rejects_empty_nonce_with_validation_error() {
        let err = system_ping_impl("", "2026-09-08T00:00:00Z".to_string(), "0.1.0".to_string())
            .expect_err("empty nonce must fail");
        assert_eq!(err.code.as_str(), "SYSTEM_VALIDATION");
        let context = err.context.expect("context must be present");
        assert_eq!(context["field"], "nonce");
    }

    #[test]
    fn ping_enforces_the_nonce_length_limit() {
        let oversized = "x".repeat(MAX_NONCE_LENGTH + 1);
        assert!(
            system_ping_impl(&oversized, String::new(), "0.1.0".to_string()).is_err(),
            "nonce longer than the limit must fail"
        );
        let at_limit = "x".repeat(MAX_NONCE_LENGTH);
        assert!(
            system_ping_impl(&at_limit, String::new(), "0.1.0".to_string()).is_ok(),
            "nonce at the limit must pass"
        );
    }

    #[test]
    fn ping_response_serializes_camel_case() {
        let response = PingResponse {
            nonce: "abc".to_string(),
            server_time: "2026-09-08T00:00:00Z".to_string(),
            app_version: "0.1.0".to_string(),
        };
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["nonce"], "abc");
        assert_eq!(json["serverTime"], "2026-09-08T00:00:00Z");
        assert_eq!(json["appVersion"], "0.1.0");
        assert!(json.get("server_time").is_none());
    }

    #[test]
    fn ping_request_rejects_unknown_fields() {
        let raw = r#"{"nonce":"abc","extra":1}"#;
        assert!(serde_json::from_str::<PingRequest>(raw).is_err());
    }

    #[test]
    fn app_info_builds_the_expected_shape() {
        let info = build_app_info("DeepRead", "0.1.0", "macos", "aarch64");
        assert_eq!(info.app_name, "DeepRead");
        assert_eq!(info.app_version, "0.1.0");
        assert_eq!(info.os, "macos");
        assert_eq!(info.arch, "aarch64");

        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["appName"], "DeepRead");
        assert_eq!(json["appVersion"], "0.1.0");
        assert_eq!(json["os"], "macos");
        assert_eq!(json["arch"], "aarch64");
    }
}
