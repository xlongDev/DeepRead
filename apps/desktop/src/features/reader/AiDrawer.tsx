import { useCallback, useEffect, useRef, useState } from 'react'
import { PaperPlaneRight, Sparkle, X } from '@phosphor-icons/react'
import { toAppError, type AiIndexPayload, type AiProviderConfig } from '@deepread/shared'
import {
  buildChatBody,
  buildOutlineMessages,
  buildRagChunks,
  buildSummaryMessages,
  buildRagMessages,
  chatEndpoint,
  citationLabels,
  createSseParser,
  extractDelta,
  retrieve,
  type ChatMessage,
  type OutlineInsight,
  type RetrievedChunk,
  type SummaryInsight,
} from '@deepread/ai-core'
import {
  applyCorrections,
  buildCharactersMessages,
  buildRepairMessages,
  charactersSchema,
  outlineInsightSchema,
  parseCharacters,
  parseCorrections,
  parseOutlineInsight,
  parseSummaryInsight,
  summaryInsightSchema,
  type AiCorrection,
  type CharactersPayload,
} from '@deepread/ai-core'
import { invokeCommand, invokeStreamingCommand, isTauriRuntime } from '../../lib/ipc'
import { GraphView } from './GraphView'

interface AiDrawerProps {
  /** Current selection text (if any) is offered as quick context. */
  readonly selection: string | null
  /** Chapter/plain text snippet to give the assistant context. */
  readonly contextText: string | null
  /** Full-book sections for RAG indexing (label + text). */
  readonly sections: readonly { readonly label: string; readonly text: string }[]
  readonly bookHash: string
  readonly title: string
  /** Raw adapter-built source text (TXT/MD); null for kernel books. */
  readonly sourceText: string | null
  readonly onReplaceSource: (text: string) => Promise<void>
  readonly onClose: () => void
}

export type AiScope = 'selection' | 'chapter' | 'book'

type ChatUiMessage = ChatMessage & { readonly streaming?: boolean }

type StreamPhase = 'idle' | 'streaming' | 'error'

const PROVIDER_PRESETS: readonly {
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

export function AiDrawer({
  selection,
  contextText,
  sections,
  bookHash,
  title,
  sourceText,
  onReplaceSource,
  onClose,
}: AiDrawerProps) {
  const [providers, setProviders] = useState<readonly AiProviderConfig[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showConfig, setShowConfig] = useState(false)
  const [configForm, setConfigForm] = useState({
    name: '',
    baseUrl: '',
    model: '',
    embeddingModel: '',
    ttsModel: '',
    apiKey: '',
  })
  const [messages, setMessages] = useState<readonly ChatUiMessage[]>([])
  const [input, setInput] = useState('')
  const [phase, setPhase] = useState<StreamPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<AiScope>('chapter')
  const [indexStatus, setIndexStatus] = useState<'unknown' | 'missing' | 'ready' | 'building'>(
    'unknown',
  )
  const [citations, setCitations] = useState<ReadonlyMap<number, readonly string[]>>(new Map())
  const [summary, setSummary] = useState<SummaryInsight | null>(null)
  const [outline, setOutline] = useState<OutlineInsight | null>(null)
  const [insightPhase, setInsightPhase] = useState<'idle' | 'streaming'>('idle')
  const [characters, setCharacters] = useState<CharactersPayload | null>(null)
  const [graphOpen, setGraphOpen] = useState(false)
  const [aiCorrections, setAiCorrections] = useState<{
    proposals: readonly AiCorrection[]
    accepted: ReadonlySet<string>
  } | null>(null)
  // Browser (non-Tauri) sessions keep the index and insights in memory;
  // Tauri persists them per book hash via IPC (Rust, covered by its tests).
  const browserIndexRef = useRef<AiIndexPayload | null>(null)
  const browserArtifactsRef = useRef(
    new Map<string, { payload: Record<string, unknown>; createdAt: string }>(),
  )
  const taskIdRef = useRef<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    invokeCommand('ai.config.list', undefined)
      .then((response) => {
        if (cancelled) return
        setProviders(response.providers)
        setActiveId((current) => current ?? response.providers[0]?.id ?? null)
        if (response.providers.length === 0) setShowConfig(true)
      })
      .catch(() => {
        // Config list is optional on first paint; the config form retries.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const saveProvider = useCallback(async (): Promise<void> => {
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
      setShowConfig(false)
      setConfigForm({
        name: '',
        baseUrl: '',
        model: '',
        embeddingModel: '',
        ttsModel: '',
        apiKey: '',
      })
      setError(null)
    } catch (saveError) {
      setError(toAppError(saveError).message)
    }
  }, [activeId, configForm])

  const removeProvider = useCallback(async (id: string): Promise<void> => {
    try {
      await invokeCommand('ai.config.remove', { id })
      setProviders((current) => current.filter((provider) => provider.id !== id))
      setActiveId((current) => (current === id ? null : current))
    } catch (removeError) {
      setError(toAppError(removeError).message)
    }
  }, [])

  const buildIndex = useCallback(async (): Promise<void> => {
    if (sections.length === 0) return
    setIndexStatus('building')
    try {
      const chunks = buildRagChunks(sections)
      let vectors: readonly (readonly number[])[]
      if (isTauriRuntime() && activeId) {
        const response = await invokeCommand('ai.embed', {
          taskId: `task-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
          configId: activeId,
          texts: chunks.map((chunk) => chunk.text),
        })
        vectors = response.vectors
      } else {
        const response = await fetch('/mock-ai/v1/embeddings', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer sk-mock-test-key',
          },
          body: JSON.stringify({
            model: 'mock-embedding',
            input: chunks.map((chunk) => chunk.text),
          }),
        })
        if (!response.ok) throw new Error(`mock embeddings 错误(${response.status})`)
        const payload = (await response.json()) as { data: { embedding: number[] }[] }
        vectors = payload.data.map((item) => item.embedding)
      }
      const index: AiIndexPayload = {
        chunks: chunks.map((chunk, i) => ({
          label: chunk.label,
          text: chunk.text,
          vector: vectors[i] ?? [],
        })),
        embeddingModel:
          providers.find((provider) => provider.id === activeId)?.embeddingModel ??
          providers.find((provider) => provider.id === activeId)?.model ??
          'mock-model',
        createdAt: new Date().toISOString(),
      }
      if (isTauriRuntime()) {
        await invokeCommand('ai.index.set', { bookHash, index })
      } else {
        browserIndexRef.current = index
      }
      setIndexStatus('ready')
      setError(null)
    } catch (indexError) {
      setIndexStatus('missing')
      setError(toAppError(indexError).message)
    }
  }, [activeId, bookHash, providers, sections])

  // Load persisted insights once per drawer open.
  useEffect(() => {
    let cancelled = false
    for (const kind of ['summary', 'outline', 'characters'] as const) {
      const read = isTauriRuntime()
        ? invokeCommand('ai.artifact.get', { bookHash, kind }).then((response) =>
            response.payload === null
              ? null
              : { payload: response.payload, createdAt: response.createdAt ?? '' },
          )
        : Promise.resolve(browserArtifactsRef.current.get(`${bookHash}-${kind}`) ?? null)
      read
        .then((stored) => {
          if (cancelled || stored === null) return
          if (kind === 'summary') setSummary(summaryInsightSchema.parse(stored.payload))
          else if (kind === 'outline') setOutline(outlineInsightSchema.parse(stored.payload))
          else setCharacters(charactersSchema.parse(stored.payload))
        })
        .catch(() => {
          // Corrupted/stale artifacts are ignored; regeneration overwrites.
        })
    }
    return () => {
      cancelled = true
    }
  }, [bookHash])

  // Shared streaming helper: run messages through Tauri proxy or mock, return
  // the full model text.
  const streamChatText = useCallback(
    async (
      chatMessages: readonly {
        role: 'system' | 'user' | 'assistant'
        content: string
      }[],
    ): Promise<string> => {
      let full = ''
      const parser = createSseParser((data) => {
        const delta = extractDelta(data)
        if (delta.type === 'delta') full += delta.text
      })
      if (isTauriRuntime() && activeId) {
        const taskId = `task-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
        await invokeStreamingCommand(
          'ai.chat',
          { taskId, configId: activeId, messages: chatMessages },
          (event) => {
            if (event.type === 'chunk') parser.push(event.data)
          },
        )
      } else {
        const response = await fetch(chatEndpoint('/mock-ai/v1'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer sk-mock-test-key',
          },
          body: buildChatBody({ model: 'mock-model', messages: chatMessages }),
        })
        if (!response.ok || !response.body) {
          throw new Error(`mock 服务错误(${response.status})`)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          parser.push(decoder.decode(value, { stream: true }))
        }
      }
      parser.end()
      return full
    },
    [activeId],
  )

  // Generate a structured insight via the streaming chat path; validates the
  // assembled JSON with zod before persisting (spec §118).
  const generateInsight = useCallback(
    async (kind: 'summary' | 'outline'): Promise<void> => {
      if (insightPhase === 'streaming' || sections.length === 0) return
      const taskId = `task-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
      const insightMessages =
        kind === 'summary'
          ? buildSummaryMessages(sections, title)
          : buildOutlineMessages(sections, title)
      setInsightPhase('streaming')
      setError(null)
      let full = ''
      const parser = createSseParser((data) => {
        const delta = extractDelta(data)
        if (delta.type === 'delta') full += delta.text
      })
      try {
        if (isTauriRuntime() && activeId) {
          await invokeStreamingCommand(
            'ai.chat',
            { taskId, configId: activeId, messages: insightMessages },
            (event) => {
              if (event.type === 'chunk') parser.push(event.data)
            },
          )
        } else {
          const response = await fetch(chatEndpoint('/mock-ai/v1'), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer sk-mock-test-key',
            },
            body: buildChatBody({ model: 'mock-model', messages: insightMessages }),
          })
          if (!response.ok || !response.body) {
            throw new Error(`mock 服务错误(${response.status})`)
          }
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            parser.push(decoder.decode(value, { stream: true }))
          }
        }
        parser.end()
        const insight = kind === 'summary' ? parseSummaryInsight(full) : parseOutlineInsight(full)
        const payload = insight as unknown as Record<string, unknown>
        if (isTauriRuntime()) {
          await invokeCommand('ai.artifact.set', { bookHash, kind, payload })
        } else {
          browserArtifactsRef.current.set(`${bookHash}-${kind}`, {
            payload,
            createdAt: new Date().toISOString(),
          })
        }
        if (kind === 'summary') {
          setSummary(insight as SummaryInsight)
        } else {
          setOutline(insight as OutlineInsight)
        }
      } catch (insightError) {
        setError(
          insightError instanceof Error && insightError.message.includes('JSON')
            ? `AI 输出未通过校验,请重试。(${insightError.message})`
            : toAppError(insightError).message,
        )
      } finally {
        setInsightPhase('idle')
      }
    },
    [activeId, bookHash, insightPhase, sections, title],
  )

  const runAiRepair = useCallback(async (): Promise<void> => {
    if (sourceText === null || insightPhase === 'streaming') return
    setInsightPhase('streaming')
    setError(null)
    try {
      const full = await streamChatText(buildRepairMessages(sourceText.slice(0, 6000), title))
      const proposals = parseCorrections(full, sourceText)
      if (proposals.length === 0) {
        setError('AI 没有找到可确信的纠错点。')
        setAiCorrections(null)
        return
      }
      setAiCorrections({
        proposals,
        accepted: new Set(proposals.filter((p) => p.occurrences === 1).map((p) => p.id)),
      })
    } catch (repairError) {
      setError(toAppError(repairError).message)
    } finally {
      setInsightPhase('idle')
    }
  }, [insightPhase, sourceText, streamChatText, title])

  const toggleAiCorrection = (id: string): void => {
    setAiCorrections((current) => {
      if (!current) return current
      const accepted = new Set(current.accepted)
      if (accepted.has(id)) accepted.delete(id)
      else accepted.add(id)
      return { ...current, accepted }
    })
  }

  const applyAiCorrectionsAccepted = async (): Promise<void> => {
    const review = aiCorrections
    if (!review || sourceText === null) return
    const result = applyCorrections(sourceText, review.proposals, [...review.accepted])
    await onReplaceSource(result.text)
    setAiCorrections(null)
    setError(
      result.skipped > 0
        ? `已应用 ${result.applied} 处,跳过 ${result.skipped} 处(命中不再唯一)。`
        : null,
    )
  }

  const generateCharacters = useCallback(async (): Promise<void> => {
    if (insightPhase === 'streaming' || sections.length === 0) return
    setInsightPhase('streaming')
    setError(null)
    try {
      const full = await streamChatText(buildCharactersMessages(sections, title))
      const payload = parseCharacters(full)
      const artifactPayload = payload as unknown as Record<string, unknown>
      if (isTauriRuntime()) {
        await invokeCommand('ai.artifact.set', {
          bookHash,
          kind: 'characters',
          payload: artifactPayload,
        })
      } else {
        browserArtifactsRef.current.set(`${bookHash}-characters`, {
          payload: artifactPayload,
          createdAt: new Date().toISOString(),
        })
      }
      setCharacters(payload)
    } catch (charactersError) {
      setError(toAppError(charactersError).message)
    } finally {
      setInsightPhase('idle')
    }
  }, [bookHash, insightPhase, sections, streamChatText, title])

  const send = useCallback(async (): Promise<void> => {
    const question = input.trim()
    // Browser mode goes through the mock path and needs no configId.
    const browserMode = !isTauriRuntime() && window.location.search.includes('mockKey')
    const configId = activeId
    if (!question || phase === 'streaming' || (!browserMode && !configId)) return

    const taskId = `task-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
    taskIdRef.current = taskId

    // System context per scope (spec §34): selection / current chapter / RAG.
    let outbound: readonly ChatMessage[]
    if (scope === 'book') {
      const index = isTauriRuntime()
        ? (await invokeCommand('ai.index.get', { bookHash })).index
        : browserIndexRef.current
      if (!index || index.chunks.length === 0) {
        setError('全书模式需要先建立索引。')
        return
      }
      // Query embedding: mock path embeds client-side; Tauri uses ai.embed.
      let queryVector: readonly number[]
      if (isTauriRuntime() && activeId) {
        const embedResponse = await invokeCommand('ai.embed', {
          taskId: `task-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
          configId: activeId,
          texts: [question],
        })
        queryVector = embedResponse.vectors[0] ?? []
      } else {
        const embedFetch = await fetch('/mock-ai/v1/embeddings', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer sk-mock-test-key',
          },
          body: JSON.stringify({ model: 'mock-embedding', input: [question] }),
        })
        const payload = (await embedFetch.json()) as { data: { embedding: number[] }[] }
        queryVector = payload.data[0]?.embedding ?? []
      }
      const retrieved: readonly RetrievedChunk[] = retrieve(index.chunks, queryVector)
      setCitations(new Map([[messages.length + 1, citationLabels(retrieved)]]))
      outbound = buildRagMessages(question, retrieved, messages)
    } else {
      const scoped = scope === 'selection' ? selection : contextText
      const systemContext = scoped?.trim() ? scoped.slice(0, 2000) : null
      outbound = [
        ...(systemContext
          ? [
              {
                role: 'system' as const,
                content: `以下是用户正在阅读的内容片段:\n${systemContext}`,
              },
            ]
          : []),
        ...messages
          .filter((message) => message.role !== 'system')
          .map(({ role, content }) => ({ role, content })),
        { role: 'user' as const, content: question },
      ]
    }

    setMessages((current) => [
      ...current,
      { role: 'user', content: question },
      { role: 'assistant', content: '', streaming: true },
    ])
    setInput('')
    setPhase('streaming')
    setError(null)
    requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ block: 'end' }))

    const parser = createSseParser((data) => {
      const delta = extractDelta(data)
      if (delta.type === 'delta') {
        setMessages((current) => {
          const last = current[current.length - 1]
          if (!last || last.role !== 'assistant') return current
          return [
            ...current.slice(0, -1),
            { role: 'assistant', content: last.content + delta.text, streaming: true },
          ]
        })
      }
    })
    // Browser (non-Tauri) dev path: talk straight to a local mock server so
    // the full stream pipeline is exercisable without the Rust proxy. The key
    // comes from ?mockKey= and is never persisted.
    if (!isTauriRuntime()) {
      const params = new URLSearchParams(window.location.search)
      const mockKey = params.get('mockKey')
      const mockBase: string = '/mock-ai/v1'
      if (!mockKey) {
        setPhase('error')
        setError('浏览器模式请加 ?mockKey=sk-mock-test-key 以启用 mock 服务。')
        return
      }
      const response = await fetch(chatEndpoint(mockBase), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${mockKey}`,
        },
        body: buildChatBody({ model: 'mock-model', messages: outbound }),
      })
      if (!response.ok || !response.body) {
        setPhase('error')
        setError(`mock 服务错误(${response.status})`)
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parser.push(decoder.decode(value, { stream: true }))
      }
      parser.end()
      setPhase('idle')
      setMessages((current) => {
        const last = current[current.length - 1]
        if (!last || last.role !== 'assistant') return current
        return [...current.slice(0, -1), { role: 'assistant', content: last.content }]
      })
      return
    }

    try {
      await invokeStreamingCommand(
        'ai.chat',
        { taskId, configId: configId ?? '', messages: outbound },
        (event) => {
          if (event.type === 'done' || event.type === 'cancelled') {
            setPhase('idle')
            setMessages((current) => {
              const last = current[current.length - 1]
              if (!last || last.role !== 'assistant') return current
              return [...current.slice(0, -1), { role: 'assistant', content: last.content }]
            })
            taskIdRef.current = null
          } else if (event.type === 'error') {
            setPhase('error')
            setError(`${event.data.code}:${event.data.message}`)
            taskIdRef.current = null
          } else {
            parser.push(event.data)
          }
        },
      )
      // The channel keeps emitting after the invoke resolves; the parser is
      // closed by 'done'/error events above.
    } catch (chatError) {
      setPhase('error')
      setError(toAppError(chatError).message)
      taskIdRef.current = null
    }
  }, [activeId, bookHash, contextText, input, messages, phase, scope, selection])

  const cancel = useCallback(async (): Promise<void> => {
    const taskId = taskIdRef.current
    if (!taskId) return
    try {
      await invokeCommand('ai.cancel', { taskId })
    } catch {
      // Cancel is best-effort; the stream ends either way.
    }
  }, [])

  const applyPreset = (preset: (typeof PROVIDER_PRESETS)[number]): void => {
    setConfigForm((form) => ({
      ...form,
      name: preset.label,
      baseUrl: preset.baseUrl,
      model: preset.model,
    }))
  }

  return (
    <aside className="ai-drawer" aria-label="AI 助手">
      <div className="lookup-head">
        <strong>
          <Sparkle size={14} weight="fill" aria-hidden /> AI 助手
        </strong>
        <div className="ai-head-actions">
          <select
            className="ai-provider-select"
            value={activeId ?? ''}
            onChange={(event) => setActiveId(event.target.value || null)}
            aria-label="选择 AI 服务"
          >
            {providers.length === 0 && <option value="">未配置</option>}
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} · {provider.model}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="chrome-button"
            onClick={() => setShowConfig((open) => !open)}
            title={showConfig ? '收起配置' : '服务配置'}
          >
            <Sparkle size={14} weight="regular" aria-hidden />
          </button>
          <button type="button" className="chrome-button" onClick={onClose} title="关闭">
            <X size={14} weight="regular" aria-hidden />
          </button>
        </div>
      </div>

      <div className="ai-drawer-body">
        {showConfig && (
          <section className="ai-config" aria-label="服务配置">
            {providers.map((provider) => (
              <div key={provider.id} className="settings-row dictionary-row">
                <span className="settings-label">
                  {provider.name} · {provider.model}
                </span>
                <button
                  type="button"
                  className="chrome-button"
                  onClick={() => void removeProvider(provider.id)}
                  title="移除"
                >
                  <X size={12} weight="regular" aria-hidden />
                </button>
              </div>
            ))}
            <div className="segmented ai-presets">
              {PROVIDER_PRESETS.map((preset) => (
                <button key={preset.label} type="button" onClick={() => applyPreset(preset)}>
                  {preset.label}
                </button>
              ))}
            </div>
            <input
              className="ai-input"
              placeholder="名称"
              value={configForm.name}
              onChange={(event) => setConfigForm((form) => ({ ...form, name: event.target.value }))}
            />
            <input
              className="ai-input"
              placeholder="Base URL(OpenAI 兼容,含 /v1)"
              value={configForm.baseUrl}
              onChange={(event) =>
                setConfigForm((form) => ({ ...form, baseUrl: event.target.value }))
              }
            />
            <input
              className="ai-input"
              placeholder="对话模型,如 deepseek-v4-pro"
              value={configForm.model}
              onChange={(event) =>
                setConfigForm((form) => ({ ...form, model: event.target.value }))
              }
            />
            <input
              className="ai-input"
              placeholder="Embedding 模型(可选,默认用对话模型)"
              value={configForm.embeddingModel}
              onChange={(event) =>
                setConfigForm((form) => ({ ...form, embeddingModel: event.target.value }))
              }
            />
            <input
              className="ai-input"
              placeholder="TTS 模型(可选,用于云端朗读)"
              value={configForm.ttsModel}
              onChange={(event) =>
                setConfigForm((form) => ({ ...form, ttsModel: event.target.value }))
              }
            />
            <input
              className="ai-input"
              type="password"
              placeholder="API Key(存入系统钥匙串)"
              value={configForm.apiKey}
              onChange={(event) =>
                setConfigForm((form) => ({ ...form, apiKey: event.target.value }))
              }
            />
            <button
              type="button"
              className="reader-error-button"
              onClick={() => void saveProvider()}
              disabled={
                configForm.baseUrl.trim().length === 0 || configForm.model.trim().length === 0
              }
            >
              保存配置
            </button>
            <p className="ai-privacy">
              密钥保存在本机钥匙串,不会进入页面或仓库;对话时仅发送下方勾选的正文片段。
            </p>
          </section>
        )}

        <div className="segmented ai-scope">
          <button
            type="button"
            className={scope === 'selection' ? 'is-active' : ''}
            onClick={() => setScope('selection')}
            disabled={!selection}
            title={selection ? '把选中文本作为上下文' : '先在正文中选一段文字'}
          >
            选中文本
          </button>
          <button
            type="button"
            className={scope === 'chapter' ? 'is-active' : ''}
            onClick={() => setScope('chapter')}
          >
            当前章节
          </button>
          <button
            type="button"
            className={scope === 'book' ? 'is-active' : ''}
            onClick={() => setScope('book')}
          >
            全书 RAG
          </button>
        </div>

        {scope === 'book' && (
          <div className="settings-row">
            <span className="settings-label">
              {indexStatus === 'ready'
                ? '索引已就绪'
                : indexStatus === 'building'
                  ? '正在建立索引…'
                  : indexStatus === 'missing'
                    ? '尚无索引'
                    : '索引状态未知'}
            </span>
            <div className="segmented">
              <button
                type="button"
                onClick={() => void buildIndex()}
                disabled={indexStatus === 'building'}
              >
                {indexStatus === 'building' ? '建立中' : '建立索引'}
              </button>
            </div>
          </div>
        )}

        <section className="ai-insights" aria-label="本书洞察">
          <div className="settings-row">
            <span className="settings-label">本书洞察(基于章节开头)</span>
            <div className="segmented">
              <button
                type="button"
                onClick={() => void generateInsight('summary')}
                disabled={insightPhase === 'streaming'}
              >
                {insightPhase === 'streaming' && summary === null
                  ? '生成中…'
                  : summary === null
                    ? '生成摘要'
                    : '重新生成摘要'}
              </button>
              <button
                type="button"
                onClick={() => void generateInsight('outline')}
                disabled={insightPhase === 'streaming'}
              >
                {insightPhase === 'streaming' && outline === null
                  ? '生成中…'
                  : outline === null
                    ? '生成大纲'
                    : '重新生成大纲'}
              </button>
            </div>
          </div>
          {summary !== null && (
            <div className="ai-insight">
              <p className="ai-insight-overview">{summary.overview}</p>
              <div className="ai-citations">
                {summary.themes.map((theme) => (
                  <span key={theme} className="ai-citation">
                    {theme}
                  </span>
                ))}
              </div>
              <p className="ai-privacy">{summary.coverage}</p>
            </div>
          )}
          {characters !== null && (
            <div className="ai-insight">
              {characters.characters.map((character) => (
                <p key={character.name} className="ai-insight-outline">
                  <strong>{character.name}</strong>
                  <span className="ai-citation">{character.role}</span> {character.description}
                </p>
              ))}
            </div>
          )}
          <div className="segmented">
            <button
              type="button"
              onClick={() => void generateCharacters()}
              disabled={insightPhase === 'streaming'}
            >
              {characters === null ? '抽取角色' : '重新抽取角色'}
            </button>
          </div>
          {sourceText !== null && (
            <div className="settings-row">
              <span className="settings-label">AI 纠错</span>
              <div className="segmented">
                <button
                  type="button"
                  onClick={() => void runAiRepair()}
                  disabled={insightPhase === 'streaming'}
                >
                  {insightPhase === 'streaming' ? '检查中…' : 'AI 检查'}
                </button>
              </div>
            </div>
          )}
          {aiCorrections !== null && (
            <div className="ai-insight">
              {aiCorrections.proposals.map((proposal) => (
                <label
                  key={proposal.id}
                  className="repair-item"
                  aria-label={`应用纠错:${proposal.reason}`}
                >
                  <input
                    type="checkbox"
                    checked={aiCorrections.accepted.has(proposal.id)}
                    onChange={() => toggleAiCorrection(proposal.id)}
                  />
                  <span className="repair-body">
                    <span className="repair-rule">{proposal.reason}</span>
                    <s className="repair-before">{proposal.find}</s>
                    <span className="repair-after">{proposal.replace}</span>
                  </span>
                </label>
              ))}
              <button
                type="button"
                className="reader-error-button"
                onClick={() => void applyAiCorrectionsAccepted()}
              >
                应用已选({aiCorrections.accepted.size}/{aiCorrections.proposals.length})
              </button>
            </div>
          )}
        </section>

        <div className="ai-messages">
          {messages.length === 0 && (
            <p className="lookup-empty">
              {selection
                ? `已带入选中文本(${selection.length} 字)。问点什么,比如“解释这段”。`
                : '向 AI 提问关于当前书籍的问题。可在目录抽屉选中文字后回来提问。'}
            </p>
          )}
          {messages.map((message, index) => (
            <div key={index} className={`ai-msg-wrap ai-msg-wrap-${message.role}`}>
              <div className={`ai-msg ai-msg-${message.role}`}>
                {message.content || (message.streaming ? '…' : '')}
              </div>
              {message.role === 'assistant' && citations.get(index) !== undefined && (
                <div className="ai-citations">
                  {citations.get(index)?.map((label) => (
                    <span key={label} className="ai-citation">
                      {label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {error !== null && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}

        {characters !== null && characters.characters.length > 0 && (
          <div className="segmented">
            <button type="button" onClick={() => setGraphOpen(true)}>
              查看关系图
            </button>
          </div>
        )}
      </div>

      <div className="ai-input-row">
        <input
          className="ai-input"
          placeholder="输入问题,回车发送"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {phase === 'streaming' ? (
          <button
            type="button"
            className="chrome-button"
            onClick={() => void cancel()}
            title="停止"
          >
            <X size={16} weight="regular" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className="chrome-button"
            onClick={() => void send()}
            disabled={
              (!activeId && !new URLSearchParams(window.location.search).has('mockKey')) ||
              input.trim().length === 0
            }
            title="发送"
          >
            <PaperPlaneRight size={16} weight="regular" aria-hidden />
          </button>
        )}
      </div>
      {graphOpen && characters !== null && (
        <GraphView payload={characters} onClose={() => setGraphOpen(false)} />
      )}
    </aside>
  )
}
