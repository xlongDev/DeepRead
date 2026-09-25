import { useCallback, useEffect, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { toAppError, type AiProviderConfig } from '@deepread/shared'
import { invokeCommand, isTauriRuntime } from '../../lib/ipc'

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

  const reload = useCallback((): Promise<void> => {
    if (!isTauriRuntime()) {
      setLoaded(true)
      return Promise.resolve()
    }
    return invokeCommand('ai.config.list', undefined)
      .then((response) => {
        setProviders(response?.providers ?? [])
        setActiveId((current) => current ?? response?.providers?.[0]?.id ?? null)
        setLoaded(true)
      })
      .catch(() => {
        // Config list is optional on first paint; the config form retries.
        setLoaded(true)
      })
  }, [])

  useEffect(() => {
    void reload()
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

/** AI 服务配置表单:预设、连接信息、密钥。主设置页与阅读器抽屉共用。 */
export function AiProviderForm({
  providers,
  configForm,
  onFormChange,
  onSave,
  onRemove,
  onApplyPreset,
  error,
}: AiProviderFormProps) {
  return (
    <div className="ai-provider-module">
      {providers.length > 0 && (
        <div className="ai-provider-list">
          {providers.map((provider) => (
            <div key={provider.id} className="settings-row dictionary-row">
              <span className="settings-label">
                {provider.name} · {provider.model}
              </span>
              <button
                type="button"
                className="chrome-button"
                onClick={() => void onRemove(provider.id)}
                title="移除"
              >
                <X size={12} weight="regular" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
      {onApplyPreset && (
        <div className="segmented ai-presets">
          {PROVIDER_PRESETS.map((preset) => (
            <button key={preset.label} type="button" onClick={() => onApplyPreset(preset)}>
              {preset.label}
            </button>
          ))}
        </div>
      )}
      <input
        className="field-input"
        placeholder="名称"
        value={configForm.name}
        onChange={(event) => onFormChange({ ...configForm, name: event.target.value })}
      />
      <input
        className="field-input"
        placeholder="Base URL(OpenAI 兼容,含 /v1)"
        value={configForm.baseUrl}
        onChange={(event) => onFormChange({ ...configForm, baseUrl: event.target.value })}
      />
      <input
        className="field-input"
        placeholder="对话模型,如 deepseek-v4-pro"
        value={configForm.model}
        onChange={(event) => onFormChange({ ...configForm, model: event.target.value })}
      />
      <input
        className="field-input"
        placeholder="Embedding 模型(可选,默认用对话模型)"
        value={configForm.embeddingModel}
        onChange={(event) => onFormChange({ ...configForm, embeddingModel: event.target.value })}
      />
      <input
        className="field-input"
        placeholder="TTS 模型(可选,用于云端朗读)"
        value={configForm.ttsModel}
        onChange={(event) => onFormChange({ ...configForm, ttsModel: event.target.value })}
      />
      <input
        className="field-input"
        type="password"
        placeholder="API Key(存入系统钥匙串)"
        value={configForm.apiKey}
        onChange={(event) => onFormChange({ ...configForm, apiKey: event.target.value })}
      />
      <button
        type="button"
        className="btn-primary"
        onClick={() => void onSave()}
        disabled={configForm.baseUrl.trim().length === 0 || configForm.model.trim().length === 0}
      >
        保存配置
      </button>
      {error !== null && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      <p className="ai-privacy">
        密钥保存在本机钥匙串,不会进入页面或仓库;对话时仅发送勾选的正文片段。
      </p>
    </div>
  )
}
