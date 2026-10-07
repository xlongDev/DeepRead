//! Unified error system — the Rust mirror of `packages/shared/src/errors.ts`.
//!
//! Every command returns `Result<T, AppError>`; the wire format is the flat
//! `AppErrorPayload` object the frontend schema-validates. Raw panics and
//! internal error chains never cross the IPC boundary as-is.

use serde::{Serialize, Serializer};
use serde_json::{Map, Value};
use ts_rs::TS;

/// Wire-level error code catalog. Deliberately mirrors the full TypeScript
/// catalog (`ErrorCodes` in `packages/shared/src/errors.ts`) — the sync test
/// below locks the two sides together. Variants Rust code does not construct
/// yet are kept for catalog completeness; `dead_code` is therefore allowed
/// here on purpose and new commands must emit codes from this enum instead of
/// inventing strings.
///
/// ADR-0008: this enum is also the *type source* — `cargo test` exports the
/// SCREAMING_SNAKE union to `packages/shared/src/protocol/generated/`, and the
/// TS catalog is compile-checked against it.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, TS)]
#[ts(export, rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    SystemInternal,
    SystemValidation,
    SystemIpcFailed,
    SystemTimeout,
    SystemRuntimeUnavailable,
    SecurityValidationFailed,
    StorageIo,
    StorageCorrupt,
    BookOpenFailed,
    BookUnsupportedFormat,
    AiProviderError,
    TtsProviderError,
    SyncProviderError,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SystemInternal => "SYSTEM_INTERNAL",
            Self::SystemValidation => "SYSTEM_VALIDATION",
            Self::SystemIpcFailed => "SYSTEM_IPC_FAILED",
            Self::SystemTimeout => "SYSTEM_TIMEOUT",
            Self::SystemRuntimeUnavailable => "SYSTEM_RUNTIME_UNAVAILABLE",
            Self::SecurityValidationFailed => "SECURITY_VALIDATION_FAILED",
            Self::StorageIo => "STORAGE_IO",
            Self::StorageCorrupt => "STORAGE_CORRUPT",
            Self::BookOpenFailed => "BOOK_OPEN_FAILED",
            Self::BookUnsupportedFormat => "BOOK_UNSUPPORTED_FORMAT",
            Self::AiProviderError => "AI_PROVIDER_ERROR",
            Self::TtsProviderError => "TTS_PROVIDER_ERROR",
            Self::SyncProviderError => "SYNC_PROVIDER_ERROR",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub cause: Option<String>,
    pub retryable: bool,
    pub context: Option<Map<String, Value>>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cause: None,
            retryable: false,
            context: None,
        }
    }

    pub fn with_context(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.context
            .get_or_insert_with(Map::new)
            .insert(key.into(), value.into());
        self
    }

    /// Stringifies the underlying error into the wire `cause` field: internal
    /// error objects never cross IPC, only their display text does (ADR-0004).
    pub fn with_cause(mut self, cause: impl std::error::Error) -> Self {
        self.cause = Some(cause.to_string());
        self
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeMap;

        let mut len = 3; // code, message, retryable
        if self.cause.is_some() {
            len += 1;
        }
        if self.context.is_some() {
            len += 1;
        }

        let mut map = serializer.serialize_map(Some(len))?;
        map.serialize_entry("code", self.code.as_str())?;
        map.serialize_entry("message", &self.message)?;
        if let Some(cause) = &self.cause {
            map.serialize_entry("cause", cause)?;
        }
        map.serialize_entry("retryable", &self.retryable)?;
        if let Some(context) = &self.context {
            map.serialize_entry("context", context)?;
        }
        map.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_the_shared_wire_payload() {
        let error = AppError::new(ErrorCode::SystemValidation, "nonce must not be empty")
            .with_context("field", "nonce");

        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["code"], "SYSTEM_VALIDATION");
        assert_eq!(json["message"], "nonce must not be empty");
        assert_eq!(json["retryable"], false);
        assert_eq!(json["context"]["field"], "nonce");
        assert!(json.get("cause").is_none());
    }

    #[test]
    fn includes_cause_only_when_present() {
        let error = AppError {
            code: ErrorCode::SystemIpcFailed,
            message: "ipc failed".to_string(),
            cause: Some("boom".to_string()),
            retryable: true,
            context: None,
        };

        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["cause"], "boom");
        assert_eq!(json["retryable"], true);
    }

    #[test]
    fn error_code_wire_strings_stay_stable() {
        let expected = [
            ("SYSTEM_INTERNAL", ErrorCode::SystemInternal),
            ("SYSTEM_VALIDATION", ErrorCode::SystemValidation),
            ("SYSTEM_IPC_FAILED", ErrorCode::SystemIpcFailed),
            ("SYSTEM_TIMEOUT", ErrorCode::SystemTimeout),
            (
                "SYSTEM_RUNTIME_UNAVAILABLE",
                ErrorCode::SystemRuntimeUnavailable,
            ),
            (
                "SECURITY_VALIDATION_FAILED",
                ErrorCode::SecurityValidationFailed,
            ),
            ("STORAGE_IO", ErrorCode::StorageIo),
            ("STORAGE_CORRUPT", ErrorCode::StorageCorrupt),
            ("BOOK_OPEN_FAILED", ErrorCode::BookOpenFailed),
            ("BOOK_UNSUPPORTED_FORMAT", ErrorCode::BookUnsupportedFormat),
            ("AI_PROVIDER_ERROR", ErrorCode::AiProviderError),
            ("TTS_PROVIDER_ERROR", ErrorCode::TtsProviderError),
            ("SYNC_PROVIDER_ERROR", ErrorCode::SyncProviderError),
        ];
        for (code, variant) in expected {
            assert_eq!(variant.as_str(), code);
        }
    }

    #[test]
    fn display_uses_the_message() {
        let error = AppError::new(ErrorCode::SystemInternal, "something broke");
        assert_eq!(error.to_string(), "something broke");
    }
}
