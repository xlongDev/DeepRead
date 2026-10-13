import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { appErrorPayloadSchema } from './protocol/errors'
import {
  appInfoSchema,
  COMMAND,
  librarySearchRequestSchema,
  librarySearchResponseSchema,
  readingGoalGetResponseSchema,
  readingGoalSetRequestSchema,
  requestValidators,
  responseSchemas,
  responseValidators,
  systemPingRequestSchema,
  systemPingResponseSchema,
  type CommandMap,
  type CommandName,
} from './protocol/commands'
import {
  EVENT,
  eventPayloadSchemas,
  eventPayloadValidators,
  type EventMap,
  type EventName,
} from './protocol/events'

describe('command validators', () => {
  it('every command has a response validator', () => {
    for (const command of Object.values(COMMAND)) {
      expect(responseValidators[command], `missing validator for ${command}`).toBeDefined()
    }
  })

  it('systemPingRequestSchema accepts a valid nonce', () => {
    expect(systemPingRequestSchema.safeParse({ nonce: 'abc' }).success).toBe(true)
  })

  it('systemPingRequestSchema rejects an empty or oversized nonce', () => {
    expect(systemPingRequestSchema.safeParse({ nonce: '' }).success).toBe(false)
    expect(systemPingRequestSchema.safeParse({ nonce: 'x'.repeat(129) }).success).toBe(false)
  })

  it('systemPingResponseSchema rejects a non-ISO serverTime', () => {
    const bad = { nonce: 'abc', serverTime: 'yesterday', appVersion: '0.1.0' }
    expect(systemPingResponseSchema.safeParse(bad).success).toBe(false)
    const good = { nonce: 'abc', serverTime: '2026-09-08T12:00:00.123Z', appVersion: '0.1.0' }
    expect(systemPingResponseSchema.safeParse(good).success).toBe(true)
  })

  it('appInfoSchema requires all fields', () => {
    expect(
      appInfoSchema.safeParse({ appName: 'Deepread', appVersion: '0.1.0', os: 'macos' }).success,
    ).toBe(false)
    expect(
      appInfoSchema.safeParse({
        appName: 'Deepread',
        appVersion: '0.1.0',
        os: 'macos',
        arch: 'aarch64',
      }).success,
    ).toBe(true)
  })

  it('request validators exist for commands that take a request', () => {
    expect(requestValidators[COMMAND.systemPing]).toBeDefined()
    expect(requestValidators[COMMAND.appInfo]).toBeUndefined()
  })
})

describe('librarySearchRequestSchema', () => {
  it('accepts a normal query and rejects blank/oversized ones', () => {
    expect(librarySearchRequestSchema.safeParse({ query: '灯芯' }).success).toBe(true)
    expect(librarySearchRequestSchema.safeParse({ query: '' }).success).toBe(false)
    expect(librarySearchRequestSchema.safeParse({ query: 'x'.repeat(201) }).success).toBe(false)
  })
})

describe('librarySearchResponseSchema', () => {
  it('keeps both segments and the indexed-book count', () => {
    const response = {
      books: [],
      hits: [
        {
          bookHash: 'a'.repeat(64),
          displayName: '化雪的季节',
          fileName: '化雪的季节.epub',
          label: '第一章',
          excerpt: '……灯芯偶尔响一声……',
        },
      ],
      indexedBooks: 3,
    }
    expect(librarySearchResponseSchema.parse(response)).toEqual(response)
  })

  it('rejects a hit without an excerpt', () => {
    const bad = {
      books: [],
      hits: [{ bookHash: 'a'.repeat(64), displayName: null, fileName: 'x.epub', label: '第一章' }],
      indexedBooks: 1,
    }
    expect(librarySearchResponseSchema.safeParse(bad).success).toBe(false)
  })
})

describe('reading goal schemas', () => {
  it('get response carries minutes; 0 = no goal', () => {
    expect(readingGoalGetResponseSchema.parse({ dailyMinutes: 45 })).toEqual({ dailyMinutes: 45 })
    expect(readingGoalGetResponseSchema.parse({ dailyMinutes: 0 })).toEqual({ dailyMinutes: 0 })
  })

  it('set request accepts 0…1440 and rejects beyond', () => {
    expect(readingGoalSetRequestSchema.safeParse({ dailyMinutes: 30 }).success).toBe(true)
    expect(readingGoalSetRequestSchema.safeParse({ dailyMinutes: 0 }).success).toBe(true)
    expect(readingGoalSetRequestSchema.safeParse({ dailyMinutes: 1441 }).success).toBe(false)
    expect(readingGoalSetRequestSchema.safeParse({ dailyMinutes: -1 }).success).toBe(false)
    expect(readingGoalSetRequestSchema.safeParse({ dailyMinutes: 1.5 }).success).toBe(false)
  })
})

describe('event validators', () => {
  it('validates the app.ready payload', () => {
    const good = { startedAt: '2026-09-08T12:00:00Z', appVersion: '0.1.0' }
    expect(eventPayloadValidators[EVENT.appReady].parse(good)).toEqual(good)

    const bad = { startedAt: 'now', appVersion: '0.1.0' }
    expect(() => eventPayloadValidators[EVENT.appReady].parse(bad)).toThrow()
  })
})

describe('appErrorPayloadSchema', () => {
  it('accepts a Rust-produced error payload', () => {
    const payload = {
      code: 'SYSTEM_VALIDATION',
      message: 'nonce must not be empty',
      retryable: false,
      context: { field: 'nonce' },
    }
    expect(appErrorPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('rejects payloads without a retryable flag', () => {
    const payload = { code: 'SYSTEM_VALIDATION', message: 'x' }
    expect(appErrorPayloadSchema.safeParse(payload).success).toBe(false)
  })
})

/* ---------- ADR-0008:类型漂移 = 编译错误 ----------

下面两组断言把每个 zod 响应校验器与 ts-rs 生成的 wire 类型(Rust DTO)钉在一起:

- `RESPONSE_WIRE_TYPES`  — 校验器的输出必须能赋给 wire 类型(形状/字段类型漂移即红,
  报错信息会点名漂移的命令);
- `RESPONSE_WIRE_FIELDS` — wire 类型的每个字段都必须出现在校验器输出里(Rust 新增
  字段而 zod 没跟时红;否则 zod 会把新字段静默剥离,响应"看起来正常"却丢了数据)。

断言由 `pnpm typecheck` 求值;这里的 `it` 只是让 `pnpm test` 也挂着这个语义。 */

type ResponseWireTypes = {
  [K in CommandName]: [z.output<(typeof responseSchemas)[K]>] extends [CommandMap[K]['response']]
    ? true
    : `响应校验器与 wire 类型漂移: ${K & string}`
}[CommandName]

type ResponseWireFields = {
  [K in CommandName]: keyof CommandMap[K]['response'] extends keyof z.output<
    (typeof responseSchemas)[K]
  >
    ? true
    : `zod 校验器缺少 wire 字段: ${K & string}`
}[CommandName]

export const RESPONSE_WIRE_TYPES: ResponseWireTypes = true
export const RESPONSE_WIRE_FIELDS: ResponseWireFields = true

type EventWireTypes = {
  [K in EventName]: [z.output<(typeof eventPayloadSchemas)[K]>] extends [EventMap[K]]
    ? true
    : `事件 payload 与 wire 类型漂移: ${K & string}`
}[EventName]

export const EVENT_WIRE_TYPES: EventWireTypes = true

describe('wire type compatibility (ADR-0008, compile-time)', () => {
  it('response validators and event validators are pinned to the generated wire types', () => {
    // 真正的检查在类型层(RESPONSE_WIRE_TYPES / RESPONSE_WIRE_FIELDS / EVENT_WIRE_TYPES);
    // 这里只确认断言常量存在且为 true,让漂移在 vitest 输出里也有一个挂点。
    expect(RESPONSE_WIRE_TYPES).toBe(true)
    expect(RESPONSE_WIRE_FIELDS).toBe(true)
    expect(EVENT_WIRE_TYPES).toBe(true)
  })
})
