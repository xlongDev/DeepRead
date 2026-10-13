import { useCallback, useEffect, useRef, useState } from 'react'
import { PaperPlaneRight, Sparkle, X } from '@phosphor-icons/react'
import { toAppError, type AiIndexPayload } from '@deepread/shared'
import {
  buildChatBody,
  buildConceptsMessages,
  buildOutlineMessages,
  buildRagChunks,
  buildSummaryMessages,
  buildTimelineMessages,
  buildRagMessages,
  chatEndpoint,
  citationLabels,
  conceptsSchema,
  createSseParser,
  extractDelta,
  INSIGHT_EXCERPT_CHARS,
  INSIGHT_MAX_CHAPTERS,
  retrieve,
  timelineSchema,
  type ChatMessage,
  type ConceptsPayload,
  type GraphSpec,
  type OutlineInsight,
  type RetrievedChunk,
  type SummaryInsight,
  type TimelinePayload,
} from '@deepread/ai-core'
import {
  applyCorrections,
  applyConversions,
  buildCharactersMessages,
  buildConvertMessages,
  buildRepairMessages,
  charactersSchema,
  conversionRuleLabel,
  outlineInsightSchema,
  parseCharacters,
  parseConcepts,
  parseConversions,
  parseCorrections,
  parseOutlineInsight,
  parseSummaryInsight,
  parseTimeline,
  summaryInsightSchema,
  type AiCorrection,
  type CharactersPayload,
  type Conversion,
  type ConversionRule,
} from '@deepread/ai-core'
import { invokeCommand, invokeStreamingCommand, isTauriRuntime } from '../../lib/ipc'
import { useAiProviders } from '../settings/AiProviderSettings'
import { GraphView } from './GraphView'
import { DropdownMenu } from '../../components/DropdownMenu'

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
  const { providers, activeId, setActiveId } = useAiProviders()
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
  const [timeline, setTimeline] = useState<TimelinePayload | null>(null)
  const [concepts, setConcepts] = useState<ConceptsPayload | null>(null)
  /** 打开的图谱(null = 关着):三种洞察共用同一个视图。 */
  const [graphSpec, setGraphSpec] = useState<GraphSpec | null>(null)
  const [aiCorrections, setAiCorrections] = useState<{
    proposals: readonly AiCorrection[]
    accepted: ReadonlySet<string>
  } | null>(null)
  /** 繁简转换评审(与 AI 校对同一框架;providerLabel 供 UI 诚实标注)。 */
  const [conversions, setConversions] = useState<{
    proposals: readonly Conversion[]
    accepted: ReadonlySet<string>
    rule: ConversionRule
    providerLabel: string
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
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const buildIndex = useCallback(async (): Promise<void> => {
    if (sections.length === 0) return
    setIndexStatus('building')
    try {
      const chunks = buildRagChunks(sections)
      let vectors: number[][]
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
    const kinds = ['summary', 'outline', 'characters', 'timeline', 'concepts'] as const
    for (const kind of kinds) {
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
          else if (kind === 'characters') setCharacters(charactersSchema.parse(stored.payload))
          else if (kind === 'timeline') setTimeline(timelineSchema.parse(stored.payload))
          else setConcepts(conceptsSchema.parse(stored.payload))
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
          { taskId, configId: activeId, messages: [...chatMessages] },
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

  // Persist an insight artifact: Tauri stores per book hash (Rust, covered by
  // its tests); browser sessions keep it in memory for the drawer's lifetime.
  const persistArtifact = useCallback(
    async (kind: string, payload: Record<string, unknown>): Promise<void> => {
      if (isTauriRuntime()) {
        await invokeCommand('ai.artifact.set', { bookHash, kind, payload })
      } else {
        browserArtifactsRef.current.set(`${bookHash}-${kind}`, {
          payload,
          createdAt: new Date().toISOString(),
        })
      }
    },
    [bookHash],
  )

  // Generate a structured insight via the streaming chat path; validates the
  // assembled JSON with zod before persisting (spec §118).
  const generateInsight = useCallback(
    async (kind: 'summary' | 'outline' | 'timeline' | 'concepts'): Promise<void> => {
      if (insightPhase === 'streaming' || sections.length === 0) return
      const taskId = `task-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
      const insightMessages =
        kind === 'summary'
          ? buildSummaryMessages(sections, title)
          : kind === 'outline'
            ? buildOutlineMessages(sections, title)
            : kind === 'timeline'
              ? buildTimelineMessages(sections, title)
              : buildConceptsMessages(sections, title)
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
            { taskId, configId: activeId, messages: [...insightMessages] },
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
        if (kind === 'summary') {
          const insight = parseSummaryInsight(full)
          await persistArtifact(kind, insight as unknown as Record<string, unknown>)
          setSummary(insight)
        } else if (kind === 'outline') {
          const insight = parseOutlineInsight(full)
          await persistArtifact(kind, insight as unknown as Record<string, unknown>)
          setOutline(insight)
        } else if (kind === 'timeline') {
          const insight = parseTimeline(full)
          await persistArtifact(kind, insight as unknown as Record<string, unknown>)
          setTimeline(insight)
        } else {
          const insight = parseConcepts(full)
          await persistArtifact(kind, insight as unknown as Record<string, unknown>)
          setConcepts(insight)
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
    [activeId, insightPhase, persistArtifact, sections, title],
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

  /**
   * 繁简转换:当前 AI provider 出 find/replace 提案,逐条对照原文校验后交用户审批
   * (与 AI 校对同一"检测-应用分离"框架)。单次上限 100 条,长书可重复检查。
   */
  const runConvert = useCallback(
    async (rule: ConversionRule): Promise<void> => {
      if (sourceText === null || insightPhase === 'streaming') return
      setInsightPhase('streaming')
      setError(null)
      try {
        const full = await streamChatText(buildConvertMessages(sourceText.slice(0, 6000), rule))
        const proposals = parseConversions(full, sourceText, rule)
        if (proposals.length === 0) {
          setError('AI 在前 6000 字里没有找到需要转换的用字。')
          setConversions(null)
          return
        }
        const provider = providers.find((item) => item.id === activeId)
        setConversions({
          proposals,
          accepted: new Set(proposals.filter((p) => p.occurrences === 1).map((p) => p.id)),
          rule,
          providerLabel: provider ? `${provider.name} · ${provider.model}` : '未知服务',
        })
      } catch (convertError) {
        setError(toAppError(convertError).message)
      } finally {
        setInsightPhase('idle')
      }
    },
    [activeId, insightPhase, providers, sourceText, streamChatText],
  )

  const applyConversionsAccepted = async (): Promise<void> => {
    const review = conversions
    if (!review || sourceText === null) return
    const result = applyConversions(sourceText, review.proposals, [...review.accepted])
    await onReplaceSource(result.text)
    setConversions(null)
    setError(
      result.skipped > 0
        ? `已转换 ${result.applied} 处,跳过 ${result.skipped} 处(命中不再唯一)。`
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
      await persistArtifact('characters', payload as unknown as Record<string, unknown>)
      setCharacters(payload)
    } catch (charactersError) {
      setError(toAppError(charactersError).message)
    } finally {
      setInsightPhase('idle')
    }
  }, [insightPhase, persistArtifact, sections, streamChatText, title])

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
        { taskId, configId: configId ?? '', messages: [...outbound] },
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

  return (
    <aside className="ai-drawer" aria-label="AI 助手">
      <div className="lookup-head">
        <strong>
          <Sparkle size={14} weight="fill" aria-hidden /> AI 助手
        </strong>
        <div className="ai-head-actions">
          {providers.length > 0 && (
            <DropdownMenu
              className="dropdown-head"
              ariaLabel="选择 AI 服务"
              value={activeId ?? ''}
              options={providers.map((provider) => ({
                value: provider.id,
                label: provider.name,
                hint: provider.model,
              }))}
              onChange={(id) => setActiveId(id || null)}
            />
          )}
          <button type="button" className="chrome-button" onClick={onClose} title="关闭">
            <X size={14} weight="regular" aria-hidden />
          </button>
        </div>
      </div>

      <div className="ai-drawer-body">
        {providers.length === 0 && (
          <div className="ai-setup-hint">
            <p className="ai-privacy">
              还没有可用的 AI 服务。请返回书架,在「设置 → AI 服务」里添加(支持 DeepSeek、Kimi、智谱
              等任何 OpenAI 兼容服务,密钥只存本机钥匙串)。
            </p>
          </div>
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
              <button
                type="button"
                onClick={() => void generateInsight('timeline')}
                disabled={insightPhase === 'streaming'}
              >
                {insightPhase === 'streaming' && timeline === null
                  ? '生成中…'
                  : timeline === null
                    ? '抽取时间线'
                    : '重新抽取时间线'}
              </button>
              <button
                type="button"
                onClick={() => void generateInsight('concepts')}
                disabled={insightPhase === 'streaming'}
              >
                {insightPhase === 'streaming' && concepts === null
                  ? '生成中…'
                  : concepts === null
                    ? '抽取概念'
                    : '重新抽取概念'}
              </button>
            </div>
          </div>
          {/* 生成前就说清发送范围:模型只看得到前 N 章开头,不是全书。 */}
          <p className="ai-privacy">
            发送范围:前 {Math.min(sections.length, INSIGHT_MAX_CHAPTERS)} 章开头(每章最多{' '}
            {INSIGHT_EXCERPT_CHARS} 字),并非全书内容。
          </p>
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
          {outline !== null && (
            <div className="ai-insight">
              {outline.chapters.map((chapter) => (
                <p key={chapter.title} className="ai-insight-outline">
                  <strong>{chapter.title}</strong> {chapter.gist}
                </p>
              ))}
            </div>
          )}
          {timeline !== null && (
            <div className="ai-insight">
              {timeline.events.map((event) => (
                <p key={`${event.chapterRef}-${event.event}`} className="ai-insight-outline">
                  <span className="ai-citation">{event.chapterRef}</span>{' '}
                  <strong>{event.event}</strong>
                  {event.descriptions.length > 0 && ` — ${event.descriptions.join(';')}`}
                </p>
              ))}
            </div>
          )}
          {concepts !== null && (
            <div className="ai-insight">
              {concepts.concepts.map((concept) => (
                <p key={concept.name} className="ai-insight-outline">
                  <strong>{concept.name}</strong>
                  <span className="ai-citation">概念</span> {concept.explanation}
                </p>
              ))}
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
          {sourceText !== null && (
            <div className="settings-row">
              <span className="settings-label">繁简转换</span>
              <div className="segmented">
                <button
                  type="button"
                  onClick={() => void runConvert('t2s')}
                  disabled={insightPhase === 'streaming'}
                >
                  繁→简
                </button>
                <button
                  type="button"
                  onClick={() => void runConvert('s2t')}
                  disabled={insightPhase === 'streaming'}
                >
                  简→繁
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
          {conversions !== null && (
            <div className="ai-insight">
              <p className="lookup-empty">
                由当前 AI 提供商({conversions.providerLabel})生成
                {conversionRuleLabel(conversions.rule)}提案,已逐条对照原文校验,仅应用勾选项。
                单次上限 100 条,未覆盖的部分可再检查一次。
              </p>
              {conversions.proposals.map((proposal) => (
                <label
                  key={proposal.id}
                  className="repair-item"
                  aria-label={`应用${conversionRuleLabel(proposal.rule)}转换`}
                >
                  <input
                    type="checkbox"
                    checked={conversions.accepted.has(proposal.id)}
                    onChange={() =>
                      setConversions((current) => {
                        if (!current) return current
                        const accepted = new Set(current.accepted)
                        if (accepted.has(proposal.id)) accepted.delete(proposal.id)
                        else accepted.add(proposal.id)
                        return { ...current, accepted }
                      })
                    }
                  />
                  <span className="repair-body">
                    <span className="repair-rule">
                      {conversionRuleLabel(proposal.rule)}
                      {proposal.occurrences > 1 && ` · 命中 ${proposal.occurrences} 处`}
                    </span>
                    <s className="repair-before">{proposal.find}</s>
                    <span className="repair-after">{proposal.replace}</span>
                  </span>
                </label>
              ))}
              <button
                type="button"
                className="reader-error-button"
                onClick={() => void applyConversionsAccepted()}
              >
                应用已选({conversions.accepted.size}/{conversions.proposals.length})
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

        {/* 三种图谱共用一个视图,按已生成的洞察给出入口。 */}
        <div className="segmented">
          {characters !== null && characters.characters.length > 0 && (
            <button
              type="button"
              onClick={() => setGraphSpec({ kind: 'characters', payload: characters })}
            >
              角色关系图
            </button>
          )}
          {timeline !== null && timeline.events.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setGraphSpec({
                  kind: 'timeline',
                  payload: timeline,
                  chapterLabels: sections.map((section) => section.label),
                })
              }
            >
              事件时间线
            </button>
          )}
          {concepts !== null && concepts.concepts.length > 0 && (
            <button
              type="button"
              onClick={() => setGraphSpec({ kind: 'concepts', payload: concepts })}
            >
              概念关系图
            </button>
          )}
        </div>
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
      {graphSpec !== null && <GraphView spec={graphSpec} onClose={() => setGraphSpec(null)} />}
    </aside>
  )
}
