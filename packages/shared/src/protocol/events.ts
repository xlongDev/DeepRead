/**
 * Typed IPC event catalog (Phase 0).
 *
 * Rules (spec §41 / §59):
 * - every event has a logical name (`app.ready`), a schema version and a payload type
 * - Tauri event names forbid `.`, so the transport name replaces `.` with `:`
 *   (`app.ready` → `app:ready`); the mapping lives in the two boundary helpers
 *   (`apps/desktop/src/lib/ipc.ts` and `src-tauri/src/events.rs`)
 * - payloads are untrusted input and are validated before they reach handlers
 * - **类型源 = Rust DTO**(ADR-0008):payload 类型由 ts-rs 生成,勿手改
 */

import { z } from 'zod'
import { ISO8601_PATTERN } from '../types'

import type { AppReadyPayload } from './generated/AppReadyPayload'

export type { AppReadyPayload }

export const EVENT = {
  appReady: 'app.ready',
} as const

/**
 * 协议版本。语义:桌面 app 与前端同包发布、永远同步,单端协议不做跨版本
 * 兼容 —— 因此移除命令(如 `secret.get`,ADR-0010)不递增;只有协议开始
 * 跨版本共存(如移动端独立发版)才从这里开始管理。随 app.ready 广播,
 * 供日志与调试对比。
 */
export const PROTOCOL_VERSION = 1

/** The single source of truth for event payload shapes. */
export interface EventMap {
  [EVENT.appReady]: AppReadyPayload
}

export type EventName = keyof EventMap

export interface EventEnvelope<P> {
  readonly name: EventName
  readonly version: typeof PROTOCOL_VERSION
  readonly payload: P
}

export interface EventValidator<P> {
  parse(value: unknown): P
}

export const eventPayloadSchemas = {
  [EVENT.appReady]: z.object({
    startedAt: z.string().regex(ISO8601_PATTERN, 'must be an ISO 8601 timestamp'),
    appVersion: z.string().min(1),
  }),
}

export const eventPayloadValidators: { [K in EventName]: EventValidator<EventMap[K]> } =
  eventPayloadSchemas
