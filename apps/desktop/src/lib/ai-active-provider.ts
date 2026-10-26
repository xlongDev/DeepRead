import type { AiProviderConfig } from '@deepread/shared'

const STORAGE_KEY = 'deepread.ai.activeProvider'

/**
 * 「当前 AI 服务」的持久化:设置页、AI 抽屉、TTS 云端朗读、学习工具共用同一
 * 份选择。存 localStorage 而非 SQLite —— Provider 与 API Key 本就是每台设备
 * 自己的配置(key 在系统钥匙串),不随书同步。
 */
export function readActiveProviderId(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

export function writeActiveProviderId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // 隐私模式等写不进的场景:选择退化为本次会话有效。
  }
}

/**
 * 从服务列表解析出应当生效的 Provider:用户上次选的还在就用它,已删或没选过
 * 则取列表第一个(与旧行为一致)。
 */
export function resolveActiveProvider(
  providers: readonly AiProviderConfig[],
): AiProviderConfig | null {
  const stored = readActiveProviderId()
  return providers.find((provider) => provider.id === stored) ?? providers[0] ?? null
}
