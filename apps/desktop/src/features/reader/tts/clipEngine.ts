/**
 * The clip scheduler: one network clip in flight, the next two decoded.
 *
 * Ported from ColorReader's `edge.ts`, with the synthesize call injected rather
 * than baked in — DeepRead runs two providers through this one scheduler:
 *
 * - **edge**: `tts.edge.audio` answers base64 MP3 plus the word timings the
 *   service reports, in one payload;
 * - **cloud**: `tts.audio` answers a cached file path, which is fetched here
 *   and decoded the same way. The cloud provider reports no word timings, so a
 *   cloud clip simply has no cues and the wash falls back to the whole
 *   utterance (see `start`).
 *
 * Playback is Web Audio rather than an `<audio>` element: a `BufferSourceNode`
 * can be started at an exact point and its elapsed time read off the context's
 * own clock, whereas a media element would need `timeupdate` — four events a
 * second, visibly chunky against a word-level highlight.
 *
 * The reader's speed never reaches the provider. Every clip is synthesised at
 * rate 1.0 and stretched to the rate in force as it is scheduled (see
 * `timeStretch`) — which is why changing the speed costs nothing but arithmetic
 * on samples already decoded. The word timings therefore live in rate-1.0 time
 * and are read back through `rate` at playout.
 */

import { convertFileSrc } from '@tauri-apps/api/core'

import type { SpeechBoundary, SpeechStatus, WordCue } from '@deepread/reader-core'
import { wordCues } from '@deepread/reader-core'
import { invokeCommand } from '../../../lib/ipc'
import { timeStretch } from './timeStretch'
import { existingTtsAudio, ttsAudio } from './audio'

/** One decoded utterance, ready to play. */
interface Ready {
  /** Decoded, unstretched. Stretched copies are made per playout. */
  buffer: AudioBuffer
  cues: WordCue[]
  /** Characters of the utterance as synthesised (after any head trim). The
   *  whole-utterance position handed over when the service timed no words. */
  chars: number
  /** The voice this clip was synthesised with, so a voice change can drop
   *  exactly the clips it invalidates instead of all of them. */
  voice: string
}

/** How far ahead to synthesise. Two clips is roughly ten seconds of speech:
 *  enough to ride out a slow request, far short of holding a chapter in memory. */
const AHEAD = 2

/** What the scheduler reports as the voice moves. */
export interface ClipEvents {
  status: (status: SpeechStatus) => void
  unit: (index: number) => void
  boundary: (boundary: SpeechBoundary | null) => void
  /** A clip is being synthesised and the voice has nothing to say yet — the
   *  space between a seek and the first sample is a network round trip, not
   *  silence, and the player draws it as loading rather than a frozen clock. */
  loading: (pending: boolean) => void
  /** The provider could not be reached. */
  fail: (message: string) => void
}

export interface PlayOptions {
  /** The voice for units `voiceOf` does not cover (the narrator's). */
  voice: string
  /** Per-unit voice, keyed by unit index — the multi-character read-aloud
   *  picks a voice per speaker. `null`/`undefined` falls back to `voice`. */
  voiceOf?: (index: number) => string | null
  rate: number
  /** The queue ran out (the reader rolls into the next chapter). Never fires
   *  after a `stop` — stopping is not finishing. */
  onFinish?: () => void
}

export interface ClipEngine {
  play: (units: readonly string[], from: number, options: PlayOptions) => void
  stop: () => void
  pause: () => void
  resume: () => void
  setRate: (rate: number) => void
  /** A new voice map. Clips already decoded under a voice that no longer
   *  applies are dropped; the utterance being spoken keeps the one it has. */
  setVoice: (voice: string, voiceOf?: (index: number) => string | null) => void
}

/** One utterance's audio bytes plus the word timings the provider reported. */
export interface Clip {
  audio: ArrayBuffer
  words: readonly { at: number; text: string }[]
}

/** IPC rejections are `AppError` strings, not `Error`s. */
function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return '语音合成失败，请检查网络'
}

/** `atob` yields one character per byte; the loop is the whole decoder. */
function bytesOf(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
  return bytes.buffer
}

/** The edge provider: base64 audio and word timings in one round trip. */
async function synthesizeEdge(text: string, voice: string, lang?: string): Promise<Clip> {
  const response = await invokeCommand('tts.edge.audio', { text, voice, lang })
  return { audio: bytesOf(response.audio), words: response.words }
}

/** The cloud provider: a cached file on disk, fetched and decoded here. */
async function synthesizeCloud(text: string, voice: string, configId: string): Promise<Clip> {
  const response = await invokeCommand('tts.audio', {
    configId,
    text,
    voice,
    // Always 1.0: the speed is applied at playout, so one cached clip answers
    // every rate (the cache key carries this speed).
    speed: 1,
  })
  const bytes = await fetch(convertFileSrc(response.path)).then((res) => res.arrayBuffer())
  return { audio: bytes, words: [] }
}

/**
 * Waits for a context to actually be live before a source is scheduled.
 *
 * A pause leaves the context suspended, and `resume()` is asynchronous —
 * scheduling a source against a suspend that has not landed yet produces
 * silence with no error, so the wait is not optional.
 *
 * WebKit refuses `resume()` outside a user gesture, so a context that was
 * never unlocked on the click that started playback (the OS suspending it
 * while the app sat in the background is the usual way) still comes back dead
 * here. The last resort is the next gesture the reader makes: silence with no
 * error is the one failure they cannot diagnose for themselves. The normal
 * path never gets here with a dead context — `primeTtsAudio` unlocked it on
 * the click, see `tts/audio.ts`.
 */
async function live(ctx: AudioContext): Promise<void> {
  if (ctx.state !== 'running') await ctx.resume()
  if (ctx.state === 'running') return
  await new Promise<void>((resolve) => {
    const unlock = (): void => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
      // Resolves either way: a gesture that still cannot unlock must not
      // wedge the queue — the source plays into silence, as it did before.
      void ctx.resume().then(resolve, resolve)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
  })
}

/**
 * The scheduler behind one player.
 *
 * Everything asynchronous is guarded by a generation counter: a stop, a seek or
 * a chapter roll-over invalidates whatever was already in flight, and a late
 * response must never restart a queue nobody is listening to.
 */
export function createClipEngine(
  synthesize: (text: string, voice: string) => Promise<Clip>,
  events: ClipEvents,
): ClipEngine {
  let source: AudioBufferSourceNode | null = null
  let frame = 0
  let generation = 0
  let texts: readonly string[] = []
  let origin = 0
  let trim = 0
  let voice = ''
  let voiceOf: ((index: number) => string | null) | undefined
  let rate = 1
  let onFinish: (() => void) | undefined

  const ready = new Map<number, Ready>()
  const inflight = new Map<number, Promise<boolean>>()
  let startedAt = 0

  const voiceFor = (index: number): string => voiceOf?.(index) ?? voice

  /** Tears down whatever is playing, deliberately leaving the context in
   *  whatever power state it is in: every restart goes through here (`play`
   *  included), and WebKit only resumes a suspended context inside a user
   *  gesture — a restart is never inside one. Suspending to save power is the
   *  session's business (`suspendTtsAudio`, called when the reader truly
   *  stops), not the teardown's. */
  function stop(): void {
    generation += 1
    cancelAnimationFrame(frame)
    if (source) {
      // The `ended` listener is left attached: the counter was already bumped,
      // so it is inert, and the node is unreachable once it is dropped here.
      try {
        source.stop()
      } catch {
        // Never started; nothing to stop.
      }
      source.disconnect()
      source = null
    }
    ready.clear()
    inflight.clear()
    texts = []
    onFinish = undefined
  }

  /** Synthesises one unit, redoing the request if the voice map moved while it
   *  was on the wire (a settings change must not read as "the chapter ended").
   *  Returns whether the clip was stored; a stop reads as "do not retry". */
  async function synthesizeUnit(index: number, current: number): Promise<boolean> {
    const base = texts[index]
    if (base === undefined) return false
    const text = index === origin && trim > 0 ? base.slice(trim) : base
    if (text.trim() === '') return false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const wanted = voiceFor(index)
      try {
        const clip = await synthesize(text, wanted)
        if (generation !== current) return false
        // Re-resolved, not cached: a voice change that landed while this
        // request was in flight invalidates the clip it was made for.
        if (voiceFor(index) !== wanted) continue
        const buffer = await ttsAudio().decodeAudioData(clip.audio)
        if (generation !== current) return false
        ready.set(index, {
          buffer,
          cues: wordCues(text, clip.words),
          chars: text.length,
          voice: wanted,
        })
        return true
      } catch (error) {
        if (generation !== current) return false
        events.fail(messageOf(error))
        stop()
        return false
      }
    }
    return false
  }

  async function ensure(index: number, current: number): Promise<Ready | null> {
    if (index >= texts.length) return null
    const cached = ready.get(index)
    if (cached) return cached
    const running = inflight.get(index)
    if (running) {
      await running
      return ready.get(index) ?? null
    }
    // Registered before the first suspension point, so a parallel caller for
    // the same index joins this one instead of starting a second request.
    const task = synthesizeUnit(index, current)
    inflight.set(index, task)
    const stored = await task
    // Only if the entry is still ours: a stop may have replaced it.
    if (inflight.get(index) === task) inflight.delete(index)
    return stored ? (ready.get(index) ?? null) : null
  }

  /** Keeps the next `AHEAD` clips warm, following the playhead rather than the
   *  queue's start, so a long chapter never stops to wait. */
  function warm(from: number, current: number): void {
    for (let index = from + 1; index <= from + AHEAD; index += 1) void ensure(index, current)
  }

  /** Tracks the cue list against the context's clock, reporting only when the
   *  word actually changes — a reader must not re-render sixty times a second
   *  to redraw the same highlight.
   *
   *  The loop runs for every clip, not only while words are being washed: the
   *  listener decides what to publish, and a reader who turns the word-level
   *  wash on mid-clip needs the position this has been tracking all along.
   *
   *  `tempo` is the rate this clip was stretched by. The provider timed the
   *  words against rate-1.0 audio, so a clip playing `tempo` times faster is
   *  `tempo` times further into that timeline than the wall clock says. */
  function follow(index: number, cues: readonly WordCue[], current: number, tempo: number): void {
    cancelAnimationFrame(frame)
    if (cues.length === 0) return
    let last = -1
    const step = (): void => {
      if (generation !== current) return
      const ctx = existingTtsAudio()
      if (!ctx || source === null) return
      const at = (ctx.currentTime - startedAt) * tempo
      let hit = -1
      for (let position = 0; position < cues.length; position += 1) {
        const cue = cues[position]
        if (cue !== undefined && cue.at <= at) hit = position
        else break
      }
      if (hit !== last) {
        last = hit
        const cue = hit < 0 ? undefined : cues[hit]
        events.boundary(
          cue === undefined
            ? null
            : { unit: index, charIndex: cue.start, charLength: cue.end - cue.start },
        )
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
  }

  function settle(): void {
    events.boundary(null)
    events.status('idle')
    source = null
    const finish = onFinish
    onFinish = undefined
    finish?.()
  }

  /** The clip's channels, time-stretched to the rate in force.
   *
   *  One buffer per playout rather than one per clip: the same rate-1.0 decode
   *  has to be reusable at any speed, and this is the only part of the pipeline
   *  that depends on the rate at all. See `timeStretch` for why a stretch and
   *  not `playbackRate`. */
  function stretched(clip: Ready, tempo: number): AudioBuffer {
    if (tempo === 1) return clip.buffer
    const channels: Float32Array<ArrayBuffer>[] = []
    for (let c = 0; c < clip.buffer.numberOfChannels; c += 1) {
      channels.push(timeStretch(clip.buffer.getChannelData(c), clip.buffer.sampleRate, tempo))
    }
    const out = ttsAudio().createBuffer(
      clip.buffer.numberOfChannels,
      Math.max(...channels.map((channel) => channel.length)),
      clip.buffer.sampleRate,
    )
    channels.forEach((channel, c) => out.copyToChannel(channel, c))
    return out
  }

  async function start(index: number, current: number): Promise<void> {
    events.loading(true)
    const clip = await ensure(index, current)
    events.loading(false)
    if (generation !== current) return
    if (!clip) {
      settle()
      return
    }
    const ctx = ttsAudio()
    await live(ctx)
    if (generation !== current) return
    // Read once and carried through the rest of this clip: a rate changed while
    // it is speaking must not rescale the words already scheduled at the old
    // one. It lands on the next utterance instead.
    const tempo = rate
    source = ctx.createBufferSource()
    source.buffer = stretched(clip, tempo)
    source.connect(ctx.destination)
    source.addEventListener('ended', () => {
      if (generation !== current) return
      cancelAnimationFrame(frame)
      void start(index + 1, current)
    })
    events.unit(index)
    // No word timings from the provider: the whole utterance is the position,
    // handed over as playback starts. Waiting for cues that will never arrive
    // would leave the wash blank, and painting the sentence first only to
    // shrink onto a word a moment later is the flash this avoids.
    events.boundary(
      clip.cues.length === 0 ? { unit: index, charIndex: 0, charLength: clip.chars } : null,
    )
    startedAt = ctx.currentTime
    source.start()
    warm(index, current)
    follow(index, clip.cues, current, tempo)
  }

  function play(units: readonly string[], from: number, options: PlayOptions): void {
    stop()
    // `stop` bumped the counter; this is the live one until the next stop.
    const current = generation
    if (from >= units.length) {
      events.status('idle')
      options.onFinish?.()
      return
    }
    texts = [...units]
    origin = from
    trim = 0
    voice = options.voice
    voiceOf = options.voiceOf
    rate = options.rate
    onFinish = options.onFinish
    events.status('playing')
    void start(from, current)
  }

  function pause(): void {
    const context = existingTtsAudio()
    if (context === null || context.state !== 'running') return
    void context.suspend()
    events.status('paused')
  }

  function resume(): void {
    void ttsAudio().resume()
    events.status('playing')
  }

  return {
    play,
    stop,
    pause,
    resume,
    setRate(value) {
      if (value === rate) return
      // Nothing to invalidate, and that is the point of it: the clip being
      // spoken and the two already decoded are rate-1.0 audio, stretched on
      // their way to the speaker, so the next utterance picks the rate up
      // without a request in flight — no load, no gap, and a cached sentence
      // stays a cached sentence however many times the speed is changed.
      rate = value
    },
    setVoice(next, nextVoiceOf) {
      const changed = next !== voice || nextVoiceOf !== voiceOf
      voice = next
      voiceOf = nextVoiceOf
      if (!changed) return
      // Drop exactly the clips the new map invalidates: an entry made with a
      // voice no longer in force would otherwise be played back wrong. The
      // utterance being spoken is already committed and keeps its own.
      for (const [index, clip] of ready) {
        if (clip.voice !== voiceFor(index)) ready.delete(index)
      }
    },
  }
}

/** The Edge engine: the online voices, with word timings. */
export function createEdgeEngine(events: ClipEvents, lang?: string): ClipEngine {
  return createClipEngine((text, voice) => synthesizeEdge(text, voice, lang), events)
}

/** The cloud engine: an OpenAI-compatible provider's cached audio, no timings. */
export function createCloudEngine(events: ClipEvents, configId: string): ClipEngine {
  return createClipEngine((text, voice) => synthesizeCloud(text, voice, configId), events)
}
