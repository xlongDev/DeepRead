/**
 * runSync 契约测试(B3)。
 *
 * mock 掉 IPC 边界,锁定两件事:
 * 1. **单趟合并** —— N 本书的本地状态通过一次 `reader.state.getAll` 拿齐,
 *    不再逐本 `reader.state.get`(B3 验收:IPC 往返 N → 1);
 * 2. **WebDAV 侧逐书** —— 远端状态变化时 `reader.state.set` 持久化合并结果,
 *    且 push 保持每本书一个 `cloud.webdav.put`(避免单请求过大)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandMap, CommandName, ReaderStatePayload } from '@deepread/shared'
import { runSync } from './sync'

const invokeCommand = vi.hoisted(() => vi.fn())
vi.mock('./ipc', () => ({ invokeCommand }))

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function book(
  hash: string,
  displayName: string,
): CommandMap['library.list']['response']['books'][number] {
  return {
    hash,
    fileName: `${displayName}.epub`,
    displayName,
    author: null,
    subtitle: null,
    publisher: null,
    language: null,
    format: 'epub',
    path: `/books/${hash}.epub`,
    size: 10,
    addedAt: '2026-10-01T00:00:00.000Z',
    progress: null,
    tags: [],
  }
}

function state(
  annotations: ReaderStatePayload['annotations'],
  updatedAt: string,
): ReaderStatePayload {
  return { progress: null, annotations, bookmarks: [], updatedAt }
}

/** WebDAV 远端文档表:path → body(null = 文档不存在)。 */
let remote: Record<string, string | null>
let webdavPuts: string[]

beforeEach(() => {
  remote = {}
  webdavPuts = []
  invokeCommand.mockReset()
  invokeCommand.mockImplementation(
    async <K extends CommandName>(command: K, request: CommandMap[K]['request']) => {
      switch (command) {
        case 'cloud.config.get':
          return { config: null, deviceId: 'device-12345678', deviceName: '测试机' }
        case 'library.list':
          return { books: [book(HASH_A, '金色梦乡'), book(HASH_B, '认知觉醒')] }
        case 'reader.state.getAll':
          return {
            states: {
              [HASH_A]: state(
                [
                  {
                    id: 'a1',
                    cfi: 'epubcfi(/6/4)',
                    color: '#f5d76e',
                    updatedAt: '2026-10-05T00:00:00.000Z',
                  },
                  {
                    id: 'a2',
                    cfi: 'epubcfi(/6/6)',
                    color: '#f5d76e',
                    updatedAt: '2026-10-05T01:00:00.000Z',
                  },
                ],
                '2026-10-05T01:00:00.000Z',
              ),
            },
          }
        case 'cloud.webdav.get': {
          const path = (request as CommandMap['cloud.webdav.get']['request']).path
          return { body: remote[path] ?? null }
        }
        case 'cloud.webdav.put': {
          const { path, body } = request as CommandMap['cloud.webdav.put']['request']
          remote[path] = body
          webdavPuts.push(path)
          return { ok: true }
        }
        case 'reader.state.set':
          return { savedAt: '2026-10-07T00:00:00.000Z' }
        default:
          throw new Error(`sync.test 未实现的命令: ${command}`)
      }
    },
  )
})

describe('runSync(B3 单趟合并)', () => {
  it('50 本书:本地状态 IPC 往返 = 1 次 getAll(WebDAV 仍逐书 get)', async () => {
    // 让每本都有一个不同的 hash:按索引改前两位(hex 字符)。
    const books = Array.from({ length: 50 }, (_, i) => {
      const prefix = i.toString(16).padStart(2, '0')
      const hash = (prefix + 'a'.repeat(62)).slice(0, 64)
      remote[`state/${hash}.json`] = JSON.stringify(state([], '2026-10-05T00:00:00.000Z'))
      return book(hash, `第${i}本`)
    })
    invokeCommand.mockImplementation(
      async <K extends CommandName>(command: K, request: CommandMap[K]['request']) => {
        switch (command) {
          case 'cloud.config.get':
            return { config: null, deviceId: 'device-12345678', deviceName: '测试机' }
          case 'library.list':
            return { books }
          case 'reader.state.getAll':
            return {
              states: Object.fromEntries(
                books.map((b) => [b.hash, state([], '2026-10-05T00:00:00.000Z')]),
              ),
            }
          case 'cloud.webdav.get': {
            const path = (request as CommandMap['cloud.webdav.get']['request']).path
            return { body: remote[path] ?? null }
          }
          case 'cloud.webdav.put': {
            const { path, body } = request as CommandMap['cloud.webdav.put']['request']
            remote[path] = body
            webdavPuts.push(path)
            return { ok: true }
          }
          default:
            throw new Error(`不应触达: ${command}`)
        }
      },
    )

    const report = await runSync()

    const getAllCalls = invokeCommand.mock.calls.filter(([c]) => c === 'reader.state.getAll')
    expect(getAllCalls).toHaveLength(1)
    expect(invokeCommand.mock.calls.filter(([c]) => c === 'reader.state.get')).toHaveLength(0)
    // 50 本书 × 1 次远端状态 get + devices/library 两次(旧行为还要 +50 次 state IPC)。
    expect(invokeCommand.mock.calls.filter(([c]) => c === 'cloud.webdav.get')).toHaveLength(52)
    expect(report.bookCount).toBe(50)
  })

  it('全部本地状态用一次 reader.state.getAll 拿齐,不再逐本 get', async () => {
    await runSync()

    const getAllCalls = invokeCommand.mock.calls.filter(([c]) => c === 'reader.state.getAll')
    const stateGetCalls = invokeCommand.mock.calls.filter(([c]) => c === 'reader.state.get')
    expect(getAllCalls).toHaveLength(1)
    expect(stateGetCalls).toHaveLength(0)
  })

  it('本地与远端各有一条对方没有的批注:合并结果持久化(reader.state.set)并逐书 push', async () => {
    // 本地(getAll 返回)= [a1, a2];远端 = [r1]。合并后三方内容互不相同,
    // 所以既要 set 回本地,也要按书 push 回 WebDAV。
    remote[`state/${HASH_A}.json`] = JSON.stringify(
      state(
        [
          {
            id: 'r1',
            cfi: 'epubcfi(/6/8)',
            color: '#a5d6f5',
            updatedAt: '2026-10-06T00:00:00.000Z',
          },
        ],
        '2026-10-06T00:00:00.000Z',
      ),
    )

    const report = await runSync()

    const sets = invokeCommand.mock.calls.filter(([c]) => c === 'reader.state.set')
    expect(sets).toHaveLength(1)
    const [, setState] = sets[0] as unknown as [string, CommandMap['reader.state.set']['request']]
    expect(setState.bookHash).toBe(HASH_A)
    expect(setState.state.annotations.map((a) => a.id)).toEqual(['a1', 'a2', 'r1'])
    expect(webdavPuts).toContain(`state/${HASH_A}.json`)
    // devices + library + state/A 各一次;state/A 的 push 属于逐书(非整库打包)。
    expect(report.pulled).toBe(1)
    expect(report.pushed).toBe(3)
    expect(report.conflicts).toEqual([])
  })

  it('两端一致的书不产生 set/put,B 书无状态则整本跳过', async () => {
    // 与本地完全一致(含 updatedAt):contentOf 相同 → 不 set 也不 push。
    remote[`state/${HASH_A}.json`] = JSON.stringify(
      state(
        [
          {
            id: 'a1',
            cfi: 'epubcfi(/6/4)',
            color: '#f5d76e',
            updatedAt: '2026-10-05T00:00:00.000Z',
          },
          {
            id: 'a2',
            cfi: 'epubcfi(/6/6)',
            color: '#f5d76e',
            updatedAt: '2026-10-05T01:00:00.000Z',
          },
        ],
        '2026-10-05T01:00:00.000Z',
      ),
    )

    const report = await runSync()

    expect(invokeCommand.mock.calls.filter(([c]) => c === 'reader.state.set')).toHaveLength(0)
    expect(webdavPuts.filter((p) => p.startsWith('state/'))).toHaveLength(0)
    expect(report.bookCount).toBe(2)
  })
})
