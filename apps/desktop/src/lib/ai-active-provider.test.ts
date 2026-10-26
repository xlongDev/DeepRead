import { afterEach, describe, expect, it } from 'vitest'
import type { AiProviderConfig } from '@deepread/shared'
import {
  readActiveProviderId,
  resolveActiveProvider,
  writeActiveProviderId,
} from './ai-active-provider'

function provider(id: string): AiProviderConfig {
  return { id, name: id, baseUrl: 'https://x/v1', model: 'm' }
}

const LIST = [provider('a'), provider('b'), provider('c')]

afterEach(() => {
  localStorage.clear()
})

describe('当前 AI 服务的持久化与解析', () => {
  it('没存过或存的服务已删除时回落第一个', () => {
    expect(resolveActiveProvider(LIST)?.id).toBe('a')
    writeActiveProviderId('z')
    expect(resolveActiveProvider(LIST)?.id).toBe('a')
  })

  it('存过的服务还在列表里就优先用它,且读写往返一致', () => {
    writeActiveProviderId('b')
    expect(readActiveProviderId()).toBe('b')
    expect(resolveActiveProvider(LIST)?.id).toBe('b')
  })

  it('空列表解析为 null,不假装有服务', () => {
    writeActiveProviderId('a')
    expect(resolveActiveProvider([])).toBeNull()
  })
})
