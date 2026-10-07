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
  SpinnerBall,
  X,
} from '@phosphor-icons/react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { toAppError, type AiProviderConfig } from '@deepread/shared'
import { splitSentencesWithOffsets } from '@deepread/reader-core'
import { invokeCommand } from '../../lib/ipc'
import { DropdownMenu } from '../../components/DropdownMenu'
import {
  blockSeekRatio,
  CHARS_PER_SECOND,
  formatClock,
  locateBlock,
  sentenceIndexAt,
  splitChapterBlocks,
  totalChars as sumChars,
  voicesForLanguage,
  type Block,
  type Sentence,
} from './tts-plan'

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
  /** 正文 TTS 高亮粒度:'word' 留作下一轮接入,目前等价于 'sentence'。 */
  highlightMode: HighlightMode
  highlightColor: string
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
  /** TTS 句级高亮广播:每次切到新句时通知父层;父层负责把高亮打回正文
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
 *  其余行 props 全等直接跳过 —— 60ms ticker 时代它们每帧都被重建。 */
const SentenceItem = memo(function SentenceItem({
  text,
  start,
  current,
  past,
  onSeek,
}: {
  readonly text: string
  readonly start: number
  readonly current: boolean
  readonly past: boolean
  readonly onSeek: (start: number) => void
}) {
  return (
    <li>
      <button
        type="button"
        className={`tts-sentence-item${current ? ' is-current' : ''}${past ? ' is-past' : ''}`}
        onClick={() => onSeek(start)}
        aria-current={current}
      >
        {text}
      </button>
    </li>
  )
})

export const TtsDrawer = forwardRef<TtsDrawerHandle, TtsDrawerProps>(function TtsDrawer(
  {
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
        ? { ...DEFAULT_SETTINGS, ...(JSON.parse(stored) as Partial<TtsSettings>) }
        : DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  })
  const [view, setView] = useState<'player' | 'voices'>('player')
  const [phase, setPhase] = useState<Phase>('idle')
  const [sentences, setSentences] = useState<readonly Sentence[]>([])
  const [charPos, setCharPos] = useState(0)
  const [sectionTitle, setSectionTitle] = useState(sectionLabel)
  const [error, setError] = useState<string | null>(null)
  const [voices, setVoices] = useState<readonly SpeechSynthesisVoice[]>([])
  const [edgeVoices, setEdgeVoices] = useState<
    readonly { shortName: string; friendlyName: string; locale: string; lang: string }[]
  >([])
  const [providers, setProviders] = useState<readonly AiProviderConfig[]>([])
  const [voiceSwitching, setVoiceSwitching] = useState(false)

  const stopFlagRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 播放循环比渲染活得久,实时值全部从镜像读取。
  const settingsRef = useRef(settings)
  const phaseRef = useRef(phase)
  const sentencesRef = useRef<readonly Sentence[]>([])
  const charPosRef = useRef(0)
  const voicesRef = useRef(voices)
  const activeIdRef = useRef<string | null>(null)
  const sectionTokenRef = useRef(0)
  // 首挂标记:热切换 effect 用它跳过首次执行。
  const voiceSettingsProbe = useRef(false)
  // 60ms ticker 的直写出口:进度条/时钟绕过 React 更新(见 paintCharPos),
  // React 状态 charPos 只在切句时提交,长章不再整抽屉重渲染。
  const miniFillRef = useRef<HTMLSpanElement | null>(null)
  const seekInputRef = useRef<HTMLInputElement | null>(null)
  const elapsedClockRef = useRef<HTMLSpanElement | null>(null)
  const remainingClockRef = useRef<HTMLSpanElement | null>(null)
  /** 已提交进 state 的句下标:applyCharPos 用它判「跨句了没有」。 */
  const committedSentenceRef = useRef(0)

  /** 拆音频:暂停、断 src(释放已解码缓冲)、丢引用 —— 各处 teardown 共用。 */
  const releaseAudio = useCallback((): void => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    audio.removeAttribute('src')
    audioRef.current = null
  }, [])

  /** 清睡眠定时器(有则清并置空)。 */
  const clearTimer = useCallback((): void => {
    if (!timerRef.current) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  /** 进度条与时钟的 DOM 直写:60ms 频率下绕开 React,布局抖动只有这几
   *  个节点;React 重渲染面收窄到「切句」(见 applyCharPos)。出口随形态
   *  只挂一套(迷你条 or 完整抽屉),null 检查兜住切换瞬间。 */
  const paintCharPos = useCallback((pos: number): void => {
    const list = sentencesRef.current
    const total = sumChars(list)
    const progress = total > 0 ? Math.min(1, pos / total) : 0
    if (miniFillRef.current) miniFillRef.current.style.width = `${progress * 100}%`
    if (seekInputRef.current) seekInputRef.current.value = String(Math.round(progress * 1000))
    const cps = CHARS_PER_SECOND * settingsRef.current.rate
    if (elapsedClockRef.current)
      elapsedClockRef.current.textContent = formatClock(total > 0 ? pos / cps : 0)
    if (remainingClockRef.current)
      remainingClockRef.current.textContent = formatClock(total > 0 ? (total - pos) / cps : 0)
  }, [])

  /** charPos 的唯一写入口:ref 是真源(播放循环比渲染活得久),进度条直写,
   *  state 只在跨句时提交一次 —— is-current、高亮广播、滚动居中都由它驱动。 */
  const applyCharPos = useCallback(
    (pos: number, force = false): void => {
      charPosRef.current = pos
      paintCharPos(pos)
      const index = sentenceIndexAt(sentencesRef.current, pos)
      if (force || index !== committedSentenceRef.current) {
        committedSentenceRef.current = index
        setCharPos(pos)
      }
    },
    [paintCharPos],
  )

  useEffect(() => {
    settingsRef.current = settings
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])
  useEffect(() => {
    phaseRef.current = phase
    onPlayingChange(phase !== 'idle')
  }, [phase, onPlayingChange])
  useEffect(() => {
    voicesRef.current = voices
  }, [voices])
  useEffect(() => {
    setSectionTitle(sectionLabel)
  }, [sectionLabel])

  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const load = (): void => setVoices(window.speechSynthesis.getVoices())
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])

  useEffect(() => {
    invokeCommand('ai.config.list', undefined)
      .then((response) => {
        setProviders(response?.providers ?? [])
      })
      .catch(() => {
        // 云端引擎是可选项;选中时才暴露错误。
      })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onMinimize()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      stopFlagRef.current = true
      window.speechSynthesis?.cancel()
      releaseAudio()
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

  const activeId = providers[0]?.id ?? null
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const stop = useCallback((): void => {
    stopFlagRef.current = true
    sectionTokenRef.current += 1
    clearTimer()
    window.speechSynthesis?.cancel()
    releaseAudio()
    setPhase('idle')
    setSentences([])
    sentencesRef.current = []
    applyCharPos(0, true)
  }, [clearTimer, releaseAudio, applyCharPos])

  useImperativeHandle(ref, () => ({ stop }), [stop])

  const armTimer = useCallback((): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const { timerKind, timerMinutes } = settingsRef.current
    if (timerKind === 'minutes' && timerMinutes > 0) {
      timerRef.current = setTimeout(() => stop(), timerMinutes * 60 * 1000)
    }
    // section/book 模式在章循环结束处检查。
  }, [stop])

  /** Ticker 当前正在播放的块:外层 60ms ticker 读这个推 charPos,
   *  不再依赖 audio.ontimeupdate 的低频事件(浏览器通常 ~250ms)。
   *  audio.currentTime 是浏览器自己的播放时钟,不会被 ticker 漂移影响。 */
  const playingRef = useRef<{ readonly block: Block; readonly duration: number } | null>(null)

  /** 播放已合成的块文件;外层 useEffect 跑 60ms ticker 推 charPos。 */
  const playBlockFile = useCallback(
    async (block: Block, path: string, seekRatio: number): Promise<void> => {
      const audio = new Audio(convertFileSrc(path))
      audioRef.current = audio
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (): void => {
          if (settled) return
          settled = true
          resolve()
        }
        const applySeek = (): void => {
          if (seekRatio > 0 && audio.duration > 0) {
            audio.currentTime = seekRatio * audio.duration
          }
          playingRef.current = { block, duration: audio.duration || 0 }
          // 立即推一次,避免首个 ticker 之前是 0。
          applyCharPos(
            block.start + Math.round((seekRatio > 0 ? seekRatio : 0) * block.text.length),
            true,
          )
        }
        audio.onloadedmetadata = () => applySeek()
        // metadata 在某些环境下不会触发,保底用 canplay。
        audio.oncanplay = () => {
          if (playingRef.current === null) applySeek()
        }
        audio.onended = settle
        audio.onerror = () => {
          if (!settled) {
            settled = true
            reject(new Error('音频播放失败'))
          }
        }
        void audio.play().catch((reason: unknown) => {
          if (!settled) {
            settled = true
            reject(reason instanceof Error ? reason : new Error('音频播放失败'))
          }
        })
      })
      playingRef.current = null
      applyCharPos(block.start + block.text.length, true)
    },
    [applyCharPos],
  )

  /** 系统引擎:整块 utterance + 估算时钟推进字符位置。 */
  const speakSystemBlock = useCallback(
    async (block: Block): Promise<void> => {
      if (!('speechSynthesis' in window)) throw new Error('当前环境不支持系统语音')
      const current = settingsRef.current
      const voice = voicesRef.current.find((item) => item.voiceURI === current.narratorSystem)
      const chars = block.text.length
      const perChar = 1000 / (CHARS_PER_SECOND * current.rate)
      let elapsed = 0
      const step = 60
      const clock = setInterval(() => {
        if (stopFlagRef.current) return
        elapsed += step
        applyCharPos(block.start + Math.min(chars, Math.round(elapsed / perChar)))
      }, step)
      try {
        await new Promise<void>((resolve, reject) => {
          const utterance = new SpeechSynthesisUtterance(block.text)
          if (voice) utterance.voice = voice
          utterance.rate = current.rate
          utterance.onend = () => resolve()
          utterance.onerror = (event) => {
            if (event.error === 'interrupted' || event.error === 'canceled') resolve()
            else reject(new Error(`系统语音合成失败(${event.error})`))
          }
          window.speechSynthesis.speak(utterance)
        })
      } finally {
        clearInterval(clock)
      }
      applyCharPos(block.start + chars)
    },
    [applyCharPos],
  )

  /** 从 startChar 起连播整章;章末按连读开关与定时模式决定去留。 */
  const run = useCallback(
    async (startChar = 0, opts?: { readonly stopAtChapterEnd?: boolean }): Promise<void> => {
      sectionTokenRef.current += 1
      const token = sectionTokenRef.current
      stopFlagRef.current = false
      setPhase('loading')
      setError(null)
      armTimer()
      try {
        let previous = ''
        for (;;) {
          if (stopFlagRef.current || sectionTokenRef.current !== token) return
          const text = (await getSectionText()).trim()
          if (text === '' || text === previous) return
          previous = text
          const sentenceList = splitSentencesWithOffsets(text)
          sentencesRef.current = sentenceList
          // 新一轮句子计划:提交判据作废,第一帧 applyCharPos 必须落 state,
          // 否则 charPos state 还停留在上一章的位置,is-current 会标错行。
          committedSentenceRef.current = -1
          setSentences(sentenceList)
          setPhase('playing')
          const blocks = splitChapterBlocks(text, sentenceList)
          // 流水线:块 N 播放时后台合成块 N+1(readest 的 preload 思路)。
          // 缓存命中时预取立即返回,重听零等待。
          type Fetch = Promise<{ block: Block; path: string } | null>
          const fetchBlock = async (block: Block): Promise<{ block: Block; path: string }> => {
            const current = settingsRef.current
            const response =
              current.engine === 'edge'
                ? await invokeCommand('tts.edge.audio', {
                    text: block.text,
                    voice: current.narratorEdge,
                    lang: bookLanguage,
                    rate: current.rate,
                  })
                : await invokeCommand('tts.audio', {
                    configId: activeIdRef.current ?? '',
                    text: block.text,
                    voice: current.narratorCloud,
                    speed: current.rate,
                  })
            return { block, path: response.path }
          }
          let prefetch: Fetch | null = null
          // 找到起点块。
          let cursor = locateBlock(blocks, startChar)
          while (cursor !== -1) {
            if (stopFlagRef.current || sectionTokenRef.current !== token) return
            const block = blocks[cursor]!
            const seekRatio = blockSeekRatio(block, startChar)
            applyCharPos(Math.max(block.start, startChar))
            if (settingsRef.current.engine === 'system') {
              await speakSystemBlock(block)
              cursor = locateBlock(blocks, block.start + block.text.length)
              continue
            }
            let attempt = 0
            for (;;) {
              try {
                const fetched = (await (prefetch ?? fetchBlock(block))) ?? (await fetchBlock(block))
                prefetch = null
                if (stopFlagRef.current || sectionTokenRef.current !== token) return
                await playBlockFile(fetched.block, fetched.path, seekRatio)
                break
              } catch (blockError) {
                prefetch = null
                attempt += 1
                if (attempt >= 2 || stopFlagRef.current || sectionTokenRef.current !== token)
                  throw blockError
                // ponytail: 不再等 600ms —— WebSocket 重连由 Rust 端的 retry 兜底,
                // 这里拖一拍只把用户的播放体验拖黑。Edge 抽风再发起一次就好。
              }
            }
            if (stopFlagRef.current || sectionTokenRef.current !== token) return
            const next = locateBlock(blocks, blocks[cursor]!.start + blocks[cursor]!.text.length)
            // 预取下一块:不等它,失败留给播放时重试。
            if (next !== -1) {
              prefetch = fetchBlock(blocks[next]!).catch(() => null)
            }
            cursor = next
            if (cursor === -1) {
              await (prefetch ?? Promise.resolve(null))
              prefetch = null
            }
          }
          if (stopFlagRef.current || sectionTokenRef.current !== token) return
          // 定时"本章结束",或跨章"上一句"只播上一章的尾部。
          if (settingsRef.current.timerKind === 'section' || opts?.stopAtChapterEnd) {
            stop()
            return
          }
          startChar = 0
          if (!settingsRef.current.autoNext) {
            stop()
            return
          }
          if (!(await jumpSection(1))) return
        }
      } catch (runError) {
        if (!stopFlagRef.current && sectionTokenRef.current === token)
          setError(toAppError(runError).message)
      } finally {
        if (sectionTokenRef.current === token) {
          stopFlagRef.current = false
          setPhase('idle')
          setSentences([])
          sentencesRef.current = []
          applyCharPos(0, true)
          clearTimer()
        }
      }
    },
    [
      getSectionText,
      jumpSection,
      armTimer,
      playBlockFile,
      speakSystemBlock,
      stop,
      bookLanguage,
      clearTimer,
      applyCharPos,
    ],
  )

  const play = useCallback((): void => {
    if (phaseRef.current === 'paused') {
      audioRef.current?.play().catch(() => {})
      window.speechSynthesis?.resume()
      setPhase('playing')
      armTimer()
      return
    }
    if (phaseRef.current !== 'idle') return
    void run(0)
  }, [run, armTimer])

  const pause = useCallback((): void => {
    if (phaseRef.current !== 'playing') return
    audioRef.current?.pause()
    window.speechSynthesis?.pause()
    // 强制提交精确位置:暂停后 ticker 停转,进度条/时钟只能靠 state 初值。
    applyCharPos(charPosRef.current, true)
    setPhase('paused')
    clearTimer()
  }, [clearTimer, applyCharPos])

  const toggle = useCallback((): void => {
    if (phaseRef.current === 'playing') pause()
    else play()
  }, [pause, play])

  /** 音色/语速/引擎热切换:软中断当前块,从当前字符位置续播。 */
  useEffect(() => {
    const wasActive = phaseRef.current === 'playing' || phaseRef.current === 'paused'
    const mounted = voiceSettingsProbe.current
    if (!mounted) return
    if (!wasActive) return
    const at = charPosRef.current
    setVoiceSwitching(true)
    sectionTokenRef.current += 1
    stopFlagRef.current = true
    window.speechSynthesis?.cancel()
    releaseAudio()
    const delay = setTimeout(() => {
      setVoiceSwitching(false)
      void run(at)
    }, 80)
    return () => clearTimeout(delay)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings.narratorEdge,
    settings.narratorCloud,
    settings.narratorSystem,
    settings.rate,
    settings.engine,
  ])

  useEffect(() => {
    voiceSettingsProbe.current = true
  }, [])

  /** 主动 ticker:每 60ms 用 audio.currentTime 推 charPos,
   *  比 ontimeupdate 的 ~250ms 浏览器默认频率快 4 倍,
   *  句级高亮跟手更紧。playingRef 由 playBlockFile 设置/清除。
   *  tick 内不碰 React 状态:进度条/时钟走 paintCharPos 直写,
   *  只有跨句时 applyCharPos 才提交一次 state。 */
  useEffect(() => {
    const tick = setInterval(() => {
      const playing = playingRef.current
      const audio = audioRef.current
      if (!playing || !audio || audio.paused) return
      if (audio.duration <= 0) return
      const ratio = audio.currentTime / audio.duration
      applyCharPos(
        playing.block.start +
          Math.min(playing.block.text.length, Math.round(ratio * playing.block.text.length)),
      )
    }, 60)
    return () => clearInterval(tick)
  }, [applyCharPos])

  const totalChars = useMemo(() => sumChars(sentences), [sentences])

  /** 当前句:charPos 落在哪句区间。 */
  const sentenceIndex = useMemo(() => sentenceIndexAt(sentences, charPos), [sentences, charPos])

  /** TTS 句级高亮广播:每次切句或高亮档/色变化时,把当前句的字符区间
   *  发给父层。关档或暂停时传 null,让父层把上一条高亮清掉。 */
  useEffect(() => {
    if (phase !== 'playing' || sentences.length === 0) {
      onHighlight?.(null)
      return
    }
    const sentence = sentences[sentenceIndex]
    if (!sentence) return
    if (settings.highlightMode === 'off') {
      onHighlight?.(null)
      return
    }
    onHighlight?.({
      mode: settings.highlightMode,
      start: sentence.start,
      end: sentence.start + sentence.text.length,
      color: settings.highlightColor,
    })
    // 卸载/暂停时清掉:这一帧的 unmount cleanup 由父层兜底(onHighlight(null))。
    return () => {
      onHighlight?.(null)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sentenceIndex, sentences, phase, settings.highlightMode, settings.highlightColor])

  /** 跳到某句:换算块与块内比例,由 run 的 seek 语义落到正确音频位置。 */
  const seekToChar = useCallback(
    (target: number): void => {
      if (phaseRef.current === 'idle') return
      const audio = audioRef.current
      const list = sentencesRef.current
      // 优先:目标就在当前音频对应的块内,直接 currentTime 精确 seek。
      // 块边界未知于 UI 层,统一走重载路径:token 中断 + run(目标位置)。
      if (audio && !audio.paused) {
        // 粗判:目标位置仍在当前句块内时也可跳,但块信息不在 UI;重载即合成缓存命中(同文本同音色同语速),代价是秒级。
      }
      sectionTokenRef.current += 1
      stopFlagRef.current = true
      window.speechSynthesis?.cancel()
      releaseAudio()
      setPhase('loading')
      setTimeout(() => {
        void run(Math.max(0, Math.min(target, totalChars > 0 ? totalChars - 1 : target)))
      }, 60)
      void list
    },
    [run, totalChars, releaseAudio],
  )

  /** 句子行的 seek 走稳定引用:行已 memo 化,onClick 每渲染换新会整体失效。 */
  const seekSentence = useCallback((start: number): void => seekToChar(start), [seekToChar])

  const jumpSentences = useCallback(
    (delta: number): void => {
      if (phaseRef.current === 'idle') return
      const target = sentenceIndex + delta
      if (target < 0) {
        void jumpSection(-1).then((moved) => {
          if (moved) {
            sectionTokenRef.current += 1
            stopFlagRef.current = true
            window.speechSynthesis?.cancel()
            audioRef.current?.pause()
            setPhase('loading')
            setTimeout(
              () => void run(Number.MAX_SAFE_INTEGER / 2 - 1, { stopAtChapterEnd: true }),
              60,
            )
          }
        })
        return
      }
      const sentence = sentences[target]
      if (sentence) seekToChar(sentence.start)
    },
    [sentenceIndex, sentences, jumpSection, run, seekToChar],
  )

  const changeSection = useCallback(
    (delta: number): void => {
      const wasActive = phaseRef.current !== 'idle'
      stop()
      void jumpSection(delta).then((moved) => {
        if (moved && wasActive) void run(0)
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
  }, [sentenceIndex, sentences.length])

  const sentenceProgress = totalChars > 0 ? Math.min(1, charPos / totalChars) : 0
  const cps = CHARS_PER_SECOND * settings.rate
  const elapsed = totalChars > 0 ? charPos / cps : 0
  const remaining = totalChars > 0 ? (totalChars - charPos) / cps : 0

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
          <img src={coverUrl} alt="" className="tts-mini-cover" />
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
            {phase === 'loading' ? (
              <div className="tts-loading" aria-label="正在合成语音">
                <div className="tts-loading-wave" aria-hidden>
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <span className="tts-loading-label">正在合成整章语音…</span>
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
                    start={sentence.start}
                    current={index === sentenceIndex}
                    past={index < sentenceIndex}
                    onSeek={seekSentence}
                  />
                ))}
              </ol>
            )}
            {voiceSwitching && (
              <span className="tts-switching" aria-hidden>
                <SpinnerBall size={16} weight="bold" /> 切换音色中
                <span className="tts-switching-dots">
                  <span />
                  <span />
                  <span />
                </span>
              </span>
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
                        : '按词高亮(下一版接入,目前与句级一致)'
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
