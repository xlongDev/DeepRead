import { useCallback, useEffect, useState } from 'react'
import { Check, PencilSimple, X } from '@phosphor-icons/react'
import { DropdownMenu } from '../../components/DropdownMenu'
import {
  toAppError,
  type AiEmbeddingConfig,
  type AiProviderConfig,
  type OcFerryDiscovery,
} from '@deepread/shared'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'
import { resolveActiveProvider, writeActiveProviderId } from '../../lib/ai-active-provider'

export interface ProviderPreset {
  readonly label: string
  readonly baseUrl: string
  readonly model: string
}

/** 预设只是起点:地址与模型名都能在下面改,别把版本号当成配置契约。 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
  { label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' },
  {
    label: '通义 Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
  },
  { label: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
  {
    label: 'Ollama(本地)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3.8-flash',
  },
  { label: 'LM Studio(本地)', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  {
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
  },
  {
    label: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-pro-32k',
  },
  {
    label: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-turbo',
  },
  { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
  {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  { label: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1', model: 'yi-large' },
]

export interface EmbeddingPreset {
  /** 下拉里只显示模型 ID:服务商放右侧短标,长说明留给选后那行字。 */
  readonly model: string
  readonly vendor: string
  /** 该模型所属的 OpenAI 兼容根地址,选中时填入**向量服务自己的**地址。 */
  readonly baseUrl: string
  readonly note: string
}

/** 需要直连海外域名的几家:国内网络常被拦,选中时提前说清,别等建索引才报错。 */
const OVERSEAS_VENDORS = new Set(['OpenAI', 'Google', 'Jina', 'Voyage', 'Cohere'])
export function needsOverseasNetwork(preset: EmbeddingPreset): boolean {
  return OVERSEAS_VENDORS.has(preset.vendor)
}

/**
 * 2026 年常用的向量模型。它们与对话模型分属两套配置:选中只写「全书问答 ·
 * 向量服务」这一块,绝不改对话服务的 Base URL / API Key / 模型。
 */
export const EMBEDDING_PRESETS: readonly EmbeddingPreset[] = [
  {
    model: 'BAAI/bge-m3',
    vendor: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    note: '中文 / 多语检索首选 · 1024 维',
  },
  {
    model: 'Qwen/Qwen3-Embedding-8B',
    vendor: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    note: 'MTEB 多语榜首 · 32K 上下文',
  },
  {
    model: 'Qwen/Qwen3-Embedding-0.6B',
    vendor: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    note: '轻量 · 1024 维',
  },
  {
    model: 'text-embedding-v4',
    vendor: '阿里百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    note: '1024 维 · 有免费额度',
  },
  {
    model: 'embedding-3',
    vendor: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    note: '2048 维',
  },
  {
    model: 'text-embedding-3-large',
    vendor: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    note: '3072 维 · 生态最全',
  },
  {
    model: 'text-embedding-3-small',
    vendor: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    note: '1536 维 · 性价比',
  },
  {
    model: 'gemini-embedding-001',
    vendor: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    note: '检索榜首 · 3072 维',
  },
  {
    model: 'jina-embeddings-v4',
    vendor: 'Jina',
    baseUrl: 'https://api.jina.ai/v1',
    note: '文本 / 图像同空间 · 32K',
  },
  {
    model: 'voyage-3.5',
    vendor: 'Voyage',
    baseUrl: 'https://api.voyageai.com/v1',
    note: '长文档检索',
  },
  {
    model: 'embed-v4.0',
    vendor: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    note: '多模态 · 128K',
  },
  {
    model: 'bge-m3',
    vendor: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    note: '本地 · 免 Key',
  },
  {
    model: 'nomic-embed-text',
    vendor: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    note: '本地 · 轻量',
  },
]

/** 用 host 比对两份地址:端口、路径差异都算不同,避免把代理地址误判成同一家。 */
export function embeddingHost(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).host
  } catch {
    return ''
  }
}

export interface AiProviderFormState {
  readonly name: string
  readonly baseUrl: string
  readonly model: string
  /** 兼容旧数据:老配置把向量模型写在对话 Provider 上,编辑时要原样带回。 */
  readonly embeddingModel: string
  readonly ttsModel: string
  readonly apiKey: string
}

export const EMPTY_PROVIDER_FORM: AiProviderFormState = {
  name: '',
  baseUrl: '',
  model: '',
  embeddingModel: '',
  ttsModel: '',
  apiKey: '',
}

/** 向量服务有自己的地址、模型与密钥,和上面的对话表单没有任何共享字段。 */
export interface AiEmbeddingFormState {
  readonly baseUrl: string
  readonly model: string
  readonly apiKey: string
}

export const EMPTY_EMBEDDING_FORM: AiEmbeddingFormState = {
  baseUrl: '',
  model: '',
  apiKey: '',
}

/**
 * AI 服务配置的唯一状态机:阅读器内的 ✦ 助手和主设置页共用同一份数据面,
 * 保存/删除走同一组 IPC,两处看到的服务列表永远一致。
 */
export function useAiProviders() {
  const [providers, setProviders] = useState<readonly AiProviderConfig[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 表单正在改哪一条;null = 新增。与「当前生效」是两个独立概念。 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [configForm, setConfigForm] = useState<AiProviderFormState>(EMPTY_PROVIDER_FORM)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const [embedding, setEmbedding] = useState<AiEmbeddingConfig | null>(null)
  const [embeddingForm, setEmbeddingForm] = useState<AiEmbeddingFormState>(EMPTY_EMBEDDING_FORM)
  const [embeddingError, setEmbeddingError] = useState<string | null>(null)
  const [embeddingNotice, setEmbeddingNotice] = useState<string | null>(null)
  const [embeddingBusy, setEmbeddingBusy] = useState(false)

  const saveProvider = useCallback(
    async (onSaved?: (provider: AiProviderConfig) => void): Promise<void> => {
      const id =
        editingId ?? `cfg-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
      try {
        const legacyEmbeddingModel = configForm.embeddingModel.trim()
        const ttsModel = configForm.ttsModel.trim()
        const response = await invokeCommand('ai.config.save', {
          provider: {
            id,
            name: configForm.name.trim() || '自定义',
            baseUrl: configForm.baseUrl.trim(),
            model: configForm.model.trim(),
            // 旧数据里写在对话服务上的向量模型,编辑时原样带回不丢;新配置一律
            // 走下面那块独立的向量服务。
            ...(legacyEmbeddingModel ? { embeddingModel: legacyEmbeddingModel } : {}),
            ...(ttsModel ? { ttsModel } : {}),
          },
          // 编辑时页面拿不到旧密钥(ADR-0010);留空即让 Rust 保留钥匙串里的那份。
          apiKey: configForm.apiKey.trim(),
        })
        setProviders((current) => [
          response.provider,
          ...current.filter((provider) => provider.id !== response.provider.id),
        ])
        setActiveId(response.provider.id)
        // 保存即选中:这次保存的服务对 AI 抽屉 / TTS / 学习工具立即生效并跨会话记住。
        writeActiveProviderId(response.provider.id)
        setEditingId(null)
        setConfigForm(EMPTY_PROVIDER_FORM)
        setError(null)
        setNotice('已保存并设为当前生效的服务')
        onSaved?.(response.provider)
      } catch (saveError) {
        setError(toAppError(saveError).message)
        setNotice(null)
      }
    },
    [editingId, configForm],
  )

  const removeProvider = useCallback(
    async (id: string): Promise<void> => {
      try {
        await invokeCommand('ai.config.remove', { id })
        const remaining = providers.filter((provider) => provider.id !== id)
        setProviders(remaining)
        setEditingId((current) => (current === id ? null : current))
        if (activeId === id) {
          // 删掉正在用的不能留成「未选择」:回落到第一条,并记住这个选择。
          const fallback = remaining[0]?.id ?? null
          setActiveId(fallback)
          if (fallback !== null) writeActiveProviderId(fallback)
          else writeActiveProviderId('')
        }
        setError(null)
        setNotice('已移除该服务')
      } catch (removeError) {
        setError(toAppError(removeError).message)
      }
    },
    [activeId, providers],
  )

  /** 只切换「当前生效」,不碰表单 —— 用户可能正在编辑另一条。 */
  const activateProvider = useCallback((id: string): void => {
    setActiveId(id)
    writeActiveProviderId(id)
    setError(null)
    setNotice('已切换当前生效的服务')
  }, [])

  /** 点已配置的卡片回填表单;密钥不回传页面,留空保存即保留旧密钥。 */
  const editProvider = useCallback((provider: AiProviderConfig): void => {
    setEditingId(provider.id)
    setConfigForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      embeddingModel: provider.embeddingModel ?? '',
      ttsModel: provider.ttsModel ?? '',
      apiKey: '',
    })
    setError(null)
    setNotice(null)
  }, [])

  const newProvider = useCallback((): void => {
    setEditingId(null)
    setConfigForm(EMPTY_PROVIDER_FORM)
    setError(null)
    setNotice(null)
  }, [])

  const saveEmbedding = useCallback(async (): Promise<void> => {
    try {
      const response = await invokeCommand('ai.embedding.set', {
        baseUrl: embeddingForm.baseUrl.trim(),
        model: embeddingForm.model.trim(),
        apiKey: embeddingForm.apiKey.trim(),
      })
      setEmbedding(response.embedding)
      // 密钥不回传页面:保存完把输入框清空,下次留空即表示「继续用旧密钥」。
      setEmbeddingForm((form) => ({ ...form, apiKey: '' }))
      setEmbeddingError(null)
      setEmbeddingNotice('已保存。换模型或换服务商后需重建索引。')
    } catch (saveError) {
      setEmbeddingError(toAppError(saveError).message)
      setEmbeddingNotice(null)
    }
  }, [embeddingForm])

  /**
   * 连通性自检:走真实的 ai.embed(一条短文本),测的是**已保存**的向量服务。
   * 海外端点连不上、Key 无效、模型名不存在都能在设置页当场看到,不用去 AI
   * 抽屉点「建立索引」才发现。
   */
  const testEmbedding = useCallback(async (): Promise<void> => {
    setEmbeddingBusy(true)
    try {
      const response = await invokeCommand('ai.embed', {
        // ai.embed 的 configId 只是协议字段:有独立向量服务时 Rust 不读它。
        taskId: `probe-${Date.now().toString(36)}`,
        configId: 'embedding-service',
        texts: ['向量服务连通性测试'],
      })
      setEmbeddingError(null)
      setEmbeddingNotice(
        `✓ 连通,返回 ${response.vectors[0]?.length ?? 0} 维向量。换模型或换服务商后需重建索引。`,
      )
    } catch (probeError) {
      setEmbeddingNotice(null)
      setEmbeddingError(toAppError(probeError).message)
    } finally {
      setEmbeddingBusy(false)
    }
  }, [])

  const removeEmbedding = useCallback(async (): Promise<void> => {
    try {
      await invokeCommand('ai.embedding.remove', undefined)
      setEmbedding(null)
      setEmbeddingForm(EMPTY_EMBEDDING_FORM)
      setEmbeddingError(null)
      setEmbeddingNotice('已移除向量服务。全书问答与建索引暂不可用。')
    } catch (removeError) {
      setEmbeddingError(toAppError(removeError).message)
      setEmbeddingNotice(null)
    }
  }, [])

  /** OC Ferry 的探测与采用都走 Rust:密钥不进页面(ADR-0010)。 */
  const detectOcFerry = useCallback(async (): Promise<OcFerryDiscovery | null> => {
    try {
      const found = await invokeCommand('ai.ocFerry.detect', undefined)
      setError(null)
      return found
    } catch (detectError) {
      setError(toAppError(detectError).message)
      return null
    }
  }, [])

  const adoptOcFerryModel = useCallback(async (model: string): Promise<boolean> => {
    try {
      const response = await invokeCommand('ai.ocFerry.use', { model })
      setProviders((current) => [
        response.provider,
        ...current.filter((provider) => provider.id !== response.provider.id),
      ])
      setActiveId(response.provider.id)
      // 与 saveProvider 同一条规则:采用即生效,并跨会话记住。
      writeActiveProviderId(response.provider.id)
      setEditingId(null)
      setError(null)
      setNotice('已启用本机 OC Ferry 模型')
      return true
    } catch (useError) {
      setError(toAppError(useError).message)
      return false
    }
  }, [])

  const reload = useCallback((): Promise<void> => {
    if (!isTauriRuntime()) {
      setLoaded(true)
      return Promise.resolve()
    }
    return invokeCommand('ai.config.list', undefined)
      .then((response) => {
        const list = response?.providers ?? []
        setProviders(list)
        // 上次选中的服务优先(已删则回落第一个),选择跨会话保持。
        setActiveId((current) => current ?? resolveActiveProvider(list)?.id ?? null)
        const found = response?.embedding ?? null
        setEmbedding(found)
        // 只在用户还没开始填向量表单时回填,别覆盖正在编的内容。
        setEmbeddingForm((form) =>
          form.baseUrl.trim() === '' && form.model.trim() === '' && found !== null
            ? { baseUrl: found.baseUrl, model: found.model, apiKey: '' }
            : form,
        )
        setError(null)
        setLoaded(true)
      })
      .catch((listError) => {
        // 列表拉取失败不再静默成空列表:设置页要能看见「为什么没有 Provider」,
        // 而不是把数据库错误伪装成「你还没配置过」。
        setError(toAppError(listError).message)
        setLoaded(true)
      })
  }, [])

  // 首次挂载拉一次列表(IPC 属外部系统同步)。放进微任务:同步 setState 会
  // 触发级联渲染,而列表数据在第一帧之后才有意义。
  useEffect(() => {
    void Promise.resolve().then(reload)
  }, [reload])

  return {
    providers,
    loaded,
    activeId,
    setActiveId,
    editingId,
    configForm,
    setConfigForm,
    saveProvider,
    removeProvider,
    activateProvider,
    editProvider,
    newProvider,
    embedding,
    embeddingForm,
    setEmbeddingForm,
    saveEmbedding,
    removeEmbedding,
    testEmbedding,
    embeddingBusy,
    embeddingError,
    embeddingNotice,
    detectOcFerry,
    adoptOcFerryModel,
    reload,
    error,
    notice,
  }
}

interface AiProviderFormProps {
  readonly providers: readonly AiProviderConfig[]
  readonly activeId?: string | null
  readonly editingId?: string | null
  readonly notice?: string | null
  readonly configForm: AiProviderFormState
  readonly onFormChange: (form: AiProviderFormState) => void
  readonly onSave: () => Promise<void> | void
  readonly onRemove: (id: string) => Promise<void> | void
  readonly onActivate?: (id: string) => void
  readonly onEdit?: (provider: AiProviderConfig) => void
  readonly onNew?: () => void
  readonly onApplyPreset?: (preset: ProviderPreset) => void
  readonly error?: string | null
  readonly embedding: AiEmbeddingConfig | null
  readonly embeddingForm: AiEmbeddingFormState
  readonly onEmbeddingFormChange: (form: AiEmbeddingFormState) => void
  readonly onSaveEmbedding: () => Promise<void> | void
  readonly onRemoveEmbedding: () => Promise<void> | void
  readonly onTestEmbedding?: () => Promise<void> | void
  readonly embeddingBusy?: boolean
  readonly embeddingNotice?: string | null
  readonly embeddingError?: string | null
}

/**
 * AI 配置页:三块互不干扰 —— 对话服务、全书问答的向量服务、本机免费模型。
 * 向量服务有自己的地址与密钥,不借用对话 Provider 的任何字段。
 */
export function AiProviderForm({
  providers,
  activeId,
  editingId,
  notice,
  configForm,
  onFormChange,
  onSave,
  onRemove,
  onActivate,
  onEdit,
  onNew,
  onApplyPreset,
  error,
  embedding,
  embeddingForm,
  onEmbeddingFormChange,
  onSaveEmbedding,
  onRemoveEmbedding,
  onTestEmbedding,
  embeddingBusy = false,
  embeddingNotice,
  embeddingError,
}: AiProviderFormProps) {
  const presetOptions = PROVIDER_PRESETS.map((preset) => ({
    value: preset.label,
    label: preset.label,
    hint: preset.model,
  }))
  const selectedPreset =
    PROVIDER_PRESETS.find((preset) => preset.label === configForm.name)?.label ?? ''
  const set = (key: keyof AiProviderFormState, value: string): void =>
    onFormChange({ ...configForm, [key]: value })

  const embeddingOptions = EMBEDDING_PRESETS.map((preset) => ({
    value: preset.model,
    label: preset.model,
    hint: preset.vendor,
  }))
  const embeddingPreset = EMBEDDING_PRESETS.find(
    (preset) => preset.model === embeddingForm.model.trim(),
  )
  const setEmbedding = (key: keyof AiEmbeddingFormState, value: string): void =>
    onEmbeddingFormChange({ ...embeddingForm, [key]: value })
  const embeddingHostMatches =
    embeddingPreset !== undefined &&
    embeddingHost(embeddingPreset.baseUrl) === embeddingHost(embeddingForm.baseUrl)
  const embeddingReady = embeddingForm.baseUrl.trim() !== '' && embeddingForm.model.trim() !== ''
  // 测试按钮测的是已保存的配置:表单还没保存时禁用,免得「测过了」是假阳性。
  const embeddingHasUnsavedChanges =
    embedding !== null &&
    (embeddingForm.baseUrl.trim() !== embedding.baseUrl ||
      embeddingForm.model.trim() !== embedding.model ||
      embeddingForm.apiKey.trim() !== '')

  return (
    <div className="ai-provider-module">
      <section className="ai-section">
        <p className="ai-section-title">对话服务 · 已配置 {providers.length}</p>
        {providers.length === 0 ? (
          <p className="ai-section-hint">
            还没有服务。下面选一家快速填充，或在最下方检测本机的 OC Ferry 免费模型。
          </p>
        ) : (
          <div className="ai-provider-list">
            {providers.map((provider) => {
              const isActive = provider.id === activeId
              return (
                <div
                  key={provider.id}
                  className={`ai-provider-card${isActive ? ' is-active' : ''}`}
                >
                  <button
                    type="button"
                    className="ai-provider-info"
                    onClick={() => onEdit?.(provider)}
                    title="编辑这份配置"
                    aria-label={`编辑 ${provider.name}`}
                  >
                    <strong>
                      {provider.name}
                      {isActive && <em className="ai-provider-current">当前生效</em>}
                    </strong>
                    <span>
                      {provider.model} · {provider.baseUrl}
                    </span>
                  </button>
                  <div className="ai-provider-actions">
                    {!isActive && (
                      <button
                        type="button"
                        className="chrome-button"
                        onClick={() => onActivate?.(provider.id)}
                        aria-label={`启用 ${provider.name}`}
                        title="设为当前生效"
                      >
                        <Check size={14} weight="regular" aria-hidden />
                      </button>
                    )}
                    <button
                      type="button"
                      className="chrome-button"
                      onClick={() => void onRemove(provider.id)}
                      aria-label={`移除 ${provider.name}`}
                      title="移除"
                    >
                      <X size={14} weight="regular" aria-hidden />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="ai-section ai-form-section">
        <div className="ai-section-head">
          <p className="ai-section-title">{editingId ? '编辑服务' : '新增服务'}</p>
          {editingId && (
            <button type="button" className="ai-link-btn" onClick={onNew}>
              改为新增
            </button>
          )}
        </div>
        {editingId && (
          <p className="ai-section-hint">
            <PencilSimple size={12} aria-hidden /> 密钥留空即保留原值；改完点「更新配置」。
          </p>
        )}

        {onApplyPreset && (
          <DropdownMenu
            value={selectedPreset}
            options={presetOptions}
            onChange={(label) => {
              const preset = PROVIDER_PRESETS.find((item) => item.label === label)
              if (preset !== undefined) onApplyPreset(preset)
            }}
            ariaLabel="快速填充服务商"
            title="只填对话服务的名称、Base URL 与模型;向量服务在下面单独配置"
          >
            <span className="dropdown-value">{selectedPreset || '快速填充服务商…'}</span>
          </DropdownMenu>
        )}

        <div className="ai-fields-grid">
          <section className="ai-section">
            <p className="ai-section-title">连接信息</p>
            <label className="ai-field">
              <span className="ai-field-label">名称</span>
              <input
                className="field-input"
                placeholder="给这份配置起个名字"
                value={configForm.name}
                onChange={(event) => set('name', event.target.value)}
              />
            </label>
            <label className="ai-field">
              <span className="ai-field-label">Base URL</span>
              <input
                className="field-input"
                placeholder="OpenAI 兼容地址,含 /v1"
                value={configForm.baseUrl}
                onChange={(event) => set('baseUrl', event.target.value)}
              />
            </label>
            <label className="ai-field">
              <span className="ai-field-label">API Key</span>
              <input
                className="field-input"
                type="password"
                placeholder={editingId ? '留空则保留已存密钥' : '存入系统钥匙串'}
                value={configForm.apiKey}
                onChange={(event) => set('apiKey', event.target.value)}
              />
            </label>
          </section>

          <section className="ai-section">
            <p className="ai-section-title">模型</p>
            <label className="ai-field">
              <span className="ai-field-label">
                对话模型 <em className="ai-field-hint">必填</em>
              </span>
              <input
                className="field-input"
                placeholder="如 deepseek-v4-pro"
                value={configForm.model}
                onChange={(event) => set('model', event.target.value)}
              />
            </label>
            <label className="ai-field">
              <span className="ai-field-label">
                TTS <em className="ai-field-hint">可选 · 云端朗读</em>
              </span>
              <input
                className="field-input"
                placeholder="留空则用本地朗读"
                value={configForm.ttsModel}
                onChange={(event) => set('ttsModel', event.target.value)}
              />
            </label>
            <p className="ai-field-note">
              全书问答 / 建索引用的向量模型在下一块单独配置，与这里互不干扰。
            </p>
          </section>
        </div>

        <div className="ai-form-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onSave()}
            disabled={
              configForm.baseUrl.trim().length === 0 || configForm.model.trim().length === 0
            }
          >
            {editingId ? '更新配置' : '保存配置'}
          </button>
          <p className="ai-privacy">
            密钥保存在本机钥匙串，不会进入页面或仓库；对话时仅发送勾选的正文片段。
          </p>
        </div>
        {notice != null && <output className="ai-notice">{notice}</output>}
        {error != null && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="ai-section ai-embedding-section">
        <div className="ai-section-head">
          <p className="ai-section-title">全书问答 · 向量服务</p>
          <span className={`ai-service-state${embedding !== null ? ' is-on' : ''}`}>
            {embedding !== null ? '已配置' : '未配置'}
          </span>
        </div>
        <p className="ai-section-hint">
          独立的一份配置：地址、密钥、模型都只用于 <code>/embeddings</code>，
          不会影响上面的对话模型。DeepSeek / Kimi / OC Ferry
          只有对话接口时，在这里单独配一家向量服务即可。OpenAI / Gemini / Jina / Voyage / Cohere
          需能直连海外域名，国内网络建议硅基流动 / 百炼 / 智谱。
        </p>

        <div className="ai-embedding-grid">
          <label className="ai-field">
            <span className="ai-field-label">模型 ID</span>
            <input
              className="field-input"
              placeholder="如 BAAI/bge-m3"
              value={embeddingForm.model}
              onChange={(event) => setEmbedding('model', event.target.value)}
            />
          </label>
          <DropdownMenu
            value={embeddingPreset?.model ?? ''}
            options={embeddingOptions}
            onChange={(model) => {
              const preset = EMBEDDING_PRESETS.find((item) => item.model === model)
              if (preset !== undefined) {
                // 只写向量服务自己的地址与模型 —— 不碰对话表单。
                onEmbeddingFormChange({
                  ...embeddingForm,
                  baseUrl: preset.baseUrl,
                  model: preset.model,
                })
              }
            }}
            ariaLabel="选择 Embedding 模型预设"
            title="2026 年常用的向量模型;选中会填入该家地址到本区块的 Base URL"
            menuAlign="end"
          >
            <span className="dropdown-value">
              {embeddingPreset?.model ?? '选择热门 Embedding 模型…'}
            </span>
          </DropdownMenu>
          <label className="ai-field is-wide">
            <span className="ai-field-label">Base URL</span>
            <input
              className="field-input"
              placeholder="向量服务的 OpenAI 兼容地址"
              value={embeddingForm.baseUrl}
              onChange={(event) => setEmbedding('baseUrl', event.target.value)}
            />
          </label>
          <label className="ai-field is-wide">
            <span className="ai-field-label">API Key</span>
            <input
              className="field-input"
              type="password"
              placeholder={embedding !== null ? '留空则保留已存密钥' : '该家服务的密钥'}
              value={embeddingForm.apiKey}
              onChange={(event) => setEmbedding('apiKey', event.target.value)}
            />
          </label>
        </div>

        {embeddingPreset !== undefined && embeddingHostMatches && (
          <p className="ai-field-note is-ok">
            ✓ {embeddingPreset.vendor} · {embeddingPreset.note}；地址已对齐。
          </p>
        )}
        {embeddingPreset !== undefined && needsOverseasNetwork(embeddingPreset) && (
          <p className="ai-field-note">
            ⚠ 该域名需能直连，连不上时请换国内服务或用「测试连接」确认。
          </p>
        )}
        {embeddingPreset !== undefined && !embeddingHostMatches && (
          <p className="ai-field-note">当前是自定义地址，请确认它提供 /embeddings 接口。</p>
        )}
        {embeddingPreset === undefined && embeddingForm.model.trim() !== '' && (
          <p className="ai-field-note">自定义模型：请确认当前地址提供 /embeddings 接口。</p>
        )}
        {embeddingPreset === undefined && embeddingForm.model.trim() === '' && (
          <p className="ai-field-note">
            留空则全书问答与建索引不可用；换模型或换服务商后要重建索引。
          </p>
        )}

        <div className="ai-embedding-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onSaveEmbedding()}
            disabled={!embeddingReady}
          >
            保存向量服务
          </button>
          {embedding !== null && (
            <button
              type="button"
              className="btn"
              onClick={() => void onTestEmbedding?.()}
              disabled={embeddingBusy || embeddingHasUnsavedChanges}
              title={
                embeddingHasUnsavedChanges
                  ? '先保存改动再测试'
                  : '用一条短文本测试已保存的向量服务是否可用'
              }
            >
              {embeddingBusy ? '测试中…' : '测试连接'}
            </button>
          )}
          {embedding !== null && (
            <button type="button" className="btn" onClick={() => void onRemoveEmbedding()}>
              移除
            </button>
          )}
          {embedding !== null && (
            <span className="ai-service-current">
              当前：{embedding.model} · {embeddingHost(embedding.baseUrl)}
            </span>
          )}
        </div>
        {embeddingNotice != null && <output className="ai-notice">{embeddingNotice}</output>}
        {embeddingError != null && (
          <p className="ai-error" role="alert">
            {embeddingError}
          </p>
        )}
      </section>
    </div>
  )
}
