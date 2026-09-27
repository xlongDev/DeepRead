import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaretDown,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretLeft,
  CaretRight,
  Check,
  Pause,
  Play,
  SpinnerBall,
  X,
} from '@phosphor-icons/react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { toAppError, type AiProviderConfig } from '@deepread/shared'
import { splitSentences } from '@deepread/reader-core'
import { invokeCommand } from '../../lib/ipc'
import { DropdownMenu } from '../../components/DropdownMenu'

type Engine = 'edge' | 'system' | 'cloud'

const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const
const ENGINE_LABELS: Readonly<Record<Engine, string>> = {
  edge: 'Edge 语音',
  system: '系统语音',
  cloud: '云端语音',
}
/** 中文语速基线:每秒约 4.2 字,用于时间估算。 */
const CHARS_PER_SECOND = 4.2
/** 合成块大小:约 2-4 句。小块首响快(1-3 秒),配合预取无缝衔接——
 * 参考 readest 的按句流水线,整章一次合成要等几十秒。 */
const MAX_SYNTH_CHARS = 300

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
}

const DEFAULT_SETTINGS: TtsSettings = {
  engine: 'edge',
  rate: 1,
  autoNext: true,
  timerKind: 'off',
  timerMinutes: 30,
  narratorEdge: 'zh-CN-XiaoxiaoNeural',
  narratorCloud: 'alloy',
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
  /** 展开回完整播放器。 */
  readonly onExpand: () => void
  /** 收起为迷你播放条。 */
  readonly onMinimize: () => void
  /** 完全关闭(停止播放)。 */
  readonly onClose: () => void
}

type Phase = 'idle' | 'loading' | 'playing' | 'paused'

interface Sentence {
  readonly text: string
  /** 全章字符起点。 */
  readonly start: number
}

interface Block {
  readonly text: string
  readonly start: number
}

/** 按句边界把整章切成 ≤max 的合成块,块与块的语音首尾相接。 */
function splitChapterBlocks(text: string, max = MAX_SYNTH_CHARS): Block[] {
  const sentences = splitSentences(text)
  const blocks: Block[] = []
  let current = ''
  let currentStart = 0
  let cursor = 0
  for (const sentence of sentences) {
    if (current.length + sentence.length > max && current.length > 0) {
      blocks.push({ text: current, start: currentStart })
      current = sentence
      currentStart = cursor
    } else {
      if (current.length === 0) currentStart = cursor
      current += sentence
    }
    cursor += sentence.length
  }
  if (current.length > 0) blocks.push({ text: current, start: currentStart })
  return blocks
}

/** 优先保留与书同语言的语音;同语言不足两条时回退全部。 */
function voicesForLanguage<T extends { lang: string }>(
  voices: readonly T[],
  language: string | undefined,
): readonly T[] {
  if (!language) return voices
  const prefix = language.slice(0, 2).toLowerCase()
  const matched = voices.filter((voice) =>
    voice.lang.toLowerCase().replace('_', '-').startsWith(prefix),
  )
  return matched.length >= 2 ? matched : voices
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(safe / 60)
  const rest = safe % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

export function TtsDrawer({
  bookTitle,
  bookLanguage,
  coverUrl,
  sectionLabel,
  minimized,
  onPlayingChange,
  getSectionText,
  jumpSection,
  onExpand,
  onMinimize,
  onClose,
}: TtsDrawerProps) {
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
    charPosRef.current = charPos
  }, [charPos])
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
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.removeAttribute('src')
        audioRef.current = null
      }
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    window.speechSynthesis?.cancel()
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current = null
    }
    setPhase('idle')
    setSentences([])
    sentencesRef.current = []
    setCharPos(0)
    charPosRef.current = 0
  }, [])

  const armTimer = useCallback((): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const { timerKind, timerMinutes } = settingsRef.current
    if (timerKind === 'minutes' && timerMinutes > 0) {
      timerRef.current = setTimeout(() => stop(), timerMinutes * 60 * 1000)
    }
    // section/book 模式在章循环结束处检查。
  }, [stop])

  /** 播放已合成的块文件;onTime 持续回报全章字符位置。resolve 于自然播完。 */
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
        audio.ontimeupdate = () => {
          if (audio.duration > 0) {
            const ratio = audio.currentTime / audio.duration
            setCharPos(block.start + Math.round(ratio * block.text.length))
          }
        }
        audio.onended = settle
        audio.onerror = () => {
          if (!settled) {
            settled = true
            reject(new Error('音频播放失败'))
          }
        }
        if (seekRatio > 0) {
          audio.onloadedmetadata = () => {
            audio.currentTime = seekRatio * (audio.duration || 0)
          }
        }
        void audio.play().catch((reason: unknown) => {
          if (!settled) {
            settled = true
            reject(reason instanceof Error ? reason : new Error('音频播放失败'))
          }
        })
      })
      setCharPos(block.start + block.text.length)
    },
    [],
  )

  /** 系统引擎:整块 utterance + 估算时钟推进字符位置。 */
  const speakSystemBlock = useCallback(async (block: Block): Promise<void> => {
    if (!('speechSynthesis' in window)) throw new Error('当前环境不支持系统语音')
    const current = settingsRef.current
    const voice = voicesRef.current.find((item) => item.voiceURI === current.narratorSystem)
    const chars = block.text.length
    const perChar = 1000 / (CHARS_PER_SECOND * current.rate)
    let elapsed = 0
    const step = 100
    const clock = setInterval(() => {
      if (stopFlagRef.current) return
      elapsed += step
      setCharPos(block.start + Math.min(chars, Math.round(elapsed / perChar)))
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
    setCharPos(block.start + chars)
  }, [])

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
          let sentenceCursor = 0
          const sentenceList = splitSentences(text).map((sentence) => {
            const entry = { text: sentence, start: sentenceCursor }
            sentenceCursor += sentence.length
            return entry
          })
          sentencesRef.current = sentenceList
          setSentences(sentenceList)
          setPhase('playing')
          const blocks = splitChapterBlocks(text)
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
          const nextIndexAfter = (from: number): number => {
            for (let i = from + 1; i < blocks.length; i++) {
              if (blocks[i]!.start + blocks[i]!.text.length > startChar) return i
            }
            return -1
          }
          // 找到起点块。
          let cursor = -1
          for (let i = 0; i < blocks.length; i++) {
            if (blocks[i]!.start + blocks[i]!.text.length > startChar) {
              cursor = i
              break
            }
          }
          while (cursor !== -1) {
            if (stopFlagRef.current || sectionTokenRef.current !== token) return
            const block = blocks[cursor]!
            const seekRatio =
              block.start < startChar ? (startChar - block.start) / block.text.length : 0
            setCharPos(Math.max(block.start, startChar))
            if (settingsRef.current.engine === 'system') {
              await speakSystemBlock(block)
              cursor = nextIndexAfter(cursor)
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
                // 连接中断:换新连接重试一次当前块。
                await new Promise((resolve) => setTimeout(resolve, 600))
              }
            }
            if (stopFlagRef.current || sectionTokenRef.current !== token) return
            const next = nextIndexAfter(cursor)
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
          setCharPos(0)
          charPosRef.current = 0
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
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
    setPhase('paused')
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

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
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current = null
    }
    const delay = setTimeout(() => {
      setVoiceSwitching(false)
      void run(at)
    }, 80)
    return () => clearTimeout(delay)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.narratorEdge, settings.narratorCloud, settings.narratorSystem, settings.rate, settings.engine])

  useEffect(() => {
    voiceSettingsProbe.current = true
  }, [])

  const totalChars = useMemo(
    () => sentences.reduce((sum, sentence) => sum + sentence.text.length, 0),
    [sentences],
  )

  /** 当前句:charPos 落在哪句区间。 */
  const sentenceIndex = useMemo(() => {
    let index = 0
    for (const sentence of sentences) {
      if (sentence.start > charPos) break
      index += 1
    }
    return Math.max(0, index - 1)
  }, [sentences, charPos])

  /** 跳到某句:换算块与块内比例,由 run 的 seek 语义落到正确音频位置。 */
  const seekToChar = useCallback((target: number): void => {
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
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audioRef.current = null
    }
    setPhase('loading')
    setTimeout(() => {
      void run(Math.max(0, Math.min(target, totalChars > 0 ? totalChars - 1 : target)))
    }, 60)
    void list
  }, [run, totalChars])

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
            setTimeout(() => void run(Number.MAX_SAFE_INTEGER / 2 - 1, { stopAtChapterEnd: true }), 60)
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
                <div className="tts-loading-bar" />
                <div className="tts-loading-bar short" />
                <span className="tts-loading-label">正在合成整章语音…</span>
              </div>
            ) : sentences.length === 0 ? (
              <p className="tts-sentence-text is-idle">
                {phase === 'idle' ? '待机' : '正在加载章节…'}
              </p>
            ) : (
              <ol className="tts-sentence-list" ref={sentenceListRef}>
                {sentences.map((sentence, index) => (
                  <li key={sentence.start}>
                    <button
                      type="button"
                      className={`tts-sentence-item${index === sentenceIndex ? ' is-current' : ''}${
                        index < sentenceIndex ? ' is-past' : ''
                      }`}
                      onClick={() => seekToChar(sentence.start)}
                      aria-current={index === sentenceIndex}
                    >
                      {sentence.text}
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {voiceSwitching && (
              <span className="tts-switching" aria-hidden>
                <SpinnerBall size={16} weight="bold" /> 切换音色中…
              </span>
            )}
          </div>

          <div className="tts-progress">
            <span className="tts-clock">{formatClock(elapsed)}</span>
            <input
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
            <span className="tts-clock">-{formatClock(remaining)}</span>
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
            <button
              type="button"
              className="tts-card"
              onClick={() => {
                const index = RATE_OPTIONS.indexOf(settings.rate as (typeof RATE_OPTIONS)[number])
                const next = RATE_OPTIONS[(index + 1) % RATE_OPTIONS.length] ?? 1
                setSettings((current) => ({ ...current, rate: next }))
              }}
            >
              <span className="tts-card-value">{settings.rate}×</span>
              <span className="tts-card-label">语速</span>
            </button>
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
                if (kind !== 'minutes' && timerRef.current) {
                  clearTimeout(timerRef.current)
                  timerRef.current = null
                }
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

          <button
            type="button"
            className={`stats-toggle tts-auto-next${settings.autoNext ? ' is-on' : ''}`}
            role="switch"
            aria-checked={settings.autoNext}
            onClick={() =>
              setSettings((current) => ({ ...current, autoNext: !current.autoNext }))
            }
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
}
