import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiProviderForm,
  EMBEDDING_PRESETS,
  EMPTY_EMBEDDING_FORM,
  EMPTY_PROVIDER_FORM,
  PROVIDER_PRESETS,
  embeddingHost,
  needsOverseasNetwork,
  useAiProviders,
  type AiEmbeddingFormState,
  type AiProviderFormState,
} from './AiProviderSettings'

const { invokeMock, runtimeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  runtimeMock: vi.fn(() => false),
}))
vi.mock('../../lib/ipc', () => ({
  invokeCommand: invokeMock,
  isTauriRuntime: runtimeMock,
}))

const noop = (): void => {}

function renderForm(
  overrides: {
    configForm?: AiProviderFormState
    embeddingForm?: AiEmbeddingFormState
    embedding?: { baseUrl: string; model: string } | null
    onFormChange?: (form: AiProviderFormState) => void
    onEmbeddingFormChange?: (form: AiEmbeddingFormState) => void
    onApplyPreset?: () => void
  } = {},
) {
  const onFormChange = overrides.onFormChange ?? noop
  const onEmbeddingFormChange = overrides.onEmbeddingFormChange ?? noop
  render(
    <AiProviderForm
      providers={[]}
      configForm={overrides.configForm ?? EMPTY_PROVIDER_FORM}
      onFormChange={onFormChange}
      onSave={noop}
      onRemove={noop}
      onApplyPreset={overrides.onApplyPreset ?? noop}
      embedding={overrides.embedding ?? null}
      embeddingForm={overrides.embeddingForm ?? EMPTY_EMBEDDING_FORM}
      onEmbeddingFormChange={onEmbeddingFormChange}
      onSaveEmbedding={noop}
      onRemoveEmbedding={noop}
    />,
  )
  return { onFormChange, onEmbeddingFormChange }
}

describe('预设', () => {
  it('服务商预设覆盖 16 家,且不再夹带向量模型', () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(16)
    expect(PROVIDER_PRESETS.find((preset) => preset.label === 'DeepSeek')).toEqual({
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
    })
    expect(PROVIDER_PRESETS.every((preset) => !('embeddingModel' in preset))).toBe(true)
  })

  it('Embedding 预设都带完整地址与服务商短标', () => {
    expect(EMBEDDING_PRESETS.length).toBeGreaterThanOrEqual(10)
    for (const preset of EMBEDDING_PRESETS) {
      expect(preset.model.length).toBeGreaterThan(0)
      expect(preset.vendor.length).toBeGreaterThan(0)
      expect(embeddingHost(preset.baseUrl)).not.toBe('')
    }
    expect(embeddingHost('https://api.siliconflow.cn/v1')).toBe('api.siliconflow.cn')
    expect(embeddingHost('不是地址')).toBe('')
  })

  it('海外域名被标出来,国内可直连的没有', () => {
    const gemini = EMBEDDING_PRESETS.find((preset) => preset.vendor === 'Google')
    const silicon = EMBEDDING_PRESETS.find((preset) => preset.vendor === '硅基流动')
    expect(gemini && needsOverseasNetwork(gemini)).toBe(true)
    expect(silicon && needsOverseasNetwork(silicon)).toBe(false)
  })
})

describe('AiProviderForm · 三块互不干扰', () => {
  it('对话表单只管对话模型,向量服务是独立的一块', () => {
    renderForm()
    expect(screen.getByText('新增服务')).toBeTruthy()
    expect(screen.getByText('对话服务 · 已配置 0')).toBeTruthy()
    expect(screen.getByText('全书问答 · 向量服务')).toBeTruthy()
    expect(screen.getByText('未配置')).toBeTruthy()
    expect(screen.getByRole('button', { name: '快速填充服务商' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择 Embedding 模型预设' })).toBeTruthy()
    for (const label of [/名称/, /Base URL/, /API Key/, /对话模型/, /TTS/, /模型 ID/]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    // 对话表单里不再有 Embedding 输入框。
    expect(screen.queryByPlaceholderText('选预设或手填模型 ID')).toBeNull()
    expect(document.querySelectorAll('.ai-fields-grid .ai-section')).toHaveLength(2)
    expect(document.querySelector('.ai-embedding-grid')).toBeTruthy()
    expect(screen.getByText(/与这里互不干扰/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('选向量预设只写向量表单,绝不改对话服务的地址', () => {
    const changes: AiEmbeddingFormState[] = []
    const chatChanges: AiProviderFormState[] = []
    const chatForm = {
      ...EMPTY_PROVIDER_FORM,
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
    }
    renderForm({
      configForm: chatForm,
      onFormChange: (form) => chatChanges.push(form),
      onEmbeddingFormChange: (form) => changes.push(form),
    })
    fireEvent.click(screen.getByRole('button', { name: '选择 Embedding 模型预设' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /BAAI\/bge-m3/ }))
    expect(changes.at(-1)).toEqual({
      ...EMPTY_EMBEDDING_FORM,
      model: 'BAAI/bge-m3',
      baseUrl: 'https://api.siliconflow.cn/v1',
    })
    expect(chatChanges).toHaveLength(0)
  })

  it('已配置时给出状态、移除入口与当前模型', () => {
    renderForm({
      embedding: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' },
      embeddingForm: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', apiKey: '' },
    })
    expect(screen.getByText('已配置')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存向量服务' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '移除' })).toBeTruthy()
    expect(screen.getByText(/当前：BAAI\/bge-m3/)).toBeTruthy()
    expect(screen.getByText(/地址已对齐/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '测试连接' })).toBeTruthy()
  })

  it('表单有未保存改动时禁用测试按钮,免得测到旧配置', () => {
    renderForm({
      embedding: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' },
      embeddingForm: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-embedding-001',
        apiKey: '',
      },
    })
    const probe = screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement
    expect(probe.disabled).toBe(true)
    expect(probe.title).toMatch(/先保存/)
    expect(screen.getByText(/需能直连海外域名/)).toBeTruthy()
  })
})

describe('useAiProviders · 独立向量服务', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    runtimeMock.mockReturnValue(false)
    localStorage.clear()
  })

  it('保存向量服务只走 ai.embedding.set,不碰对话配置', async () => {
    invokeMock.mockResolvedValue({
      embedding: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' },
    })
    const { result } = renderHook(() => useAiProviders())
    await act(async () => {
      result.current.setEmbeddingForm({
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'BAAI/bge-m3',
        apiKey: 'sk-silicon',
      })
    })
    expect(result.current.configForm).toEqual(EMPTY_PROVIDER_FORM)
    await act(async () => {
      await result.current.saveEmbedding()
    })
    expect(invokeMock).toHaveBeenCalledWith('ai.embedding.set', {
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'BAAI/bge-m3',
      apiKey: 'sk-silicon',
    })
    expect(invokeMock).not.toHaveBeenCalledWith('ai.config.save', expect.anything())
    expect(result.current.embedding).toEqual({
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'BAAI/bge-m3',
    })
    // 密钥不留在内存里,下一次留空即表示继续用旧密钥。
    expect(result.current.embeddingForm.apiKey).toBe('')
    expect(result.current.embeddingNotice).toMatch(/重建索引/)
  })

  it('移除向量服务清空本块状态', async () => {
    invokeMock.mockResolvedValue({ removed: true })
    const { result } = renderHook(() => useAiProviders())
    await act(async () => {
      await result.current.removeEmbedding()
    })
    expect(invokeMock).toHaveBeenCalledWith('ai.embedding.remove', undefined)
    expect(result.current.embedding).toBeNull()
    expect(result.current.embeddingForm).toEqual(EMPTY_EMBEDDING_FORM)
  })

  it('测试连接走真实 ai.embed 并回报维度', async () => {
    invokeMock.mockResolvedValue({ vectors: [[0.1, 0.2, 0.3]] })
    const { result } = renderHook(() => useAiProviders())
    await act(async () => {
      await result.current.testEmbedding()
    })
    const call = invokeMock.mock.calls.find(([command]) => command === 'ai.embed')
    expect(call?.[1]).toMatchObject({
      configId: 'embedding-service',
      texts: ['向量服务连通性测试'],
    })
    expect(result.current.embeddingNotice).toMatch(/连通,返回 3 维/)
    expect(result.current.embeddingBusy).toBe(false)
  })

  it('测试连接失败时把上游原因原样显示', async () => {
    invokeMock.mockRejectedValue(new Error('向量服务返回 HTTP 404:Not found'))
    const { result } = renderHook(() => useAiProviders())
    await act(async () => {
      await result.current.testEmbedding()
    })
    expect(result.current.embeddingError).toMatch(/HTTP 404/)
    expect(result.current.embeddingNotice).toBeNull()
    expect(result.current.embeddingBusy).toBe(false)
  })

  it('列表里的 embedding 单独回填,不混进对话服务列表', async () => {
    runtimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      providers: [
        {
          id: 'cfg-deepseek',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-v4-pro',
        },
      ],
      embedding: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' },
    })
    const { result } = renderHook(() => useAiProviders())
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.providers).toHaveLength(1)
    expect(result.current.embedding?.model).toBe('BAAI/bge-m3')
    expect(result.current.embeddingForm).toEqual({
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'BAAI/bge-m3',
      apiKey: '',
    })
  })
})

describe('useAiProviders · OC Ferry', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    runtimeMock.mockReturnValue(false)
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

describe('useAiProviders · 编辑与启用', () => {
  const provider = {
    id: 'cfg-1',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    embeddingModel: 'BAAI/bge-m3',
  }

  beforeEach(() => {
    invokeMock.mockReset()
    runtimeMock.mockReturnValue(false)
    localStorage.clear()
  })

  it('editing keeps the old key and the legacy embeddingModel', async () => {
    invokeMock.mockResolvedValue({ provider })
    const { result } = renderHook(() => useAiProviders())
    act(() => result.current.editProvider(provider))
    expect(result.current.editingId).toBe('cfg-1')
    expect(result.current.configForm.apiKey).toBe('')
    expect(result.current.configForm.embeddingModel).toBe('BAAI/bge-m3')
    await act(async () => {
      await result.current.saveProvider()
    })
    const saveCall = invokeMock.mock.calls.find(([command]) => command === 'ai.config.save')
    expect(saveCall?.[1]).toMatchObject({
      apiKey: '',
      provider: { id: 'cfg-1', embeddingModel: 'BAAI/bge-m3' },
    })
    expect(result.current.editingId).toBeNull()
  })

  it('activating a provider does not disturb the form', () => {
    const { result } = renderHook(() => useAiProviders())
    act(() => result.current.activateProvider('cfg-9'))
    expect(result.current.activeId).toBe('cfg-9')
    expect(result.current.editingId).toBeNull()
    expect(localStorage.getItem('deepread.ai.activeProvider')).toBe('cfg-9')
  })
})
