import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, Stop, Users, X } from '@phosphor-icons/react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { toAppError, type AiProviderConfig } from '@deepread/shared'
import { buildCharactersMessages, parseCharacters } from '@deepread/ai-core'
import { buildSpeechSegments, type SpeechSegment } from '@deepread/reader-core'
import { invokeCommand } from '../../lib/ipc'
import { runChatOnce } from '../../lib/ai-chat'

const CLOUD_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const
const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2] as const
const TIMER_OPTIONS: readonly { readonly label: string; readonly minutes: number }[] = [
  { label: '关闭', minutes: 0 },
  { label: '30 分钟', minutes: 30 },
  { label: '60 分钟', minutes: 60 },
  { label: '90 分钟', minutes: 90 },
]
const PITCH_OPTIONS: readonly { readonly label: string; readonly value: number }[] = [
  { label: '低', value: 0.8 },
  { label: '中', value: 1 },
  { label: '高', value: 1.3 },
]
const MAX_BATCH_CHARS = 800

/** Per-character voice assignment (spec §45), persisted per book. */
interface TtsCastEntry {
  readonly name: string
  readonly systemVoice?: string
  readonly cloudVoice?: string
  readonly pitch: number
}

interface TtsSettings {
  engine: 'system' | 'cloud'
  rate: number
  timerMinutes: number
  narratorSystem?: string
  narratorCloud: string
  multiChar: boolean
}

const SETTINGS_KEY = 'deepread.tts.settings'

const DEFAULT_SETTINGS: TtsSettings = {
  engine: 'system',
  rate: 1,
  timerMinutes: 0,
  narratorCloud: 'alloy',
  multiChar: false,
}

interface TtsDrawerProps {
  readonly bookHash: string
  readonly bookTitle: string
  /** Plain text of the section currently on screen. */
  readonly getSectionText: () => Promise<string>
  /** Move the view to the next section; resolves false at the book's end. */
  readonly advanceSection: () => Promise<boolean>
  readonly onClose: () => void
}

type Phase = 'idle' | 'playing' | 'paused'

/** Merge consecutive same-speaker segments so cloud TTS needs fewer calls. */
function batchSegments(segments: readonly SpeechSegment[], multiChar: boolean): SpeechSegment[] {
  const batches: SpeechSegment[] = []
  for (const segment of segments) {
    const speaker = multiChar ? segment.speaker : 'narrator'
    const last = batches[batches.length - 1]
    if (
      last &&
      last.speaker === speaker &&
      last.text.length + segment.text.length <= MAX_BATCH_CHARS
    ) {
      batches[batches.length - 1] = { speaker, text: last.text + segment.text }
    } else {
      batches.push({ speaker, text: segment.text })
    }
  }
  return batches
}

export function TtsDrawer({
  bookHash,
  bookTitle,
  getSectionText,
  advanceSection,
  onClose,
}: TtsDrawerProps) {
  const castKey = `deepread.tts.cast.${bookHash}`
  const [settings, setSettings] = useState<TtsSettings>(() => {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY)
      return stored
        ? { ...DEFAULT_SETTINGS, ...(JSON.parse(stored) as TtsSettings) }
        : DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  })
  const [cast, setCast] = useState<readonly TtsCastEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(castKey) ?? '[]') as TtsCastEntry[]
    } catch {
      return []
    }
  })
  const [voices, setVoices] = useState<readonly SpeechSynthesisVoice[]>([])
  const [providers, setProviders] = useState<readonly AiProviderConfig[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [currentText, setCurrentText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)

  const stopFlagRef = useRef(false)
  const cancelAudioRef = useRef<(() => void) | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The playback loop outlives renders; it reads live values from mirrors.
  const settingsRef = useRef(settings)
  const castRef = useRef(cast)
  const voicesRef = useRef(voices)
  const activeIdRef = useRef(activeId)

  useEffect(() => {
    settingsRef.current = settings
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])
  useEffect(() => {
    castRef.current = cast
    localStorage.setItem(castKey, JSON.stringify(cast))
  }, [cast, castKey])
  useEffect(() => {
    voicesRef.current = voices
  }, [voices])
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

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
        setProviders(response.providers)
        setActiveId((current) => current ?? response.providers[0]?.id ?? null)
      })
      .catch(() => {
        // Cloud engine is optional; the error surfaces if the user selects it.
      })
  }, [])

  const stop = useCallback((): void => {
    stopFlagRef.current = true
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    window.speechSynthesis?.cancel()
    cancelAudioRef.current?.()
    audioRef.current?.pause()
    audioRef.current = null
    setPhase('idle')
    setCurrentText(null)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      stop()
      window.speechSynthesis?.cancel()
    }
  }, [onClose, stop])

  const speakSystem = (
    text: string,
    voice: SpeechSynthesisVoice | undefined,
    rate: number,
    pitch: number,
  ) =>
    new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text)
      if (voice) utterance.voice = voice
      utterance.rate = rate
      utterance.pitch = pitch
      utterance.onend = () => resolve()
      utterance.onerror = (event) => {
        // 'interrupted'/'canceled' are how stop() cuts an utterance short.
        if (event.error === 'interrupted' || event.error === 'canceled') resolve()
        else reject(new Error(`系统语音合成失败(${event.error})`))
      }
      window.speechSynthesis.speak(utterance)
    })

  const speakCloud = async (
    text: string,
    voice: string,
    rate: number,
    configId: string,
  ): Promise<void> => {
    const response = await invokeCommand('tts.audio', { configId, text, voice, speed: rate })
    const audio = new Audio(convertFileSrc(response.path))
    audioRef.current = audio
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      cancelAudioRef.current = settle
      audio.onended = settle
      audio.onerror = () => {
        settled = true
        reject(new Error('音频播放失败'))
      }
      void audio.play().catch((reason: unknown) => {
        if (!settled) {
          settled = true
          reject(reason instanceof Error ? reason : new Error('音频播放失败'))
        }
      })
    })
  }

  const voiceForSpeaker = (
    speaker: string,
  ): { systemVoice?: string; cloudVoice: string; pitch: number } => {
    if (settingsRef.current.multiChar && speaker !== 'narrator') {
      const entry = castRef.current.find((item) => item.name === speaker)
      if (entry) {
        return {
          systemVoice: entry.systemVoice,
          cloudVoice: entry.cloudVoice ?? settingsRef.current.narratorCloud,
          pitch: entry.pitch,
        }
      }
    }
    return {
      systemVoice: settingsRef.current.narratorSystem,
      cloudVoice: settingsRef.current.narratorCloud,
      pitch: 1,
    }
  }

  const speakBatch = async (batch: SpeechSegment): Promise<void> => {
    const current = settingsRef.current
    const assignment = voiceForSpeaker(batch.speaker)
    if (current.engine === 'cloud') {
      const configId = activeIdRef.current
      if (!configId) throw new Error('请先选择一个已配置的语音服务')
      await speakCloud(batch.text, assignment.cloudVoice, current.rate, configId)
    } else {
      if (!('speechSynthesis' in window)) throw new Error('当前环境不支持系统语音')
      const voice = voicesRef.current.find((item) => item.voiceURI === assignment.systemVoice)
      await speakSystem(batch.text, voice, current.rate, assignment.pitch)
    }
  }

  const armTimer = (): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const minutes = settingsRef.current.timerMinutes
    if (minutes > 0) timerRef.current = setTimeout(() => stop(), minutes * 60 * 1000)
  }

  const pause = (): void => {
    if (phase !== 'playing') return
    if (settingsRef.current.engine === 'cloud') audioRef.current?.pause()
    else window.speechSynthesis?.pause()
    setPhase('paused')
  }

  const resume = (): void => {
    if (phase !== 'paused') return
    if (settingsRef.current.engine === 'cloud') void audioRef.current?.play()
    else window.speechSynthesis?.resume()
    setPhase('playing')
  }

  const run = useCallback(async (): Promise<void> => {
    if (phase !== 'idle') return
    // ponytail: 听书的跨重启断点续播留到云端同步阶段;本次会话内暂停/继续可用。
    stopFlagRef.current = false
    setPhase('playing')
    setError(null)
    setCurrentText(null)
    armTimer()
    try {
      let previous = ''
      for (;;) {
        if (stopFlagRef.current) return
        const text = (await getSectionText()).trim()
        // Empty section, or the advance landed nowhere new (book end).
        if (text === '' || text === previous) return
        previous = text
        const multiChar = settingsRef.current.multiChar
        const batches = batchSegments(
          buildSpeechSegments(text, multiChar ? castRef.current.map((entry) => entry.name) : []),
          multiChar,
        )
        for (const batch of batches) {
          if (stopFlagRef.current) return
          setCurrentText(batch.text)
          await speakBatch(batch)
        }
        if (!(await advanceSection())) return
      }
    } catch (runError) {
      if (!stopFlagRef.current) setError(toAppError(runError).message)
    } finally {
      stopFlagRef.current = false
      setPhase('idle')
      setCurrentText(null)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getSectionText, advanceSection, phase])

  const detectCharacters = useCallback(async (): Promise<void> => {
    const configId = activeId
    if (!configId) {
      setError('请先在 AI 助手中配置服务,才能自动识别角色。')
      return
    }
    setDetecting(true)
    setError(null)
    try {
      const text = (await getSectionText()).slice(0, 3000)
      const raw = await runChatOnce(
        configId,
        buildCharactersMessages([{ label: '当前章节', text }], bookTitle),
      )
      const parsed = parseCharacters(raw)
      setCast((current) => {
        const known = new Map(current.map((entry) => [entry.name, entry]))
        return parsed.characters.map((character): TtsCastEntry => ({
          pitch: 1,
          ...known.get(character.name),
          name: character.name,
        }))
      })
    } catch (detectError) {
      setError(toAppError(detectError).message)
    } finally {
      setDetecting(false)
    }
  }, [activeId, bookTitle, getSectionText])

  const updateCast = (name: string, patch: Partial<TtsCastEntry>): void => {
    setCast((current) =>
      current.map((entry) => (entry.name === name ? { ...entry, ...patch } : entry)),
    )
  }

  return (
    <aside className="ai-drawer tts-drawer" aria-label="朗读">
      <div className="lookup-head">
        <strong>朗读</strong>
        <div className="ai-head-actions">
          {settings.engine === 'cloud' && (
            <select
              className="ai-provider-select"
              value={activeId ?? ''}
              onChange={(event) => setActiveId(event.target.value)}
              aria-label="语音服务"
            >
              {providers.length === 0 && <option value="">未配置服务</option>}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="chrome-button" onClick={onClose} title="关闭">
            <X size={16} weight="regular" aria-hidden />
          </button>
        </div>
      </div>

      <div className="ai-drawer-body">
        <div className="settings-row">
          <span className="settings-label">引擎</span>
          <div className="segmented">
            <button
              type="button"
              className={settings.engine === 'system' ? 'is-active' : ''}
              onClick={() => setSettings((current) => ({ ...current, engine: 'system' }))}
            >
              系统语音
            </button>
            <button
              type="button"
              className={settings.engine === 'cloud' ? 'is-active' : ''}
              onClick={() => setSettings((current) => ({ ...current, engine: 'cloud' }))}
            >
              云端语音
            </button>
          </div>
        </div>

        {settings.engine === 'system' && voices.length === 0 && (
          <p className="ai-privacy">系统语音列表为空或仍在加载;若一直为空,请改用云端语音。</p>
        )}

        <div className="settings-row">
          <span className="settings-label">声音</span>
          {settings.engine === 'system' ? (
            <select
              className="ai-provider-select"
              value={settings.narratorSystem ?? ''}
              onChange={(event) =>
                setSettings((current) => ({ ...current, narratorSystem: event.target.value }))
              }
              aria-label="叙述者声音"
            >
              <option value="">默认</option>
              {voices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name}({voice.lang})
                </option>
              ))}
            </select>
          ) : (
            <select
              className="ai-provider-select"
              value={settings.narratorCloud}
              onChange={(event) =>
                setSettings((current) => ({ ...current, narratorCloud: event.target.value }))
              }
              aria-label="云端声音"
            >
              {CLOUD_VOICES.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="settings-row">
          <span className="settings-label">语速</span>
          <div className="segmented">
            {RATE_OPTIONS.map((rate) => (
              <button
                key={rate}
                type="button"
                className={settings.rate === rate ? 'is-active' : ''}
                onClick={() => setSettings((current) => ({ ...current, rate }))}
              >
                {rate}×
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <span className="settings-label">定时停止</span>
          <div className="segmented">
            {TIMER_OPTIONS.map((option) => (
              <button
                key={option.minutes}
                type="button"
                className={settings.timerMinutes === option.minutes ? 'is-active' : ''}
                onClick={() =>
                  setSettings((current) => ({ ...current, timerMinutes: option.minutes }))
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <span className="settings-label">多角色</span>
          <div className="segmented">
            <button
              type="button"
              className={!settings.multiChar ? 'is-active' : ''}
              onClick={() => setSettings((current) => ({ ...current, multiChar: false }))}
            >
              关
            </button>
            <button
              type="button"
              className={settings.multiChar ? 'is-active' : ''}
              onClick={() => setSettings((current) => ({ ...current, multiChar: true }))}
            >
              开
            </button>
          </div>
          <button
            type="button"
            className="chrome-button"
            onClick={() => void detectCharacters()}
            disabled={detecting}
            title="AI 识别本段角色并分配声音"
          >
            <Users size={14} weight="regular" aria-hidden />
            {detecting ? '识别中…' : '识别角色'}
          </button>
        </div>

        {settings.multiChar &&
          cast.map((entry) => (
            <div key={entry.name} className="settings-row voice-row">
              <span className="settings-label">{entry.name}</span>
              {settings.engine === 'system' ? (
                <select
                  className="ai-provider-select"
                  value={entry.systemVoice ?? ''}
                  onChange={(event) => updateCast(entry.name, { systemVoice: event.target.value })}
                  aria-label={`${entry.name} 的声音`}
                >
                  <option value="">跟随叙述者</option>
                  {voices.map((voice) => (
                    <option key={voice.voiceURI} value={voice.voiceURI}>
                      {voice.name}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  className="ai-provider-select"
                  value={entry.cloudVoice ?? ''}
                  onChange={(event) => updateCast(entry.name, { cloudVoice: event.target.value })}
                  aria-label={`${entry.name} 的声音`}
                >
                  <option value="">跟随叙述者</option>
                  {CLOUD_VOICES.map((voice) => (
                    <option key={voice} value={voice}>
                      {voice}
                    </option>
                  ))}
                </select>
              )}
              <div className="segmented">
                {PITCH_OPTIONS.map((pitch) => (
                  <button
                    key={pitch.value}
                    type="button"
                    className={entry.pitch === pitch.value ? 'is-active' : ''}
                    onClick={() => updateCast(entry.name, { pitch: pitch.value })}
                  >
                    {pitch.label}
                  </button>
                ))}
              </div>
            </div>
          ))}

        <div className="tts-controls">
          {phase === 'playing' ? (
            <button type="button" className="chrome-button" onClick={pause} title="暂停">
              <Pause size={18} weight="regular" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className="chrome-button"
              onClick={() => (phase === 'paused' ? resume() : void run())}
              title={phase === 'paused' ? '继续' : '从当前章开始朗读'}
            >
              <Play size={18} weight="regular" aria-hidden />
            </button>
          )}
          <button
            type="button"
            className="chrome-button"
            onClick={stop}
            disabled={phase === 'idle'}
            title="停止"
          >
            <Stop size={18} weight="regular" aria-hidden />
          </button>
          <span className="tts-status">
            {phase === 'playing' ? '朗读中' : phase === 'paused' ? '已暂停' : '待机'}
          </span>
        </div>

        {currentText !== null && <p className="tts-now">{currentText}</p>}
        {error !== null && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}
        <p className="ai-privacy">云端语音按段缓存到本地,重复收听不再消耗配额。</p>
      </div>
    </aside>
  )
}
