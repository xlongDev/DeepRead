import { describe, expect, it } from 'vitest'
import { AppError, ErrorCodes, coerceErrorCode, isAppErrorPayload, toAppError } from './errors'

describe('AppError', () => {
  it('carries code, message, retryable and context', () => {
    const error = new AppError(ErrorCodes.systemTimeout, 'request timed out', {
      retryable: true,
      context: { command: 'system.ping' },
    })
    expect(error.code).toBe('SYSTEM_TIMEOUT')
    expect(error.retryable).toBe(true)
    expect(error.context).toEqual({ command: 'system.ping' })
    expect(error.message).toBe('request timed out')
  })

  it('serializes to the wire payload without leaking the raw cause object', () => {
    const error = new AppError(ErrorCodes.systemIpcFailed, 'ipc failed', {
      cause: new Error('boom'),
    })
    const payload = error.toPayload()
    expect(payload).toEqual({
      code: 'SYSTEM_IPC_FAILED',
      message: 'ipc failed',
      cause: 'boom',
      retryable: false,
    })
  })

  it('keeps the error code prefix type-safe at runtime', () => {
    expect(() => new AppError('BOOK_TEST', 'x')).not.toThrow()
  })
})

describe('ErrorCodes catalog', () => {
  it('mirrors every Rust ErrorCode variant plus the kernel-side parse code', () => {
    // Rust `error.rs::ErrorCode` 的 13 个变体逐一在此(bookParseFailed 只在
    // 前端内核产生,Rust 没有它)。Rust 侧由 error.rs 的 wire-string 测试锁
    // 字符串;这里锁目录成员,防手滑删改。改任一侧必须同步另一侧。
    expect(Object.values(ErrorCodes).sort()).toEqual(
      [
        'SYSTEM_INTERNAL',
        'SYSTEM_VALIDATION',
        'SYSTEM_IPC_FAILED',
        'SYSTEM_RUNTIME_UNAVAILABLE',
        'SYSTEM_TIMEOUT',
        'SECURITY_VALIDATION_FAILED',
        'STORAGE_IO',
        'STORAGE_CORRUPT',
        'BOOK_OPEN_FAILED',
        'BOOK_UNSUPPORTED_FORMAT',
        'BOOK_PARSE_FAILED',
        'AI_PROVIDER_ERROR',
        'TTS_PROVIDER_ERROR',
        'SYNC_PROVIDER_ERROR',
      ].sort(),
    )
  })
})

describe('coerceErrorCode', () => {
  it('accepts well-formed codes', () => {
    expect(coerceErrorCode('SYNC_CONFLICT')).toBe('SYNC_CONFLICT')
  })

  it('falls back to SYSTEM_INTERNAL for malformed codes', () => {
    expect(coerceErrorCode('nope')).toBe(ErrorCodes.systemInternal)
    expect(coerceErrorCode('')).toBe(ErrorCodes.systemInternal)
    expect(coerceErrorCode('lower_case')).toBe(ErrorCodes.systemInternal)
  })
})

describe('isAppErrorPayload', () => {
  it('recognizes valid payloads', () => {
    expect(isAppErrorPayload({ code: 'SYNC_FAILED', message: 'x', retryable: true })).toBe(true)
  })

  it('rejects malformed payloads', () => {
    expect(isAppErrorPayload({ code: 'BAD', message: 'x', retryable: true })).toBe(false)
    expect(isAppErrorPayload({ code: 'SYNC_FAILED', retryable: true })).toBe(false)
    expect(isAppErrorPayload(null)).toBe(false)
    expect(isAppErrorPayload('SYNC_FAILED')).toBe(false)
  })
})

describe('toAppError', () => {
  it('passes AppError instances through', () => {
    const original = new AppError(ErrorCodes.systemValidation, 'bad input')
    expect(toAppError(original)).toBe(original)
  })

  it('reconstructs from a wire payload (e.g. rejected Rust command)', () => {
    const error = toAppError({ code: 'STORAGE_IO', message: 'disk full', retryable: true })
    expect(error).toBeInstanceOf(AppError)
    expect(error.code).toBe('STORAGE_IO')
    expect(error.retryable).toBe(true)
  })

  it('wraps plain Errors with the fallback code', () => {
    const error = toAppError(new Error('boom'), ErrorCodes.systemIpcFailed)
    expect(error.code).toBe('SYSTEM_IPC_FAILED')
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('wraps non-Error values safely', () => {
    const error = toAppError('just a string')
    expect(error.code).toBe(ErrorCodes.systemInternal)
    expect(error.message).toBe('An unexpected error occurred.')
  })
})
