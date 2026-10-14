/**
 * Read-aloud over three engines, behind one set of calls (ported from
 * ColorReader's `useTts`).
 *
 * The platform's `speechSynthesis` owns its own queue, so one utterance per
 * unit keeps the visible progress in step with the voice, and `cancel()` tears
 * the whole thing down in one call. Its quirks are handled here: a generation
 * counter guards against a platform that still fires `onend` for a cancelled
 * utterance — a late event from an abandoned queue must not restart the reader.
 *
 * Edge and cloud are a different shape entirely (one request per utterance,
 * scheduled ahead in `clipEngine.ts`), but the reader must not be able to tell:
 * all three are driven through the same calls, and the engine in force is the
 * only thing that says which one answers.
 *
 * The reader's speed does not reach edge or cloud: every clip is synthesised
 * once at 1.0 and stretched on its way to the speaker, so a rate change costs
 * no request. The system engine applies the rate natively.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { SpeechBoundary, SpeechStatus, SpeechUnit } from '@deepread/reader-core'
import { createCloudEngine, createEdgeEngine, type ClipEngine } from './clipEngine'

/** Which engine speaks. Mirrors the drawer's engine setting. */
export type SpeechEngine = 'edge' | 'system' | 'cloud'

export type { SpeechBoundary, SpeechStatus, SpeechUnit }

type Options = {
  /** Whether the word-level wash is watching. Both engines report the voice's
   *  position from the first word either way — that is what a settings change
   *  restarts the utterance from — but only a watcher is worth re-rendering the
   *  reader per word, so this gates what is published as state. */
  trackBoundary?: boolean
  /** The book's language (BCP-47), sent with every edge request. */
  lang?: string
  /** The cloud provider's config id, read at play time. */
  cloudConfigId?: string | null
}

/** How long a fresh utterance may stay silent about its position before the
 *  engine gives up on it reporting one. A voice that reports boundaries does
 *  so within a frame or two of speaking, so anything still quiet when this
 *  fires reports none at all — Chinese system voices are the usual case. */
const BLIND_BOUNDARY_MS = 500

/** `speechSynthesis` republishes its list asynchronously, and hands back a fresh
 *  array on every call — so the snapshot is cached and only replaced when the
 *  list's length changes. */
const subscribeVoices = (onChange: () => void) => {
  const synth = window.speechSynthesis
  if (!synth) return () => {}
  synth.addEventListener('voiceschanged', onChange)
  return () => synth.removeEventListener('voiceschanged', onChange)
}

let voiceSnapshot: SpeechSynthesisVoice[] = []
let voiceCount = 0

const snapshotVoices = (): SpeechSynthesisVoice[] => {
  const list = window.speechSynthesis?.getVoices() ?? []
  if (list.length !== voiceCount) {
    voiceCount = list.length
    voiceSnapshot = list
  }
  return voiceSnapshot
}

/** Every voice the platform itself offers, re-read whenever it republishes. */
export function useSystemVoices(): SpeechSynthesisVoice[] {
  return useSyncExternalStore(subscribeVoices, snapshotVoices)
}

/** The platform object to hand to an utterance. The picker stores a URI, and
 *  the system list is what the engine actually accepts, so the URI is resolved
 *  at speak time; with nothing stored the platform default applies. */
function resolveVoice(
  system: readonly SpeechSynthesisVoice[],
  uri: string | null,
): SpeechSynthesisVoice | null {
  if (!uri) return null
  return system.find((voice) => voice.voiceURI === uri) ?? null
}

export function useTts({ trackBoundary = false, lang, cloudConfigId }: Options = {}) {
  const [status, setStatus] = useState<SpeechStatus>('idle')
  const [unit, setUnit] = useState<number | null>(null)
  const [boundary, setBoundary] = useState<SpeechBoundary | null>(null)
  /** Set when a provider could not be reached; the player says so rather than
   *  going quiet for no visible reason. */
  const [error, setError] = useState<string | null>(null)
  /** True while a network engine is waiting on a clip it does not have cached —
   *  the gap between asking to speak and hearing anything. The platform engine
   *  starts instantly, so it never raises this. */
  const [loading, setLoading] = useState(false)
  const system = useSystemVoices()

  // Speaks only while `generation` matches: every play/stop bumps it.
  const generation = useRef(0)
  /** True once a voice has failed to report a boundary in time, i.e. it does
   *  not report them at all. Later utterances then hand the whole text over
   *  straight away rather than leaving the wash blank while a timer runs. */
  const blind = useRef(false)
  /** Where the voice last said it was. Kept whether or not the word-level wash
   *  is listening: the reader can ask for words mid-sentence, and a rate or a
   *  voice change restarts the utterance from where the voice has got to. */
  const lastBoundary = useRef<SpeechBoundary | null>(null)
  const rate = useRef(1)
  /** The engine in force, and the narrator's voice id for it. */
  const engine = useRef<SpeechEngine>('edge')
  const voice = useRef<string | null>(null)
  /** Speaker → voice id for the engine in force (the multi-character cast). */
  const voiceOf = useRef<((speaker: string) => string | null) | undefined>(undefined)
  // Read from inside `speak`, which is created once per session.
  const trackBoundaryRef = useRef(trackBoundary)
  const edgeRef = useRef<ClipEngine | null>(null)
  const cloudRef = useRef<ClipEngine | null>(null)
  /** The config id the cloud engine was built with, so a provider switch
   *  rebuilds it rather than synthesising through the old one. */
  const cloudIdRef = useRef<string | null>(null)
  /** The queue the engines are walking, so a voice change can re-resolve a
   *  unit's speaker without the reader handing it over again. */
  const unitsRef = useRef<readonly SpeechUnit[]>([])
  const langRef = useRef(lang)
  const cloudConfigIdRef = useRef(cloudConfigId)

  useEffect(() => {
    // Only flips the switch: both engines report the voice's position from the
    // first word regardless, so asking for the word-level wash mid-utterance is
    // answered by the next report.
    trackBoundaryRef.current = trackBoundary
  }, [trackBoundary])

  useEffect(() => {
    langRef.current = lang
    cloudConfigIdRef.current = cloudConfigId
  }, [lang, cloudConfigId])

  useEffect(() => {
    // The *app* going away must not leave a voice behind. Deliberately not "the
    // reader going away": the session outlives that page while the player is
    // mounted in the shell. `speechSynthesis` is absent where the app runs
    // without a browser speech API — jsdom — and the teardown has to survive it.
    return () => {
      window.speechSynthesis?.cancel()
      edgeRef.current?.stop()
      cloudRef.current?.stop()
    }
  }, [])

  const stop = useCallback(() => {
    generation.current += 1
    window.speechSynthesis?.cancel()
    edgeRef.current?.stop()
    cloudRef.current?.stop()
    // The failure text belongs to the session stop ends: the pill is drawn
    // while `status !== "idle" || error !== null`, so leaving it set made the
    // close button dead exactly when the engine had failed — the one state a
    // reader most needs it in.
    setError(null)
    setStatus('idle')
    setUnit(null)
    setLoading(false)
    lastBoundary.current = null
    setBoundary(null)
  }, [])

  /** The two network engines, built on first use. Constructed inside a call
   *  rather than during render so the hook's own callbacks keep a stable
   *  identity. */
  const edgeEngine = useCallback((): ClipEngine => {
    edgeRef.current ??= createEdgeEngine(
      {
        status: setStatus,
        unit: setUnit,
        loading: setLoading,
        // Recorded whether or not the wash is watching words, and published
        // only when it is: a settings change restarts the utterance from here
        // (see `boundaryAt`), while an unwatched `setBoundary` per word would
        // re-render the reader for nothing.
        boundary: (spot) => {
          lastBoundary.current = spot
          if (trackBoundaryRef.current) setBoundary(spot)
        },
        fail: (message) => {
          setError(message)
          setStatus('idle')
          setUnit(null)
          setLoading(false)
        },
      },
      langRef.current,
    )
    return edgeRef.current
  }, [])

  const cloudEngine = useCallback((): ClipEngine | null => {
    const configId = cloudConfigIdRef.current
    if (!configId) return null
    if (cloudRef.current === null || cloudIdRef.current !== configId) {
      cloudRef.current?.stop()
      cloudIdRef.current = configId
      cloudRef.current = createCloudEngine(
        {
          status: setStatus,
          unit: setUnit,
          loading: setLoading,
          boundary: (spot) => {
            lastBoundary.current = spot
            if (trackBoundaryRef.current) setBoundary(spot)
          },
          fail: (message) => {
            setError(message)
            setStatus('idle')
            setUnit(null)
            setLoading(false)
          },
        },
        configId,
      )
    }
    return cloudRef.current
  }, [])

  /** The per-unit voice map the engines want, bridged from the speaker map. */
  const perUnitVoice = useCallback((): ((index: number) => string | null) | undefined => {
    const map = voiceOf.current
    if (!map) return undefined
    return (index) => map(unitsRef.current[index]?.speaker ?? 'narrator')
  }, [])

  /** The platform engine: its own queue, one utterance per unit. */
  const speakSystem = useCallback(
    (units: readonly SpeechUnit[], from: number, onFinish?: () => void) => {
      if (!('speechSynthesis' in window)) {
        setError('当前环境不支持系统语音')
        return
      }
      generation.current += 1
      const current = generation.current
      window.speechSynthesis.cancel()
      blind.current = false
      setError(null)
      setStatus('playing')
      // The blind-voice fallback timer for the utterance being spoken. Cleared
      // as soon as the voice reports a position, or replaced by the next one.
      let fallback = 0
      // Records where the voice is, and publishes it only while the word-level
      // wash is watching: a busy paragraph would otherwise re-render the reader
      // for every word. The position is kept either way, since a rate or voice
      // change restarts the utterance from it (see `boundaryAt`).
      const mark = (spot: SpeechBoundary | null) => {
        lastBoundary.current = spot
        if (trackBoundaryRef.current) setBoundary(spot)
      }

      const speak = (index: number): void => {
        if (generation.current !== current) return
        window.clearTimeout(fallback)
        if (index >= units.length) {
          setStatus('idle')
          setUnit(null)
          mark(null)
          onFinish?.()
          return
        }
        const entry = units[index]
        setUnit(index)
        // A voice that has shown it never reports boundaries hands the whole
        // utterance over at once; the rest wait to be told where the voice is.
        mark(
          blind.current && entry !== undefined
            ? { unit: index, charIndex: 0, charLength: entry.text.length }
            : null,
        )
        if (entry === undefined || entry.text.trim() === '') {
          speak(index + 1)
          return
        }
        const utterance = new SpeechSynthesisUtterance(entry.text)
        utterance.rate = rate.current
        // `lang` rides along with the voice: without it an engine that ignores
        // `voice` still picks the right language for the text.
        const found = resolveVoice(system, voiceOf.current?.(entry.speaker) ?? voice.current)
        if (found) {
          utterance.voice = found
          utterance.lang = found.lang
        }
        // Attached whether or not words are being washed: `mark` decides what
        // to publish, and the position is kept either way, so a reader who
        // turns the word-level wash on mid-sentence is answered by the next
        // word rather than by the next sentence.
        utterance.addEventListener('boundary', (event) => {
          if (generation.current !== current) return
          window.clearTimeout(fallback)
          blind.current = false
          mark({
            unit: index,
            charIndex: event.charIndex,
            charLength: event.charLength ?? 0,
          })
        })
        utterance.addEventListener('end', () => {
          if (generation.current !== current) return
          speak(index + 1)
        })
        utterance.addEventListener('error', () => {
          if (generation.current !== current) return
          setStatus('idle')
          setUnit(null)
          mark(null)
        })
        window.speechSynthesis.speak(utterance)
        // What the wash does while nothing has been reported: rather than
        // painting the sentence and snapping down to a word a moment later
        // (a flash, not a highlight), wait out the first word. A voice that
        // reports none gets its whole utterance handed over here.
        if (trackBoundaryRef.current) {
          fallback = window.setTimeout(() => {
            if (generation.current !== current) return
            blind.current = true
            if (entry !== undefined) {
              mark({ unit: index, charIndex: 0, charLength: entry.text.length })
            }
          }, BLIND_BOUNDARY_MS)
        }
      }
      speak(from)
    },
    [system],
  )

  /**
   * Reads `units` from `from`, then calls `onFinish` once the last one ends
   * (the reader uses it to roll into the next chapter).
   *
   * The current unit is dropped first: until the engine reports the first
   * utterance of the *new* queue, the old index would resolve against the new
   * list and wash a sentence the voice is not on. Clearing it leaves the wash
   * empty for the one fetch, exactly like ColorReader's chapter change (which
   * stops the voice outright).
   */
  const play = useCallback(
    (units: readonly SpeechUnit[], from: number, onFinish?: () => void) => {
      const kind = engine.current
      const narrator = voice.current
      unitsRef.current = units
      setUnit(null)
      if (kind === 'edge') {
        setError(null)
        edgeEngine().play(
          units.map((entry) => entry.text),
          from,
          {
            voice: narrator ?? '',
            voiceOf: perUnitVoice(),
            rate: rate.current,
            onFinish,
          },
        )
        return
      }
      if (kind === 'cloud') {
        const engineImpl = cloudEngine()
        if (engineImpl === null) {
          setError('请先在「AI 配置」里添加并配置语音服务')
          return
        }
        setError(null)
        engineImpl.play(
          units.map((entry) => entry.text),
          from,
          {
            voice: narrator ?? '',
            voiceOf: perUnitVoice(),
            rate: rate.current,
            onFinish,
          },
        )
        return
      }
      speakSystem(units, from, onFinish)
    },
    [edgeEngine, cloudEngine, perUnitVoice, speakSystem],
  )

  /** Applies a new rate; a session in progress is restarted from where the
   *  voice is, since the utterance being spoken was already synthesised — the
   *  network engines stretch on the way to the speaker instead, so the next
   *  utterance simply carries it. */
  const setRate = useCallback((value: number) => {
    rate.current = value
    edgeRef.current?.setRate(value)
    cloudRef.current?.setRate(value)
  }, [])

  /** Applies a new voice map; a session in progress picks it up from the next
   *  utterance, since the one being spoken was already committed.
   *
   *  Crossing engines is the exception: neither can hand its queue to the
   *  other, so the session ends rather than carrying on in a voice the reader
   *  just replaced. */
  const setVoice = useCallback(
    (
      nextEngine: SpeechEngine,
      nextVoice: string | null,
      nextVoiceOf?: (speaker: string) => string | null,
    ) => {
      const was = engine.current
      engine.current = nextEngine
      voice.current = nextVoice
      voiceOf.current = nextVoiceOf
      // A different voice reports boundaries on its own terms; whether the old
      // one was blind says nothing about it.
      blind.current = false
      setError(null)
      if (nextEngine !== was) {
        window.speechSynthesis?.cancel()
        edgeRef.current?.stop()
        cloudRef.current?.stop()
        setStatus('idle')
        setUnit(null)
        setLoading(false)
        lastBoundary.current = null
        setBoundary(null)
        return
      }
      if (nextEngine === 'edge') {
        edgeRef.current?.setVoice(nextVoice ?? '', perUnitVoice())
      } else if (nextEngine === 'cloud') {
        cloudRef.current?.setVoice(nextVoice ?? '', perUnitVoice())
      }
    },
    [perUnitVoice],
  )

  const pause = useCallback(() => {
    if (engine.current === 'edge') {
      edgeRef.current?.pause()
      return
    }
    if (engine.current === 'cloud') {
      cloudRef.current?.pause()
      return
    }
    window.speechSynthesis?.pause()
    setStatus('paused')
  }, [])

  const resume = useCallback(() => {
    if (engine.current === 'edge') {
      edgeRef.current?.resume()
      return
    }
    if (engine.current === 'cloud') {
      cloudRef.current?.resume()
      return
    }
    window.speechSynthesis?.resume()
    setStatus('playing')
  }, [])

  /** The voice's position as last reported, read through a call rather than
   *  from the state above: the word-level wash is the only thing that needs a
   *  re-render per word, but a settings change restarts the utterance from
   *  here even while the reader is only washing sentences. */
  const boundaryAt = useCallback((): SpeechBoundary | null => lastBoundary.current, [])

  return useMemo(
    () => ({
      status,
      unit,
      boundary,
      error,
      loading,
      systemVoices: system,
      play,
      stop,
      pause,
      resume,
      setRate,
      setVoice,
      boundaryAt,
    }),
    // One object, not a fresh one per render. A value that changes identity
    // every render would re-render every consumer for reasons that have
    // nothing to do with the voice.
    [
      status,
      unit,
      boundary,
      error,
      loading,
      system,
      play,
      stop,
      pause,
      resume,
      setRate,
      setVoice,
      boundaryAt,
    ],
  )
}

/** What the hook hands back. Named so the reader-level layer above it
 *  (`useReadAloud`-style orchestration in the drawer) can take the binding as
 *  an argument rather than owning it. */
export type Tts = ReturnType<typeof useTts>
