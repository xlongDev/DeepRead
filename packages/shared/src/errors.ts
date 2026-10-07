/**
 * Unified error system (spec §39 / §60).
 *
 * Every error crossing a layer boundary is an `AppError` carrying a namespaced
 * code, a human-readable message, a retryable flag and JSON-safe context.
 * Raw panics, stack traces and internals must never reach the UI — they are
 * normalized by `toAppError` before crossing the boundary.
 */

import { jsonRecordFromUnknown, type JsonRecord } from './types'

export const ERROR_PREFIXES = [
  'BOOK',
  'READER',
  'AI',
  'RAG',
  'SYNC',
  'AUTH',
  'STORAGE',
  'TTS',
  'PDF',
  'SYSTEM',
  'SECURITY',
] as const

export type ErrorPrefix = (typeof ERROR_PREFIXES)[number]

/** Error codes are `${PREFIX}_${REASON}`; the prefix is compile-time enforced. */
export type ErrorCode = `${ErrorPrefix}_${string}`

/**
 * Codes that exist so far. The catalog grows with each domain that lands.
 *
 * 镜像规则:Rust `error.rs::ErrorCode` 的每个变体在这里都必须有同名码
 * (蛇形 → 驼峰);TS 独有的只有 `bookParseFailed` —— 解析发生在前端内核,
 * Rust 不会产生它。改任何一侧都要同步另一侧与双侧测试。
 */
export const ErrorCodes = {
  systemInternal: 'SYSTEM_INTERNAL',
  systemValidation: 'SYSTEM_VALIDATION',
  systemIpcFailed: 'SYSTEM_IPC_FAILED',
  systemRuntimeUnavailable: 'SYSTEM_RUNTIME_UNAVAILABLE',
  systemTimeout: 'SYSTEM_TIMEOUT',
  securityValidationFailed: 'SECURITY_VALIDATION_FAILED',
  storageIo: 'STORAGE_IO',
  storageCorrupt: 'STORAGE_CORRUPT',
  bookOpenFailed: 'BOOK_OPEN_FAILED',
  bookUnsupportedFormat: 'BOOK_UNSUPPORTED_FORMAT',
  bookParseFailed: 'BOOK_PARSE_FAILED',
  aiProviderError: 'AI_PROVIDER_ERROR',
  ttsProviderError: 'TTS_PROVIDER_ERROR',
  syncProviderError: 'SYNC_PROVIDER_ERROR',
} as const satisfies Record<string, ErrorCode>

export type KnownErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

const ERROR_CODE_PATTERN = /^[A-Z]+_[A-Z0-9_]+$/

/**
 * Accept a wire-level code string as an `ErrorCode`.
 * The runtime guard below is what makes the assertion sound.
 */
export function coerceErrorCode(value: string): ErrorCode {
  return ERROR_CODE_PATTERN.test(value) ? (value as ErrorCode) : ErrorCodes.systemInternal
}

/** Wire format of an error (Rust ↔ TypeScript, and across layers). */
export interface AppErrorPayload {
  readonly code: string
  readonly message: string
  readonly cause?: string
  readonly retryable: boolean
  readonly context?: JsonRecord
}

export interface AppErrorOptions {
  readonly cause?: unknown
  readonly retryable?: boolean
  readonly context?: JsonRecord
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly context: JsonRecord | undefined

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.context = options.context
  }

  toPayload(): AppErrorPayload {
    const cause = this.cause
    const causeText = cause === undefined ? undefined : describeCause(cause)
    return {
      code: this.code,
      message: this.message,
      ...(causeText !== undefined ? { cause: causeText } : {}),
      retryable: this.retryable,
      ...(this.context !== undefined ? { context: this.context } : {}),
    }
  }
}

export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

export function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<AppErrorPayload>
  return (
    typeof record.code === 'string' &&
    ERROR_CODE_PATTERN.test(record.code) &&
    typeof record.message === 'string' &&
    typeof record.retryable === 'boolean'
  )
}

/** Normalize any thrown value into an `AppError` so boundaries never leak internals. */
export function toAppError(
  value: unknown,
  fallbackCode: ErrorCode = ErrorCodes.systemInternal,
): AppError {
  if (value instanceof AppError) return value
  if (isAppErrorPayload(value)) {
    return new AppError(coerceErrorCode(value.code), value.message, {
      cause: value.cause,
      retryable: value.retryable,
      context: value.context,
    })
  }
  if (value instanceof Error) {
    return new AppError(fallbackCode, value.message || fallbackCode, { cause: value })
  }
  const context = jsonRecordFromUnknown(value)
  return new AppError(fallbackCode, 'An unexpected error occurred.', {
    ...(context !== undefined ? { context } : {}),
  })
}
