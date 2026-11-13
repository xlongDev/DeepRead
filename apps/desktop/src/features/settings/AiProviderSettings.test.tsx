import { act, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiProviderForm,
  EMPTY_PROVIDER_FORM,
  PROVIDER_PRESETS,
  useAiProviders,
} from './AiProviderSettings'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('../../lib/ipc', () => ({
  invokeCommand: invokeMock,
  isTauriRuntime: () => false,
}))

const noop = (): void => {}

describe('AiProviderForm', () => {
  it('labels every field and splits cloud from local presets', () => {
    render(
      <AiProviderForm
        providers={[]}
        configForm={EMPTY_PROVIDER_FORM}
        onFormChange={noop}
        onSave={noop}
        onRemove={noop}
        onApplyPreset={noop}
      />,
    )
    expect(screen.getByText('快速填充')).toBeTruthy()
    expect(screen.getByRole('button', { name: '快速填充服务商' })).toBeTruthy()
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(16)
    expect(screen.getByText('连接信息')).toBeTruthy()
    expect(screen.getByText('模型')).toBeTruthy()
    // 每个字段都有可见 label,不再只靠 placeholder 说明自己是什么。
    for (const label of [/名称/, /Base URL/, /API Key/, /对话模型/, /Embedding/, /TTS/]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
    // 连接 / 模型并排,才不至于在 78dvh 弹窗里滚半天。
    expect(document.querySelector('.ai-fields-grid')).toBeTruthy()
    expect(document.querySelectorAll('.ai-fields-grid .ai-section')).toHaveLength(2)
  })
})

describe('useAiProviders · OC Ferry', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    localStorage.clear()
  })

  it('adopts one model into a fixed slot and makes it active', async () => {
    invokeMock.mockResolvedValue({
      provider: {
        id: 'oc-ferry-local',
        name: 'OC Ferry(本机)',
        baseUrl: 'http://127.0.0.1:41980/v1',
        model: 'OC · GLM-4.6',
      },
    })
    const { result } = renderHook(() => useAiProviders())
    await act(async () => {
      expect(await result.current.adoptOcFerryModel('OC · GLM-4.6')).toBe(true)
    })
    expect(invokeMock).toHaveBeenCalledWith('ai.ocFerry.use', { model: 'OC · GLM-4.6' })
    expect(result.current.providers[0]?.id).toBe('oc-ferry-local')
    expect(result.current.activeId).toBe('oc-ferry-local')
    expect(localStorage.getItem('deepread.ai.activeProvider')).toBe('oc-ferry-local')
  })

  it('detects the model list without leaking a key into the page', async () => {
    invokeMock.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:41980/v1',
      models: ['OC · GLM-4.6', 'OC · Qwen3'],
    })
    const { result } = renderHook(() => useAiProviders())
    let found: unknown = null
    await act(async () => {
      found = await result.current.detectOcFerry()
    })
    expect(invokeMock).toHaveBeenCalledWith('ai.ocFerry.detect', undefined)
    expect(found).toMatchObject({ models: ['OC · GLM-4.6', 'OC · Qwen3'] })
    expect(found).not.toHaveProperty('apiKey')
  })
})
