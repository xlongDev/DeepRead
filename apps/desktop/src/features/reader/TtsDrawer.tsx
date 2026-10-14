import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  CaretDown,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretLeft,
  CaretRight,
  Check,
  Highlighter,
  Pause,
  Play,
  X,
} from '@phosphor-icons/react'
import { type AiProviderConfig } from '@deepread/shared'
import {
  buildSpeechUnits,
  queuePosition,
  speakerRoles,
  unitAtChar,
  washSpan,
  type SpeechUnit,
} from '@deepread/reader-core'
import { invokeCommand } from '../../lib/ipc'
import { DropdownMenu } from '../../components/DropdownMenu'
import { useTts } from './tts/useTts'
import { CHARS_PER_SECOND, formatClock, sentencesOf, voicesForLanguage } from './tts-plan'

type Engine = 'edge' | 'system' | 'cloud'

const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const
const RATE_KEYS = RATE_OPTIONS.map((rate) => rate.toString()) as readonly string[]
const ENGINE_LABELS: Readonly<Record<Engine, string>> = {
  edge: 'Edge 语音',
  system: '系统语音',
  cloud: '云端语音',
}

/** TTS 高亮预设色:对比度都按深色文字背景搭配验证过,白底/羊皮/夜间
 *  都能落得稳。每条都给一个语义化的名字,而不是「红/绿」——选色凭直觉
 *  选不到名字,名字还能帮用户记住上一次选的是哪个。 */
export const HIGHLIGHT_PRESETS = [
  { name: '琥珀', color: '#f5d76e' },
  { name: '青蓝', color: '#7dd3fc' },
  { name: '粉梅', color: '#fda4af' },
  { name: '薄荷', color: '#86efac' },
  { name: '蜜橙', color: '#fdba74' },
  { name: '紫罗兰', color: '#c4b5fd' },
] as const

type HighlightMode = 'off' | 'sentence' | 'word'

const SETTINGS_KEY = 'deepread.tts.settings'

interface TtsSettings {
  engine: Engine
  rate: number
  /** 章末连读下一章。 */
  autoNext: boolean
  timerKind: 'off' | 'minutes' | 'section' | 'book'
  timerMinutes: number
  narratorEdge: string
  narratorSystem?: string
  narratorCloud: string
  /** 正文 TTS 高亮粒度:'word' 走引擎报回的词边界,逐词洗色。 */
  highlightMode: HighlightMode
  highlightColor: string
  /**
   * 角色 → 音色,按引擎分存:三个引擎的音色 id 互不通用(Edge 是 shortName、
   * 系统是 voiceURI、云端是服务商的 voice 字段)。没配的角色回退叙述者音色。
   */
  speakerVoices: Record<string, Partial<Record<Engine, string>>>
}

/**
 * `speakerVoices` 是用户可写的字典,直接摊平 localStorage 里的旧值/手改脏值
 * 会在渲染时炸掉 —— 只保留字符串,其余字段沿用原样合并。
 */
function sanitizeSettings(value: TtsSettings): TtsSettings {
  const voices: Record<string, Partial<Record<Engine, string>>> = {}
  const raw: unknown = value.speakerVoices
  if (raw !== null && typeof raw === 'object') {
    for (const [speaker, perEngine] of Object.entries(raw as Record<string, unknown>)) {
      const entry: Partial<Record<Engine, string>> = {}
      if (perEngine !== null && typeof perEngine === 'object') {
        const source = perEngine as Record<string, unknown>
        for (const engine of ['edge', 'system', 'cloud'] as const) {
          const id = source[engine]
          if (typeof id === 'string' && id !== '') entry[engine] = id
        }
      }
      voices[speaker] = entry
    }
  }
  return { ...value, speakerVoices: voices }
}

/** 该说话人在当前引擎下的音色;没单独配过就用叙述者的。 */
export function voiceForSpeaker(
  settings: TtsSettings,
  speaker: string,
  engine: Engine,
): string | undefined {
  const own = settings.speakerVoices[speaker]?.[engine]
  if (own !== undefined && own !== '') return own
  if (engine === 'edge') return settings.narratorEdge
  if (engine === 'cloud') return settings.narratorCloud
  return settings.narratorSystem
}

const DEFAULT_SETTINGS: TtsSettings = {
  engine: 'edge',
  rate: 1,
  autoNext: true,
  timerKind: 'off',
  timerMinutes: 30,
  narratorEdge: 'zh-CN-XiaoxiaoNeural',
  narratorCloud: 'alloy',
  highlightMode: 'sentence',
  highlightColor: HIGHLIGHT_PRESETS[0].color,
  speakerVoices: {},
}

interface TtsDrawerProps {
  readonly bookHash: string
  readonly bookTitle: string
  /** 书的语言(BCP-47),用于过滤语音列表。 */
  readonly bookLanguage?: string
  /** 封面缩略图(书架同源提取)。 */
  readonly coverUrl: string | null
  /** 当前章节名(阅读位置)。 */
  readonly sectionLabel: string | null
  /** 迷你播放条形态(面板被收起或切到别的面板时)。 */
  readonly minimized: boolean
  /** 播放状态变化(用于父层决定是否保留迷你条)。 */
  readonly onPlayingChange: (playing: boolean) => void
  /** Plain text of the section currently on screen. */
  readonly getSectionText: () => Promise<string>
  /** 跳转章节(±1);返回 false 表示越界。 */
  readonly jumpSection: (delta: number) => Promise<boolean>
  /** TTS 高亮广播:声音移动到新位置时通知父层;父层负责把高亮打回正文
   *  并触发自动翻页。传 null 表示清掉当前高亮(暂停/切章/关闭)。 */
  readonly onHighlight?: (
    highlight: {
      readonly mode: HighlightMode
      readonly start: number
      readonly end: number
      readonly color: string
    } | null,
  ) => void
  /** 展开回完整播放器。 */
  readonly onExpand: () => void
  /** 收起为迷你播放条。 */
  readonly onMinimize: () => void
  /** 完全关闭(停止播放)。 */
  readonly onClose: () => void
}

type Phase = 'idle' | 'loading' | 'playing' | 'paused'

export interface TtsDrawerHandle {
  /** 真正停止播放并清空内部状态 — 父层调一次,TtsDrawer 会通过
   *  onPlayingChange 反馈 idle,自然触发卸载。 */
  readonly stop: () => void
}

/** 歌词页的一行。memo 化:600 句的长章里,切句只重画两行(current/past 翻转),
 *  其余行 props 全等直接跳过。 */
const SentenceItem = memo(function SentenceItem({
  text,
  index,
  current,
  past,
  onSeek,
}: {
  readonly text: string
  readonly index: number
  readonly current: boolean
  readonly past: boolean
  readonly onSeek: (index: number) => void
}) {
  return (
    <li>
      <button
        type="button"
        className={`tts-sentence-item${current ? ' is-current' : ''}${past ? ' is-past' : ''}`}
        onClick={() => onSeek(index)}
        aria-current={current}
      >
        {text}
      </button>
    </li>
  )
})

export const TtsDrawer = forwardRef<TtsDrawerHandle, TtsDrawerProps>(function TtsDrawer(
  {
    bookHash,
    bookTitle,
    bookLanguage,
    coverUrl,
    sectionLabel,
    minimized,
    onPlayingChange,
    getSectionText,
    jumpSection,
    onHighlight,
    onExpand,
    onMinimize,
    onClose,
  }: TtsDrawerProps,
  ref,
) {
  const [settings, setSettings] = useState<TtsSettings>(() => {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY)
      return stored
        ? sanitizeSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(stored) as Partial<TtsSettings>) })
        : DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  })
  const [view, setView] = useState<'player' | 'voices'>('player')
  /** 语音面板的两栏:叙述者 / 角色。没有角色时只显示叙述者。 */
  const [voiceTab, setVoiceTab] = useState<'narrator' | 'roles'>('narrator')
  /** 本章的角色(名 + 出现单元数);空 = 这章没认领到任何角色。 */
  const [roles, setRoles] = useState<readonly { name: string; count: number }[]>([])
  /** 角色名来源:AI 角色图谱 artifact。没跑过抽取就没有角色 —— 不假装有。 */
  const [knownNames, setKnownNames] = useState<readonly string[]>([])
  /** 朗读单元队列(一句一个,带说话人与章节偏移);歌词页即它的投影。 */
  const [units, setUnits] = useState<readonly SpeechUnit[]>([])
  /** 已提交的朗读进度(累加字符空间,见 queuePosition):跨句时才进 state,
   *  进度条/时钟走 DOM 直写。「声音在哪一句」由引擎报的 tts.unit 回答,
   *  不经过这里 —— 章节偏移与累加字符是两个空间,互相换算会漂。 */
  const [progress, setProgress] = useState(0)
  const [sectionTitle, setSectionTitle] = useState(sectionLabel)
  const [edgeVoices, setEdgeVoices] = useState<
    readonly { shortName: string; friendlyName: string; locale: string; lang: string }[]
  >([])
  const [providers, setProviders] = useState<readonly AiProviderConfig[]>([])

  const activeId = providers[0]?.id ?? null

  // 引擎:词级高亮时才逐词发布边界(见 useTts 的 trackBoundary)。
  const tts = useTts({
    trackBoundary: settings.highlightMode === 'word',
    lang: bookLanguage,
    cloudConfigId: activeId,
  })
  const {
    play: ttsPlay,
    stop: ttsStop,
    pause: ttsPause,
    resume: ttsResume,
    setRate: ttsSetRate,
    setVoice: ttsSetVoice,
    boundaryAt: ttsBoundaryAt,
  } = tts
  const error = tts.error
  const voices = tts.systemVoices

  const phase: Phase = tts.status === 'idle' ? 'idle' : tts.loading ? 'loading' : tts.status

  // 播放循环比渲染活得久,实时值全部从镜像读取。
  const settingsRef = useRef(settings)
  const phaseRef = useRef(phase)
  const unitsRef = useRef<readonly SpeechUnit[]>([])
  /** 引擎正在读的单元下标:跨句提交 React 状态的那个值的镜像,效果里读。 */
  const ttsUnitRef = useRef<number | null>(null)
  const knownNamesRef = useRef<readonly string[]>([])
  const activeIdRef = useRef<string | null>(null)
  const sectionTokenRef = useRef(0)
  const stopFlagRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 60ms ticker 的直写出口:进度条/时钟绕过 React 更新(见 paintProgress),
  // React 状态 progress 只在跨句时提交,长章不再整抽屉重渲染。
  const miniFillRef = useRef<HTMLSpanElement | null>(null)
  const seekInputRef = useRef<HTMLInputElement | null>(null)
  const elapsedClockRef = useRef<HTMLSpanElement | null>(null)
  const remainingClockRef = useRef<HTMLSpanElement | null>(null)

  /** 清睡眠定时器(有则清并置空)。 */
  const clearTimer = useCallback((): void => {
    if (!timerRef.current) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  /** 进度条与时钟的 DOM 直写:60ms 频率下绕开 React,布局抖动只有这几个
   *  节点;React 重渲染面收窄到「跨句」(见 progress state)。出口随形态
   *  只挂一套(迷你条 or 完整抽屉),null 检查兜住切换瞬间。
   *
   *  入参是**累加字符位置**(queuePosition 的空间),与单元 start/end 的
   *  章节真实偏移刻意分开 —— 见 reader-core 的 queuePosition 注释。 */
  const paintProgress = useCallback((pos: number): void => {
    const total = queuePosition(unitsRef.current, null).total
    const fraction = total > 0 ? Math.min(1, pos / total) : 0
    if (miniFillRef.current) miniFillRef.current.style.width = `${fraction * 100}%`
    if (seekInputRef.current) seekInputRef.current.value = String(Math.round(fraction * 1000))
    const cps = CHARS_PER_SECOND * settingsRef.current.rate
    if (elapsedClockRef.current)
      elapsedClockRef.current.textContent = formatClock(total > 0 ? pos / cps : 0)
    if (remainingClockRef.current)
      remainingClockRef.current.textContent = formatClock(total > 0 ? (total - pos) / cps : 0)
  }, [])

  useEffect(() => {
    settingsRef.current = settings
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])
  useEffect(() => {
    phaseRef.current = phase
    onPlayingChange(phase !== 'idle')
  }, [phase, onPlayingChange])
  useEffect(() => {
    ttsUnitRef.current = tts.unit
  }, [tts.unit])
  useEffect(() => {
    knownNamesRef.current = knownNames
  }, [knownNames])
  useEffect(() => {
    setSectionTitle(sectionLabel)
  }, [sectionLabel])

  useEffect(() => {
    invokeCommand('ai.config.list', undefined)
      .then((response) => {
        setProviders(response?.providers ?? [])
      })
      .catch(() => {
        // 云端引擎是可选项;选中时才暴露错误。
      })
  }, [])

  /** 角色名 = AI 角色图谱已抽出的名字;没抽过就是 0 个角色,全书走叙述者。 */
  useEffect(() => {
    invokeCommand('ai.artifact.get', { bookHash, kind: 'characters' })
      .then((response) => {
        const payload = response?.payload as { characters?: unknown } | null | undefined
        const list = payload?.characters
        if (!Array.isArray(list)) return
        setKnownNames(
          list
            .map((item) => (item as { name?: unknown }).name)
            .filter((name): name is string => typeof name === 'string' && name.length > 0),
        )
      })
      .catch(() => {
        // 没抽取过角色图谱就走单音色 —— 不是错误,不打扰用户。
      })
  }, [bookHash])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onMinimize()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      stopFlagRef.current = true
      ttsStop()
      clearTimer()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    void invokeCommand('tts.edge.voices', undefined)
      .then((response) => {
        if (cancelled) return
        setEdgeVoices(
          response.voices.map((voice) => ({
            shortName: voice.shortName,
            friendlyName: voice.friendlyName,
            locale: voice.locale,
            lang: voice.locale,
          })),
        )
      })
      .catch(() => {
        // 列表拉取失败时仍可手输;错误在使用处呈现。
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const stop = useCallback((): void => {
    stopFlagRef.current = true
    sectionTokenRef.current += 1
    clearTimer()
    ttsStop()
    setUnits([])
    unitsRef.current = []
    setProgress(0)
  }, [clearTimer, ttsStop])

  useImperativeHandle(ref, () => ({ stop }), [stop])

  const armTimer = useCallback((): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const { timerKind, timerMinutes } = settingsRef.current
    if (timerKind === 'minutes' && timerMinutes > 0) {
      timerRef.current = setTimeout(() => stop(), timerMinutes * 60 * 1000)
    }
    // section/book 模式在章循环结束处检查。
  }, [stop])

  /**
   * 从 `fromUnit` 起连播整章;章末按连读开关与定时模式决定去留。
   *
   * 播放本身在引擎层(`useTts` + `clipEngine`:预取、跟词、变速),这里只做
   * 编排:取章节文本 → 切单元 → 起播 → 章末回调里决定连读/停止。文本**不
   *  trim**:偏移模型必须和父层高亮用的 `walkSectionText` 一致,trim 掉
   * 头部空白会让整章高亮偏一格。
   */
  const run = useCallback(
    (opts: { readonly fromUnit?: number; readonly stopAtChapterEnd?: boolean } = {}): void => {
      sectionTokenRef.current += 1
      const token = sectionTokenRef.current
      stopFlagRef.current = false
      armTimer()
      let fromUnit = opts.fromUnit ?? 0
      let stopAtEnd = opts.stopAtChapterEnd ?? false
      let previous = ''
      const step = async (): Promise<void> => {
        if (stopFlagRef.current || sectionTokenRef.current !== token) return
        const text = await getSectionText()
        if (stopFlagRef.current || sectionTokenRef.current !== token) return
        if (text.trim() === '' || text === previous) return
        previous = text
        const plan = buildSpeechUnits(text, knownNamesRef.current)
        if (stopFlagRef.current || sectionTokenRef.current !== token) return
        unitsRef.current = plan
        setUnits(plan)
        setRoles(speakerRoles(plan))
        // 新一轮句子计划:进度提交到新章起点(累加字符空间),歌词页的当前行
        // 由引擎报回的新单元接管。
        const from = Math.max(0, Math.min(fromUnit, plan.length - 1))
        setProgress(queuePosition(plan, from).spoken)
        ttsPlay(plan, from, () => {
          if (stopFlagRef.current || sectionTokenRef.current !== token) return
          // 定时"本章结束",或跨章"上一句"只播上一章的尾部。
          if (stopAtEnd || settingsRef.current.timerKind === 'section') {
            stop()
            return
          }
          if (!settingsRef.current.autoNext) {
            stop()
            return
          }
          void jumpSection(1).then((moved) => {
            if (!moved) return
            if (stopFlagRef.current || sectionTokenRef.current !== token) return
            fromUnit = 0
            stopAtEnd = false
            void step()
          })
        })
      }
      void step()
    },
    [getSectionText, jumpSection, armTimer, ttsPlay, stop],
  )

  const play = useCallback((): void => {
    if (phaseRef.current === 'paused') {
      ttsResume()
      armTimer()
      return
    }
    if (phaseRef.current !== 'idle') return
    void run({ fromUnit: 0 })
  }, [run, armTimer, ttsResume])

  const pause = useCallback((): void => {
    if (phaseRef.current !== 'playing') return
    ttsPause()
    clearTimer()
  }, [ttsPause, clearTimer])

  const toggle = useCallback((): void => {
    if (phaseRef.current === 'playing') pause()
    else play()
  }, [pause, play])

  /** 语速:引擎在播音侧直接拉伸(rate 不进合成请求),不重合成、不重启。 */
  useEffect(() => {
    ttsSetRate(settings.rate)
  }, [settings.rate, ttsSetRate])

  /** 音色/引擎/角色音色热切换:待机也同步(起播时引擎层读到的就是当前
   *  设置);同引擎从下一句起生效(引擎层换音色,已合成的块不失效);
   *  跨引擎两边队列无法交接,会话中断后从当前句续播。 */
  const engineProbe = useRef<Engine | null>(null)
  const mountedProbe = useRef(false)
  useEffect(() => {
    const wasEngine = engineProbe.current
    const first = !mountedProbe.current
    mountedProbe.current = true
    engineProbe.current = settings.engine
    ttsSetVoice(
      settings.engine,
      voiceForSpeaker(settings, 'narrator', settings.engine) ?? null,
      (speaker) => voiceForSpeaker(settings, speaker, settings.engine) ?? null,
    )
    if (first) return
    if (phaseRef.current === 'idle') return
    if (settings.engine !== wasEngine) {
      // 从引擎正在读的那句续播(引擎状态,不从字符位置反推)。
      const at = ttsUnitRef.current ?? 0
      sectionTokenRef.current += 1
      stopFlagRef.current = true
      setTimeout(() => {
        void run({ fromUnit: at })
      }, 60)
    }
    // 只依赖 settings 字段:`run` 的身份随父层 inline props 变化,放进来会让
    // 父层每次重渲染都重放音色(清空预取缓存);ttsSetVoice 本身是稳定的。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings.engine,
    settings.narratorEdge,
    settings.narratorCloud,
    settings.narratorSystem,
    // 角色音色变了同样从下一句生效:引擎按单元选音色,缓存按音色分开。
    settings.speakerVoices,
  ])

  /** 主动 ticker:每 60ms 读引擎报回的词边界,推进度 —— 比旧版
   *  `currentTime/duration` 比例估算精确(引擎报的是真实词边界)。
   *  tick 内不碰 React 状态:进度条/时钟走 paintProgress 直写,
   *  只有跨句时才提交一次 state。 */
  useEffect(() => {
    const tick = setInterval(() => {
      if (phaseRef.current === 'idle') return
      const spot = ttsBoundaryAt()
      const list = unitsRef.current
      if (!spot || list.length === 0) return
      const unit = list[spot.unit]
      if (!unit) return
      // 累加字符空间:本句之前的所有字符 + 本句内已读到的词。
      const spoken =
        queuePosition(list, spot.unit).spoken + Math.min(spot.charIndex, unit.text.length)
      paintProgress(spoken)
    }, 60)
    return () => clearInterval(tick)
  }, [ttsBoundaryAt, paintProgress])

  /** 跨句即提交:引擎报回新单元时把进度落到新句开头(词边界随后由 ticker
   *  细化), scrubber 的 state 值不等下一个 tick。 */
  useEffect(() => {
    if (tts.unit === null) return
    if (unitsRef.current[tts.unit] === undefined) return
    setProgress(queuePosition(unitsRef.current, tts.unit).spoken)
  }, [tts.unit])

  const totalChars = useMemo(() => queuePosition(units, null).total, [units])

  /** TTS 高亮广播:声音移到新位置(跨句或跨词)时,把要洗的字符区间发给
   *  父层。词级等引擎报回第一个词再洗 —— 先洗整句再缩成一个词读起来
   *  是闪一下而不是高亮。
   *
   *  「声音在哪一句」由引擎报的 `tts.unit` 直接回答(同 ColorReader 的
   *  span memo):不经过 charPos → unitAtChar 的往返 —— 那是两个字符空间
   *  的换算,块间换行会让它随章节推进越漂越远(词级高亮整个失效、句级洗到
   *  还没读的句子)。引擎没有当前单元(停止/切章间隙)才清洗。 */
  useEffect(() => {
    const index = tts.unit
    if (index === null || settings.highlightMode === 'off') {
      onHighlight?.(null)
      return
    }
    const unit = units[index]
    if (unit === undefined) {
      onHighlight?.(null)
      return
    }
    const span = washSpan(index, unit, tts.boundary, settings.highlightMode)
    if (span === null) return
    onHighlight?.({
      mode: settings.highlightMode,
      start: span.start,
      end: span.end,
      color: settings.highlightColor,
    })
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tts.unit, units, tts.boundary, settings.highlightMode, settings.highlightColor])

  /** scrubber 的位置(累加字符)→ 单元下标,从那一句起播。 */
  const seekToChar = useCallback(
    (target: number): void => {
      if (phaseRef.current === 'idle') return
      const list = unitsRef.current
      if (list.length === 0) return
      const total = queuePosition(list, null).total
      const index = unitAtChar(list, Math.max(0, Math.min(target, total > 0 ? total - 1 : target)))
      sectionTokenRef.current += 1
      stopFlagRef.current = true
      ttsStop()
      setTimeout(() => {
        void run({ fromUnit: index })
      }, 60)
    },
    [run, ttsStop],
  )

  /** 句子行的 seek 走稳定引用:行已 memo 化,onClick 每渲染换新会整体失效。
   *  传单元下标而不是字符偏移 —— 行与队列同序,下标即答案。 */
  const seekSentence = useCallback(
    (index: number): void => {
      if (phaseRef.current === 'idle') return
      const list = unitsRef.current
      if (list.length === 0) return
      const at = Math.max(0, Math.min(index, list.length - 1))
      sectionTokenRef.current += 1
      stopFlagRef.current = true
      ttsStop()
      setTimeout(() => {
        void run({ fromUnit: at })
      }, 60)
    },
    [run, ttsStop],
  )

  const jumpSentences = useCallback(
    (delta: number): void => {
      if (phaseRef.current === 'idle') return
      const current = ttsUnitRef.current ?? 0
      const target = current + delta
      if (target < 0) {
        void jumpSection(-1).then((moved) => {
          if (moved) {
            sectionTokenRef.current += 1
            stopFlagRef.current = true
            ttsStop()
            setTimeout(
              () => void run({ fromUnit: Number.MAX_SAFE_INTEGER, stopAtChapterEnd: true }),
              60,
            )
          }
        })
        return
      }
      seekSentence(target)
    },
    [jumpSection, run, seekSentence, ttsStop],
  )

  const changeSection = useCallback(
    (delta: number): void => {
      const wasActive = phaseRef.current !== 'idle'
      stop()
      void jumpSection(delta).then((moved) => {
        if (moved && wasActive) void run({ fromUnit: 0 })
      })
    },
    [stop, jumpSection, run],
  )

  // 切句时把当前句滚动到视口中央(歌词页)。
  const sentenceListRef = useRef<HTMLOListElement | null>(null)
  useEffect(() => {
    if (sentenceListRef.current === null) return
    const current = sentenceListRef.current.querySelector('.is-current')
    current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [tts.unit, units.length])

  const sentences = useMemo(() => sentencesOf(units), [units])

  const sentenceProgress = totalChars > 0 ? Math.min(1, progress / totalChars) : 0
  const cps = CHARS_PER_SECOND * settings.rate
  const elapsed = totalChars > 0 ? progress / cps : 0
  const remaining = totalChars > 0 ? (totalChars - progress) / cps : 0

  const voiceLabel =
    settings.engine === 'edge'
      ? (edgeVoices.find((voice) => voice.shortName === settings.narratorEdge)?.shortName ??
        settings.narratorEdge)
      : settings.engine === 'cloud'
        ? settings.narratorCloud
        : (voices.find((voice) => voice.voiceURI === settings.narratorSystem)?.name ?? '默认')

  const systemVoiceOptions = useMemo(
    () => voicesForLanguage(voices, bookLanguage),
    [voices, bookLanguage],
  )
  const edgeVoiceOptions = useMemo(
    () => voicesForLanguage(edgeVoices, bookLanguage),
    [edgeVoices, bookLanguage],
  )

  const timerLabel =
    settings.timerKind === 'off'
      ? '关闭'
      : settings.timerKind === 'section'
        ? '本章结束'
        : settings.timerKind === 'book'
          ? '全书结束'
          : `${settings.timerMinutes} 分钟`

  // 迷你播放条:悬浮在底栏上方,不打断阅读;点击展开,× 停止。
  if (minimized) {
    return (
      <section className="tts-mini" aria-label="朗读迷你条">
        {coverUrl ? (
          <img src={coverUrl} className="tts-mini-cover" alt="" />
        ) : (
          <span className="tts-mini-cover tts-cover-fallback" aria-hidden>
            {bookTitle.charAt(0)}
          </span>
        )}
        <button type="button" className="tts-mini-open" onClick={onExpand} title="展开播放器">
          <span className="tts-mini-title">{bookTitle}</span>
          <span className="tts-mini-progress">
            <span
              ref={miniFillRef}
              className="tts-mini-progress-fill"
              style={{ width: `${sentenceProgress * 100}%` }}
            />
          </span>
        </button>
        <button
          type="button"
          className="tts-mini-btn"
          onClick={toggle}
          title={phase === 'playing' ? '暂停' : phase === 'paused' ? '继续' : '播放'}
        >
          {phase === 'playing' ? (
            <Pause size={15} weight="fill" aria-hidden />
          ) : (
            <Play size={15} weight="fill" aria-hidden />
          )}
        </button>
        <button type="button" className="tts-mini-btn" onClick={onClose} title="停止并关闭">
          <X size={14} weight="regular" aria-hidden />
        </button>
      </section>
    )
  }

  return (
    <aside className="ai-drawer tts-drawer" aria-label="语音播放器">
      {view === 'voices' ? (
        <div className="tts-voices">
          <div className="lookup-head">
            <button
              type="button"
              className="chrome-button"
              onClick={() => setView('player')}
              title="返回播放器"
            >
              <CaretLeft size={16} weight="bold" aria-hidden />
            </button>
            <strong>选择语音</strong>
            <button type="button" className="chrome-button" onClick={onMinimize} title="收起">
              <X size={16} weight="regular" aria-hidden />
            </button>
          </div>
          <p className="tts-voices-sub">
            {ENGINE_LABELS[settings.engine]} ·{' '}
            {settings.engine === 'edge'
              ? `${edgeVoiceOptions.length} 种语音`
              : settings.engine === 'system'
                ? `${systemVoiceOptions.length} 种语音`
                : `${providers.length} 个服务`}
          </p>
          {roles.length > 0 && (
            <div className="tts-engine-row" aria-label="音色归属">
              <button
                type="button"
                className={`segmented-button${voiceTab === 'narrator' ? ' is-active' : ''}`}
                onClick={() => setVoiceTab('narrator')}
                aria-pressed={voiceTab === 'narrator'}
              >
                叙述者
              </button>
              <button
                type="button"
                className={`segmented-button${voiceTab === 'roles' ? ' is-active' : ''}`}
                onClick={() => setVoiceTab('roles')}
                aria-pressed={voiceTab === 'roles'}
              >
                角色 {roles.length}
              </button>
            </div>
          )}
          {roles.length > 0 && voiceTab === 'roles' ? (
            <div className="tts-voice-list">
              {roles.map((role) => (
                <div key={role.name} className="tts-role-row">
                  <span className="tts-role-name">
                    {role.name}
                    <span className="tts-role-count">{role.count} 段</span>
                  </span>
                  {settings.engine === 'cloud' ? (
                    <input
                      className="tts-role-input"
                      value={settings.speakerVoices[role.name]?.cloud ?? ''}
                      placeholder={`同叙述者(${settings.narratorCloud})`}
                      aria-label={`${role.name} 的云端音色`}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          speakerVoices: {
                            ...current.speakerVoices,
                            [role.name]: {
                              ...current.speakerVoices[role.name],
                              cloud: event.target.value,
                            },
                          },
                        }))
                      }
                    />
                  ) : (
                    <DropdownMenu
                      className="tts-role-dropdown"
                      ariaLabel={`${role.name} 的音色`}
                      value={voiceForSpeaker(settings, role.name, settings.engine) ?? ''}
                      options={
                        settings.engine === 'edge'
                          ? edgeVoiceOptions.map((voice) => ({
                              value: voice.shortName,
                              label: voice.shortName.replace(/Neural$/, ''),
                            }))
                          : [
                              { value: '', label: '默认' },
                              ...systemVoiceOptions.map((voice) => ({
                                value: voice.voiceURI,
                                label: voice.name,
                              })),
                            ]
                      }
                      onChange={(value) =>
                        setSettings((current) => ({
                          ...current,
                          speakerVoices: {
                            ...current.speakerVoices,
                            [role.name]: {
                              ...current.speakerVoices[role.name],
                              [current.engine]: value,
                            },
                          },
                        }))
                      }
                    >
                      <span className="tts-card-value">
                        {(voiceForSpeaker(settings, role.name, settings.engine) ?? '默认').slice(
                          0,
                          14,
                        )}
                      </span>
                    </DropdownMenu>
                  )}
                </div>
              ))}
              <p className="tts-voices-sub">
                角色音色对本章生效;换音色从下一句起生效,缓存按音色分开存,重听不重新计费。
              </p>
            </div>
          ) : (
            <div className="tts-voice-list">
              {settings.engine === 'edge' &&
                edgeVoiceOptions.map((voice) => (
                  <button
                    key={voice.shortName}
                    type="button"
                    className={`tts-voice-item${settings.narratorEdge === voice.shortName ? ' is-active' : ''}`}
                    onClick={() => {
                      setSettings((current) => ({ ...current, narratorEdge: voice.shortName }))
                      setView('player')
                    }}
                  >
                    <span className="tts-voice-name">{voice.shortName.replace(/Neural$/, '')}</span>
                    <span className="tts-voice-locale">{voice.locale}</span>
                    {settings.narratorEdge === voice.shortName && (
                      <Check size={15} weight="bold" aria-hidden />
                    )}
                  </button>
                ))}
              {settings.engine === 'system' && (
                <button
                  type="button"
                  className={`tts-voice-item${!settings.narratorSystem ? ' is-active' : ''}`}
                  onClick={() => {
                    setSettings((current) => ({ ...current, narratorSystem: undefined }))
                    setView('player')
                  }}
                >
                  <span className="tts-voice-name">默认</span>
                  {!settings.narratorSystem && <Check size={15} weight="bold" aria-hidden />}
                </button>
              )}
              {settings.engine === 'system' &&
                systemVoiceOptions.map((voice) => (
                  <button
                    key={voice.voiceURI}
                    type="button"
                    className={`tts-voice-item${settings.narratorSystem === voice.voiceURI ? ' is-active' : ''}`}
                    onClick={() => {
                      setSettings((current) => ({ ...current, narratorSystem: voice.voiceURI }))
                      setView('player')
                    }}
                  >
                    <span className="tts-voice-name">{voice.name}</span>
                    <span className="tts-voice-locale">{voice.lang}</span>
                    {settings.narratorSystem === voice.voiceURI && (
                      <Check size={15} weight="bold" aria-hidden />
                    )}
                  </button>
                ))}
              {settings.engine === 'cloud' &&
                providers.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    className={`tts-voice-item${activeId === provider.id ? ' is-active' : ''}`}
                    onClick={() => {
                      setView('player')
                    }}
                  >
                    <span className="tts-voice-name">
                      {provider.name} · {provider.ttsModel ?? '未配置 TTS 模型'}
                    </span>
                    {activeId === provider.id && <Check size={15} weight="bold" aria-hidden />}
                  </button>
                ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="tts-head">
            {coverUrl ? (
              <img src={coverUrl} alt="" className="tts-cover" />
            ) : (
              <span className="tts-cover tts-cover-fallback" aria-hidden>
                {bookTitle.charAt(0)}
              </span>
            )}
            <div className="tts-head-text">
              <strong className="tts-title">{bookTitle}</strong>
              <span className="tts-section">{sectionTitle || sectionLabel || '当前章节'}</span>
            </div>
            <button
              type="button"
              className="chrome-button"
              onClick={onMinimize}
              title="收起为迷你播放条"
            >
              <CaretDown size={15} weight="bold" aria-hidden />
            </button>
            <button type="button" className="chrome-button" onClick={onClose} title="停止并关闭">
              <X size={15} weight="regular" aria-hidden />
            </button>
          </div>

          <div className="tts-sentences" aria-live="polite">
            {units.length === 0 && phase === 'loading' ? (
              <div className="tts-loading" aria-label="正在合成语音">
                <div className="tts-loading-wave" aria-hidden>
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <span className="tts-loading-label">正在合成语音…</span>
              </div>
            ) : sentences.length === 0 ? (
              <p className="tts-sentence-text is-idle">
                {phase === 'idle' ? '待机' : '正在加载章节…'}
              </p>
            ) : (
              <ol className="tts-sentence-list" ref={sentenceListRef}>
                {sentences.map((sentence, index) => (
                  <SentenceItem
                    key={sentence.start}
                    text={sentence.text}
                    index={index}
                    current={index === tts.unit}
                    past={tts.unit !== null && index < tts.unit}
                    onSeek={seekSentence}
                  />
                ))}
              </ol>
            )}
          </div>

          <div className="tts-progress">
            <span ref={elapsedClockRef} className="tts-clock">
              {formatClock(elapsed)}
            </span>
            <input
              ref={seekInputRef}
              type="range"
              className="tts-seek"
              min={0}
              max={1000}
              value={Math.round(sentenceProgress * 1000)}
              aria-label="本章播放进度"
              disabled={totalChars === 0}
              onChange={(event) => {
                const fraction = Number(event.target.value) / 1000
                seekToChar(Math.round(fraction * totalChars))
              }}
            />
            <span ref={remainingClockRef} className="tts-clock">
              -{formatClock(remaining)}
            </span>
          </div>

          <div className="tts-transport">
            <button
              type="button"
              className="tts-skip"
              onClick={() => changeSection(-1)}
              title="上一章"
              aria-label="上一章"
            >
              <CaretDoubleLeft size={17} weight="bold" aria-hidden />
            </button>
            <button
              type="button"
              className="tts-skip"
              onClick={() => jumpSentences(-1)}
              title="上一句"
              aria-label="上一句"
            >
              <CaretLeft size={17} weight="bold" aria-hidden />
            </button>
            {phase === 'playing' ? (
              <button
                type="button"
                className="tts-play"
                onClick={pause}
                title="暂停"
                aria-label="暂停"
              >
                <Pause size={22} weight="fill" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                className="tts-play"
                onClick={toggle}
                title={phase === 'paused' ? '继续' : '播放本章'}
                aria-label="播放"
              >
                <Play size={22} weight="fill" aria-hidden />
              </button>
            )}
            <button
              type="button"
              className="tts-skip"
              onClick={() => jumpSentences(1)}
              title="下一句"
              aria-label="下一句"
            >
              <CaretRight size={17} weight="bold" aria-hidden />
            </button>
            <button
              type="button"
              className="tts-skip"
              onClick={() => changeSection(1)}
              title="下一章"
              aria-label="下一章"
            >
              <CaretDoubleRight size={17} weight="bold" aria-hidden />
            </button>
          </div>

          <div className="tts-cards">
            <DropdownMenu
              className="tts-card-dropdown"
              ariaLabel="语速选择"
              value={settings.rate.toString()}
              options={RATE_KEYS.map((key) => ({
                value: key,
                label: `${key}×`,
              }))}
              onChange={(key) => {
                const next = Number(key)
                if (!Number.isFinite(next)) return
                setSettings((current) => ({ ...current, rate: next }))
              }}
            >
              <span className="tts-card-value">{settings.rate}×</span>
              <span className="tts-card-label">语速</span>
            </DropdownMenu>
            <button
              type="button"
              className="tts-card"
              onClick={() => setView('voices')}
              title="选择语音"
            >
              <span className="tts-card-value">
                {voiceLabel.length > 14 ? `${voiceLabel.slice(0, 13)}…` : voiceLabel}
              </span>
              <span className="tts-card-label">{ENGINE_LABELS[settings.engine]}</span>
            </button>
            <DropdownMenu
              className="tts-card-dropdown"
              ariaLabel="定时关闭"
              value={`${settings.timerKind}:${settings.timerMinutes}`}
              options={[
                { value: 'off:30', label: '关闭' },
                { value: 'minutes:30', label: '30 分钟' },
                { value: 'minutes:60', label: '60 分钟' },
                { value: 'minutes:90', label: '90 分钟' },
                { value: 'section:30', label: '本章结束' },
                { value: 'book:30', label: '全书结束(读完为止)' },
              ]}
              onChange={(value) => {
                const [kind, minutes] = value.split(':')
                setSettings((current) => ({
                  ...current,
                  timerKind: kind as TtsSettings['timerKind'],
                  timerMinutes: Number(minutes) || 30,
                }))
                if (kind === 'minutes' && phaseRef.current !== 'idle') armTimer()
                if (kind !== 'minutes') clearTimer()
              }}
            >
              <span className="tts-card-value">{timerLabel}</span>
              <span className="tts-card-label">定时关闭</span>
            </DropdownMenu>
          </div>

          <div className="tts-engine-row">
            {(Object.keys(ENGINE_LABELS) as Engine[]).map((engine) => (
              <button
                key={engine}
                type="button"
                className={`segmented-button${settings.engine === engine ? ' is-active' : ''}`}
                onClick={() => setSettings((current) => ({ ...current, engine }))}
              >
                {ENGINE_LABELS[engine]}
              </button>
            ))}
          </div>

          <div className="tts-highlight" aria-label="正文高亮设置">
            <div className="tts-engine-row tts-highlight-mode" aria-label="高亮粒度">
              {(['off', 'sentence', 'word'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`segmented-button${settings.highlightMode === mode ? ' is-active' : ''}`}
                  onClick={() => setSettings((current) => ({ ...current, highlightMode: mode }))}
                  aria-pressed={settings.highlightMode === mode}
                  title={
                    mode === 'off'
                      ? '关闭正文高亮'
                      : mode === 'sentence'
                        ? '按整句高亮(自动翻页)'
                        : '按词高亮(引擎报回的词边界,逐词洗色)'
                  }
                >
                  {mode === 'off' ? '关' : mode === 'sentence' ? '句级' : '词级'}
                </button>
              ))}
            </div>
            <div className="tts-highlight-colors" aria-label="高亮颜色">
              {HIGHLIGHT_PRESETS.map((preset) => (
                <button
                  key={preset.color}
                  type="button"
                  className={`tts-color-chip${settings.highlightColor === preset.color ? ' is-active' : ''}`}
                  style={{ background: preset.color }}
                  onClick={() =>
                    setSettings((current) => ({ ...current, highlightColor: preset.color }))
                  }
                  aria-label={`高亮色:${preset.name}`}
                  aria-pressed={settings.highlightColor === preset.color}
                  title={preset.name}
                />
              ))}
              <label className="tts-color-custom" title="自定义颜色">
                <input
                  type="color"
                  value={settings.highlightColor}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      highlightColor: event.target.value,
                    }))
                  }
                  aria-label="自定义高亮颜色"
                />
                <Highlighter size={13} weight="bold" aria-hidden />
              </label>
            </div>
          </div>

          <button
            type="button"
            className={`stats-toggle tts-auto-next${settings.autoNext ? ' is-on' : ''}`}
            role="switch"
            aria-checked={settings.autoNext}
            onClick={() => setSettings((current) => ({ ...current, autoNext: !current.autoNext }))}
          >
            <span className="stats-toggle-label">连读下一章</span>
            <span className="stats-toggle-track" aria-hidden>
              <span className="stats-toggle-thumb" />
            </span>
          </button>

          {error !== null && (
            <p className="ai-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </aside>
  )
})
