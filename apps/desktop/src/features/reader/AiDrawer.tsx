import { useCallback, useEffect, useRef, useState } from 'react'
import { CaretDown, Check, Note, PaperPlaneRight, Sparkle, X } from '@phosphor-icons/react'
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
  retrieveByTerms,
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
import { newTaskId } from '../../lib/ai-chat'
import { useAiProviders } from '../settings/AiProviderSettings'
import { GraphView } from './GraphView'
import { DropdownMenu } from '../../components/DropdownMenu'

/* ---------- 浏览器 dev 的 mock 通道 ----------
   浏览器模式没有 Rust 代理,直连本地 mock 服务跑通完整流式管线。此前
   embeddings 与 chat 的 fetch+读流样板在本文件里各复制了两三份,收拢到这。 */

/** mock embeddings:文本 → 向量。 */
async function mockEmbed(texts: readonly string[]): Promise<readonly number[][]> {
  const response = await fetch('/mock-ai/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-mock-test-key' },
    body: JSON.stringify({ model: 'mock-embedding', input: [...texts] }),
  })
  if (!response.ok) throw new Error(`mock embeddings 错误(${response.status})`)
  const payload = (await response.json()) as { data: { embedding: number[] }[] }
  return payload.data.map((item) => item.embedding)
}

/** mock 流式对话:delta 逐段交给 onDelta,返回完整文本。key 取 ?mockKey=。 */
async function streamMockChat(
  messages: readonly ChatMessage[],
  onDelta: (text: string) => void,
): Promise<string> {
  const mockKey = new URLSearchParams(window.location.search).get('mockKey') ?? 'sk-mock-test-key'
  const response = await fetch(chatEndpoint('/mock-ai/v1'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mockKey}` },
    body: buildChatBody({ model: 'mock-model', messages: [...messages] }),
  })
  if (!response.ok || !response.body) throw new Error(`mock 服务错误(${response.status})`)
  let full = ''
  const parser = createSseParser((data) => {
    const delta = extractDelta(data)
    if (delta.type === 'delta') {
      full += delta.text
      onDelta(delta.text)
    }
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parser.push(decoder.decode(value, { stream: true }))
  }
  parser.end()
  return full
}

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
  /** 阅读主题变量:转发给下拉菜单(portal 到 body 后要随身带,否则在羊皮等
     浅色背景下菜单会回落全局暗色,像一块深色补丁)。 */
  readonly themeVars?: React.CSSProperties
  readonly onReplaceSource: (text: string) => Promise<void>
  /** 引用 chip 点击跳转:ReaderScreen 按 label 回目录解析跳章。缺省时 chip 只展示。 */
  readonly onJumpToCitation?: (label: string) => void
  /** 把选区问答的回答写进批注笔记(已有划线追加,没有则落新划线)。 */
  readonly onSaveAnswerToNote?: (text: string) => Promise<void>
  readonly onClose: () => void
}

export type AiScope = 'selection' | 'chapter' | 'book'

type ChatUiMessage = ChatMessage & { readonly streaming?: boolean }

type StreamPhase = 'idle' | 'streaming' | 'error'

/** 洞察芯片:名词做标签,点一次生成、再点一次重生成(有结果时打勾)。 */
const INSIGHT_CHIPS = [
  { kind: 'summary', label: '摘要', hint: '基于章节开头生成内容摘要' },
  { kind: 'outline', label: '大纲', hint: '按章节提炼结构大纲' },
  { kind: 'timeline', label: '时间线', hint: '抽取事件与它们的章节出处' },
  { kind: 'concepts', label: '概念', hint: '抽取核心概念并解释' },
  { kind: 'characters', label: '角色', hint: '抽取人物及其关系' },
] as const

export function AiDrawer({
  selection,
  contextText,
  sections,
  bookHash,
  title,
  sourceText,
  themeVars,
  onReplaceSource,
  onJumpToCitation,
  onSaveAnswerToNote,
  onClose,
}: AiDrawerProps) {
  const { providers, activeId, setActiveId } = useAiProviders()
  const [messages, setMessages] = useState<readonly ChatUiMessage[]>([])
  const [input, setInput] = useState('')
  const [phase, setPhase] = useState<StreamPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<AiScope>('chapter')
  /** 本书洞察工具栏展开/收起;默认展开 —— 空面板里它是唯一的入口。 */
  const [insightsOpen, setInsightsOpen] = useState(true)
  const [indexStatus, setIndexStatus] = useState<'unknown' | 'missing' | 'ready' | 'building'>(
    'unknown',
  )
  const [citations, setCitations] = useState<ReadonlyMap<number, readonly string[]>>(new Map())
  /** 已写入批注笔记的回答序号:写入后按钮转「已写入」,防重复落笔。 */
  const [savedNotes, setSavedNotes] = useState<ReadonlySet<number>>(() => new Set())
  const [summary, setSummary] = useState<SummaryInsight | null>(null)
  const [outline, setOutline] = useState<OutlineInsight | null>(null)
  const [insightPhase, setInsightPhase] = useState<'idle' | 'streaming'>('idle')
  /** 正在跑的那一项洞察(摘要/大纲/…):芯片只让这一颗显示「生成中」。 */
  const [busyKind, setBusyKind] = useState<string | null>(null)
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
      let vectors: readonly number[][]
      if (isTauriRuntime() && activeId) {
        const response = await invokeCommand('ai.embed', {
          taskId: newTaskId(),
          configId: activeId,
          texts: chunks.map((chunk) => chunk.text),
        })
        vectors = response.vectors
      } else {
        vectors = await mockEmbed(chunks.map((chunk) => chunk.text))
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

  // 聊天历史:开抽屉时恢复上次的会话(仅 user/assistant 两种角色)。
  useEffect(() => {
    let cancelled = false
    const read = isTauriRuntime()
      ? invokeCommand('ai.artifact.get', { bookHash, kind: 'chat' }).then(
          (response) => response.payload,
        )
      : Promise.resolve(browserArtifactsRef.current.get(`${bookHash}-chat`)?.payload ?? null)
    read
      .then((payload) => {
        if (cancelled || payload === null || typeof payload !== 'object') return
        const list = (payload as { messages?: unknown }).messages
        if (!Array.isArray(list)) return
        const restored: ChatUiMessage[] = []
        for (const item of list) {
          const role = (item as { role?: unknown }).role
          const content = (item as { content?: unknown }).content
          if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue
          if (content.trim() === '') continue
          restored.push({ role, content })
        }
        if (restored.length > 0) setMessages(restored.slice(-60))
      })
      .catch(() => {
        // 历史读不到就从空白开始,不是错误。
      })
    return () => {
      cancelled = true
    }
  }, [bookHash])

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
      if (!isTauriRuntime() || !activeId) {
        return streamMockChat(chatMessages, () => {})
      }
      let full = ''
      const parser = createSseParser((data) => {
        const delta = extractDelta(data)
        if (delta.type === 'delta') full += delta.text
      })
      await invokeStreamingCommand(
        'ai.chat',
        { taskId: newTaskId(), configId: activeId, messages: [...chatMessages] },
        (event) => {
          if (event.type === 'chunk') parser.push(event.data)
        },
      )
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

  /** 一轮问答完成就把整份聊天记录重写进 kind=chat 的 artifact。
   *  上限 60 条(30 轮),更老的丢弃 —— 聊天是会话不是档案。 */
  const persistChat = useCallback(
    (chat: readonly ChatUiMessage[]): void => {
      const transcript = chat
        .filter((message) => message.role !== 'system' && message.content.trim() !== '')
        .slice(-60)
        .map(({ role, content }) => ({ role, content }))
      if (transcript.length === 0) return
      void persistArtifact('chat', {
        messages: transcript,
      } as unknown as Record<string, unknown>).catch(() => {
        // 历史写不进不拦着聊:下一轮成功时整份重写会补上。
      })
    },
    [persistArtifact],
  )

  // phase 离开 streaming 的那一刻,当前 messages 就是完成的会话快照。
  const prevPhaseRef = useRef<StreamPhase>('idle')
  useEffect(() => {
    if (prevPhaseRef.current === 'streaming' && phase !== 'streaming') persistChat(messages)
    prevPhaseRef.current = phase
  }, [phase, messages, persistChat])

  // Generate a structured insight via the streaming chat path; validates the
  // assembled JSON with zod before persisting (spec §118).
  const generateInsight = useCallback(
    async (kind: 'summary' | 'outline' | 'timeline' | 'concepts'): Promise<void> => {
      if (insightPhase === 'streaming' || sections.length === 0) return
      const insightMessages =
        kind === 'summary'
          ? buildSummaryMessages(sections, title)
          : kind === 'outline'
            ? buildOutlineMessages(sections, title)
            : kind === 'timeline'
              ? buildTimelineMessages(sections, title)
              : buildConceptsMessages(sections, title)
      setInsightPhase('streaming')
      setBusyKind(kind)
      setError(null)
      try {
        const full = await streamChatText(insightMessages)
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
        setBusyKind(null)
      }
    },
    [insightPhase, persistArtifact, sections, streamChatText, title],
  )

  const runAiRepair = useCallback(async (): Promise<void> => {
    if (sourceText === null || insightPhase === 'streaming') return
    setInsightPhase('streaming')
    setBusyKind('repair')
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
      setBusyKind(null)
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
      setBusyKind(rule)
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
        setBusyKind(null)
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
    setBusyKind('characters')
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
      setBusyKind(null)
    }
  }, [insightPhase, persistArtifact, sections, streamChatText, title])

  const send = useCallback(async (): Promise<void> => {
    const question = input.trim()
    // Browser mode goes through the mock path and needs no configId.
    const browserMode = !isTauriRuntime() && window.location.search.includes('mockKey')
    const configId = activeId
    if (!question || phase === 'streaming' || (!browserMode && !configId)) return

    const taskId = newTaskId()
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
      // 断网/欠费/没配 embedding 服务时抛错 → 关键词兜底,已建索引的书仍可问。
      let retrieved: readonly RetrievedChunk[]
      try {
        let queryVector: readonly number[]
        if (isTauriRuntime() && activeId) {
          const embedResponse = await invokeCommand('ai.embed', {
            taskId: newTaskId(),
            configId: activeId,
            texts: [question],
          })
          queryVector = embedResponse.vectors[0] ?? []
        } else {
          queryVector = (await mockEmbed([question]))[0] ?? []
        }
        retrieved = retrieve(index.chunks, queryVector)
      } catch {
        retrieved = retrieveByTerms(index.chunks, question)
      }
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

    const pushDelta = (text: string): void => {
      setMessages((current) => {
        const last = current[current.length - 1]
        if (!last || last.role !== 'assistant') return current
        return [
          ...current.slice(0, -1),
          { role: 'assistant', content: last.content + text, streaming: true },
        ]
      })
    }
    const markDone = (): void => {
      setPhase('idle')
      setMessages((current) => {
        const last = current[current.length - 1]
        if (!last || last.role !== 'assistant') return current
        return [...current.slice(0, -1), { role: 'assistant', content: last.content }]
      })
      taskIdRef.current = null
    }
    // Browser (non-Tauri) dev path: talk straight to a local mock server so
    // the full stream pipeline is exercisable without the Rust proxy. The key
    // comes from ?mockKey= and is never persisted. Tauri goes through the
    // Rust proxy; both branches converge on pushDelta/markDone.
    try {
      if (!isTauriRuntime()) {
        await streamMockChat(outbound, pushDelta)
        markDone()
        return
      }
      const parser = createSseParser((data) => {
        const delta = extractDelta(data)
        if (delta.type === 'delta') pushDelta(delta.text)
      })
      await invokeStreamingCommand(
        'ai.chat',
        { taskId, configId: configId ?? '', messages: [...outbound] },
        (event) => {
          if (event.type === 'done' || event.type === 'cancelled') {
            markDone()
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

  const activeProvider = providers.find((provider) => provider.id === activeId)
  /** 已生成的洞察数量:折叠状态下也能看出「里面有几份东西」。 */
  const artifactCount = [summary, outline, timeline, concepts, characters].filter(
    (artifact) => artifact !== null,
  ).length

  return (
    <aside className="ai-drawer ai-chat" aria-label="AI 助手">
      <header className="ai-head">
        <span className="ai-head-icon" aria-hidden>
          <Sparkle size={13} weight="fill" />
        </span>
        <div className="ai-head-text">
          <strong>AI 助手</strong>
          {/* 成本诚实:当前用哪个服务、哪个模型,永远在标题下面一行。 */}
          <span className="ai-head-sub">
            {activeProvider === undefined
              ? '未配置服务 · 到「设置 → AI 服务」添加'
              : `${activeProvider.name} · ${activeProvider.model}`}
          </span>
        </div>
        <div className="ai-head-actions">
          {providers.length > 0 && (
            <DropdownMenu
              className="dropdown-head"
              ariaLabel="选择 AI 服务"
              themeVars={themeVars}
              value={activeId ?? ''}
              options={providers.map((provider) => ({
                value: provider.id,
                label: provider.name,
                hint: provider.model,
              }))}
              onChange={(id) => setActiveId(id || null)}
            />
          )}
          <button
            type="button"
            className="ai-icon-btn"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <X size={14} weight="regular" aria-hidden />
          </button>
        </div>
      </header>

      <div className="ai-drawer-body">
        {providers.length === 0 && (
          <p className="ai-setup-hint">
            配好任意 OpenAI 兼容服务(DeepSeek / Kimi / 智谱…)就能在这里问书、生成摘要与大纲。
            密钥只存本机钥匙串,不经过阅读器。配置入口:书架侧栏 →「设置 → AI 服务」。
          </p>
        )}

        <div className="ai-scope" aria-label="上下文范围">
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
          <div className="ai-index-row">
            <span>
              {indexStatus === 'ready'
                ? '索引已就绪'
                : indexStatus === 'building'
                  ? '正在建立索引…'
                  : indexStatus === 'missing'
                    ? '尚无索引 · 建好才能检索全书'
                    : '索引状态未知'}
            </span>
            <button
              type="button"
              className="ai-chip ai-chip-ghost"
              onClick={() => void buildIndex()}
              disabled={indexStatus === 'building'}
            >
              {indexStatus === 'building'
                ? '建立中…'
                : indexStatus === 'ready'
                  ? '重建索引'
                  : '建立索引'}
            </button>
          </div>
        )}

        {/* 本书洞察:五颗动作芯片折进一个可收起的块里 —— 聊天是主场,
            洞察是工具栏;展开时也只占两行,不给面板撑出横向滚动。 */}
        <button
          type="button"
          className="ai-insights-toggle"
          onClick={() => setInsightsOpen((open) => !open)}
          aria-expanded={insightsOpen}
        >
          <span className="ai-insights-title">本书洞察</span>
          {artifactCount > 0 && <span className="ai-badge">{artifactCount}</span>}
          <CaretDown
            size={12}
            weight="bold"
            className={`ai-chevron${insightsOpen ? ' is-open' : ''}`}
            aria-hidden
          />
        </button>

        {insightsOpen && (
          <section className="ai-tools" aria-label="本书洞察">
            <div className="ai-chip-grid">
              {INSIGHT_CHIPS.map((chip) => {
                const done =
                  chip.kind === 'summary'
                    ? summary !== null
                    : chip.kind === 'outline'
                      ? outline !== null
                      : chip.kind === 'timeline'
                        ? timeline !== null
                        : chip.kind === 'concepts'
                          ? concepts !== null
                          : characters !== null
                const busy = busyKind === chip.kind
                return (
                  <button
                    key={chip.kind}
                    type="button"
                    className={`ai-chip${done ? ' is-done' : ''}`}
                    onClick={() => {
                      if (chip.kind === 'characters') void generateCharacters()
                      else void generateInsight(chip.kind)
                    }}
                    disabled={insightPhase === 'streaming'}
                    title={done ? `已有${chip.label},再点一次重新生成` : chip.hint}
                  >
                    {busy ? `${chip.label}…` : chip.label}
                  </button>
                )
              })}
            </div>
            {sourceText !== null && (
              <div className="ai-chip-row">
                <span className="ai-chip-row-label">修整原文</span>
                <button
                  type="button"
                  className="ai-chip ai-chip-ghost"
                  onClick={() => void runAiRepair()}
                  disabled={insightPhase === 'streaming'}
                >
                  {busyKind === 'repair' ? '检查中…' : 'AI 纠错'}
                </button>
                <button
                  type="button"
                  className="ai-chip ai-chip-ghost"
                  onClick={() => void runConvert('t2s')}
                  disabled={insightPhase === 'streaming'}
                >
                  {busyKind === 't2s' ? '转换中…' : '繁 → 简'}
                </button>
                <button
                  type="button"
                  className="ai-chip ai-chip-ghost"
                  onClick={() => void runConvert('s2t')}
                  disabled={insightPhase === 'streaming'}
                >
                  {busyKind === 's2t' ? '转换中…' : '简 → 繁'}
                </button>
              </div>
            )}
            {/* 生成前就说清发送范围:模型只看得到前 N 章开头,不是全书。 */}
            <p className="ai-privacy">
              发送范围:前 {Math.min(sections.length, INSIGHT_MAX_CHAPTERS)} 章开头(每章最多{' '}
              {INSIGHT_EXCERPT_CHARS} 字),并非全书内容。
            </p>
          </section>
        )}
        {summary !== null && (
          <article className="ai-result">
            <p className="ai-result-label">内容摘要</p>
            <p className="ai-insight-overview">{summary.overview}</p>
            <div className="ai-citations">
              {summary.themes.map((theme) => (
                <span key={theme} className="ai-citation">
                  {theme}
                </span>
              ))}
            </div>
            <p className="ai-privacy">{summary.coverage}</p>
          </article>
        )}
        {outline !== null && (
          <article className="ai-result">
            <p className="ai-result-label">章节大纲</p>
            {outline.chapters.map((chapter) => (
              <p key={chapter.title} className="ai-insight-outline">
                <strong>{chapter.title}</strong> {chapter.gist}
              </p>
            ))}
          </article>
        )}
        {timeline !== null && (
          <article className="ai-result">
            <p className="ai-result-label">事件时间线</p>
            {timeline.events.map((event) => (
              <p key={`${event.chapterRef}-${event.event}`} className="ai-insight-outline">
                <span className="ai-citation">{event.chapterRef}</span>{' '}
                <strong>{event.event}</strong>
                {event.descriptions.length > 0 && ` — ${event.descriptions.join(';')}`}
              </p>
            ))}
          </article>
        )}
        {concepts !== null && (
          <article className="ai-result">
            <p className="ai-result-label">核心概念</p>
            {concepts.concepts.map((concept) => (
              <p key={concept.name} className="ai-insight-outline">
                <strong>{concept.name}</strong>
                <span className="ai-citation">概念</span> {concept.explanation}
              </p>
            ))}
          </article>
        )}
        {characters !== null && (
          <article className="ai-result">
            <p className="ai-result-label">人物角色</p>
            {characters.characters.map((character) => (
              <p key={character.name} className="ai-insight-outline">
                <strong>{character.name}</strong>
                <span className="ai-citation">{character.role}</span> {character.description}
              </p>
            ))}
          </article>
        )}
        {aiCorrections !== null && (
          <article className="ai-result">
            <p className="ai-result-label">
              纠错提案 · 已选 {aiCorrections.accepted.size}/{aiCorrections.proposals.length}
            </p>
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
              className="ai-apply"
              onClick={() => void applyAiCorrectionsAccepted()}
            >
              应用已选({aiCorrections.accepted.size}/{aiCorrections.proposals.length})
            </button>
          </article>
        )}
        {conversions !== null && (
          <article className="ai-result">
            <p className="ai-result-label">
              {conversionRuleLabel(conversions.rule)} · 已选 {conversions.accepted.size}/
              {conversions.proposals.length}
            </p>
            <p className="ai-privacy">
              由当前 AI 提供商({conversions.providerLabel})生成,已逐条对照原文校验,仅应用勾选项。
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
              className="ai-apply"
              onClick={() => void applyConversionsAccepted()}
            >
              应用已选({conversions.accepted.size}/{conversions.proposals.length})
            </button>
          </article>
        )}

        <div className="ai-messages">
          {messages.length === 0 && (
            <div className="ai-empty">
              <p className="ai-empty-title">{selection ? '已带入选中文本' : '向这本书提问'}</p>
              <p className="ai-empty-hint">
                {selection
                  ? `${selection.length} 字上下文 · 问点什么,比如“解释这段”。`
                  : '句子、章节、人物、观点 —— 答案只基于当前这本书的上下文。'}
              </p>
            </div>
          )}
          {messages.map((message, index) => (
            <div key={index} className={`ai-msg-wrap ai-msg-wrap-${message.role}`}>
              <div className={`ai-msg ai-msg-${message.role}`}>
                {message.content || (message.streaming ? '…' : '')}
              </div>
              {message.role === 'assistant' && citations.get(index) !== undefined && (
                <div className="ai-citations">
                  {citations.get(index)?.map((label) =>
                    onJumpToCitation !== undefined ? (
                      <button
                        key={label}
                        type="button"
                        className="ai-citation"
                        title={`跳转到「${label.replace(/\(\d+\)$/, '')}」`}
                        onClick={() => onJumpToCitation(label)}
                      >
                        {label}
                      </button>
                    ) : (
                      <span key={label} className="ai-citation">
                        {label}
                      </span>
                    ),
                  )}
                </div>
              )}
              {message.role === 'assistant' &&
                !message.streaming &&
                scope === 'selection' &&
                selection !== null &&
                onSaveAnswerToNote !== undefined &&
                message.content.trim() !== '' && (
                  <button
                    type="button"
                    className="ai-note-save"
                    disabled={savedNotes.has(index)}
                    onClick={() => {
                      const save = onSaveAnswerToNote
                      if (save === undefined) return
                      void save(message.content.trim())
                        .then(() => {
                          setSavedNotes((current) => new Set(current).add(index))
                        })
                        .catch((saveError: unknown) => {
                          setError(toAppError(saveError).message)
                        })
                    }}
                  >
                    {savedNotes.has(index) ? (
                      <Check size={13} weight="bold" aria-hidden />
                    ) : (
                      <Note size={13} weight="regular" aria-hidden />
                    )}
                    {savedNotes.has(index) ? '已写入批注' : '写入批注笔记'}
                  </button>
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
        <div className="ai-chip-row">
          {characters !== null && characters.characters.length > 0 && (
            <button
              type="button"
              className="ai-chip ai-chip-ghost"
              onClick={() => setGraphSpec({ kind: 'characters', payload: characters })}
            >
              角色关系图
            </button>
          )}
          {timeline !== null && timeline.events.length > 0 && (
            <button
              type="button"
              className="ai-chip ai-chip-ghost"
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
              className="ai-chip ai-chip-ghost"
              onClick={() => setGraphSpec({ kind: 'concepts', payload: concepts })}
            >
              概念关系图
            </button>
          )}
        </div>
      </div>

      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
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
            className="ai-send is-stop"
            onClick={() => void cancel()}
            title="停止"
          >
            <X size={15} weight="bold" aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            className="ai-send"
            disabled={
              (!activeId && !new URLSearchParams(window.location.search).has('mockKey')) ||
              input.trim().length === 0
            }
            title="发送"
            aria-label="发送"
          >
            <PaperPlaneRight size={15} weight="fill" aria-hidden />
          </button>
        )}
      </form>
      {graphSpec !== null && <GraphView spec={graphSpec} onClose={() => setGraphSpec(null)} />}
    </aside>
  )
}
