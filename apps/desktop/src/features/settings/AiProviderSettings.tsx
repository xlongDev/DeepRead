import { useCallback, useEffect, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { DropdownMenu } from '../../components/DropdownMenu'
import { toAppError, type AiProviderConfig, type OcFerryDiscovery } from '@deepread/shared'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'
import { resolveActiveProvider, writeActiveProviderId } from '../../lib/ai-active-provider'

export const PROVIDER_PRESETS: readonly {
  readonly label: string
  readonly baseUrl: string
  readonly model: string
}[] = [
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
  { label: 'Ollama(本地)', baseUrl: 'http://localhost:11434/v1', model: 'qwen3.8-flash' },
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
  // 预设只是起点:地址与模型名都能在下面改,别把版本号当成配置契约。
]

export interface AiProviderFormState {
  readonly name: string
  readonly baseUrl: string
  readonly model: string
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

/**
 * AI 服务配置的唯一状态机:阅读器内的 ✦ 助手和主设置页共用同一份数据面,
 * 保存/删除走同一组 IPC,两处看到的服务列表永远一致。
 */
export function useAiProviders() {
  const [providers, setProviders] = useState<readonly AiProviderConfig[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [configForm, setConfigForm] = useState<AiProviderFormState>(EMPTY_PROVIDER_FORM)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const saveProvider = useCallback(
    async (onSaved?: (provider: AiProviderConfig) => void): Promise<void> => {
      const id =
        activeId ?? `cfg-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
      try {
        const embeddingModel = configForm.embeddingModel.trim()
        const ttsModel = configForm.ttsModel.trim()
        const response = await invokeCommand('ai.config.save', {
          provider: {
            id,
            name: configForm.name.trim() || '自定义',
            baseUrl: configForm.baseUrl.trim(),
            model: configForm.model.trim(),
            ...(embeddingModel ? { embeddingModel } : {}),
            ...(ttsModel ? { ttsModel } : {}),
          },
          apiKey: configForm.apiKey.trim(),
        })
        setProviders((current) => [
          response.provider,
          ...current.filter((provider) => provider.id !== response.provider.id),
        ])
        setActiveId(response.provider.id)
        // 保存即选中:这次保存的服务对 AI 抽屉 / TTS / 学习工具立即生效并跨会话记住。
        writeActiveProviderId(response.provider.id)
        setConfigForm(EMPTY_PROVIDER_FORM)
        setError(null)
        onSaved?.(response.provider)
      } catch (saveError) {
        setError(toAppError(saveError).message)
      }
    },
    [activeId, configForm],
  )

  const removeProvider = useCallback(async (id: string): Promise<void> => {
    try {
      await invokeCommand('ai.config.remove', { id })
      setProviders((current) => current.filter((provider) => provider.id !== id))
      setActiveId((current) => (current === id ? null : current))
    } catch (removeError) {
      setError(toAppError(removeError).message)
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
      setError(null)
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
    configForm,
    setConfigForm,
    saveProvider,
    removeProvider,
    detectOcFerry,
    adoptOcFerryModel,
    reload,
    error,
  }
}

interface AiProviderFormProps {
  readonly providers: readonly AiProviderConfig[]
  readonly configForm: AiProviderFormState
  readonly onFormChange: (form: AiProviderFormState) => void
  readonly onSave: () => Promise<void> | void
  readonly onRemove: (id: string) => Promise<void> | void
  readonly onApplyPreset?: (preset: (typeof PROVIDER_PRESETS)[number]) => void
  readonly error?: string | null
}

/** AI 服务配置表单:已配置 → 快速填充 → 连接 → 模型 → 保存。只被设置弹窗使用。 */
export function AiProviderForm({
  providers,
  configForm,
  onFormChange,
  onSave,
  onRemove,
  onApplyPreset,
  error,
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

  return (
    <div className="ai-provider-module">
      {providers.length > 0 && (
        <section className="ai-section">
          <p className="ai-section-title">已配置 · {providers.length}</p>
          <div className="ai-provider-list">
            {providers.map((provider) => (
              <div key={provider.id} className="ai-provider-card">
                <span className="ai-provider-info">
                  <strong>{provider.name}</strong>
                  <span>
                    {provider.model} · {provider.baseUrl}
                  </span>
                </span>
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
            ))}
          </div>
        </section>
      )}

      {onApplyPreset && (
        <section className="ai-section">
          <p className="ai-section-title">快速填充</p>
          <DropdownMenu
            value={selectedPreset}
            options={presetOptions}
            onChange={(label) => {
              const preset = PROVIDER_PRESETS.find((item) => item.label === label)
              if (preset !== undefined) onApplyPreset(preset)
            }}
            ariaLabel="快速填充服务商"
            title="选一个服务商,自动填入 Base URL 与默认模型;之后仍可修改"
          >
            <span className="dropdown-value">{selectedPreset || '选择服务商…'}</span>
          </DropdownMenu>
        </section>
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
              placeholder="存入系统钥匙串"
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
              Embedding <em className="ai-field-hint">可选 · 建索引问答</em>
            </span>
            <input
              className="field-input"
              placeholder="留空则不可用"
              value={configForm.embeddingModel}
              onChange={(event) => set('embeddingModel', event.target.value)}
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
        </section>
      </div>

      <div className="ai-form-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void onSave()}
          disabled={configForm.baseUrl.trim().length === 0 || configForm.model.trim().length === 0}
        >
          保存配置
        </button>
        <p className="ai-privacy">
          密钥保存在本机钥匙串,不会进入页面或仓库;对话时仅发送勾选的正文片段。
        </p>
      </div>
      {error != null && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
