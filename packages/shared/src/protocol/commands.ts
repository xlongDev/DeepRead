/**
 * Typed IPC command catalog.
 *
 * Rules (spec §40 / §57):
 * - every command has a name, request type, response type and error type (`AppErrorPayload`)
 * - responses are untrusted input: the frontend validates them with the schemas below
 * - requests are validated on the Rust side by typed serde structs + explicit checks
 * - Sprint 2 replaces the hand-mirrored Rust types with schema-first codegen
 */

import { z } from 'zod'
import { ISO8601_PATTERN, type ISO8601 } from '../types'

export const COMMAND = {
  systemPing: 'system.ping',
  appInfo: 'app.info',
  readerStateGet: 'reader.state.get',
  readerStateSet: 'reader.state.set',
  libraryList: 'library.list',
  libraryImport: 'library.import',
  libraryRemove: 'library.remove',
  libraryInfoSet: 'library.info.set',
  libraryTagSet: 'library.tag.set',
  readerStatsAdd: 'reader.stats.add',
  readerStatsGet: 'reader.stats.get',
  readerStatsBooks: 'reader.stats.books',
  readerNotesList: 'reader.notes.list',
  readerNoteUpdate: 'reader.note.update',
  libraryCoverGet: 'library.cover.get',
  libraryCoverPut: 'library.cover.put',
  notesExport: 'notes.export',
  dictionaryList: 'dictionary.list',
  dictionaryRegister: 'dictionary.register',
  dictionaryRemove: 'dictionary.remove',
  aiConfigList: 'ai.config.list',
  aiConfigSave: 'ai.config.save',
  aiConfigRemove: 'ai.config.remove',
  aiChat: 'ai.chat',
  aiCancel: 'ai.cancel',
  aiEmbed: 'ai.embed',
  aiIndexGet: 'ai.index.get',
  aiIndexSet: 'ai.index.set',
  aiArtifactGet: 'ai.artifact.get',
  aiArtifactSet: 'ai.artifact.set',
  storageBackup: 'storage.backup',
  storageRestore: 'storage.restore',
  cardsList: 'cards.list',
  cardsAdd: 'cards.add',
  cardsRemove: 'cards.remove',
  cardsReview: 'cards.review',
  ttsAudio: 'tts.audio',
  ttsEdgeAudio: 'tts.edge.audio',
  ttsEdgeVoices: 'tts.edge.voices',
  fontsList: 'fonts.list',
  fontsImport: 'fonts.import',
  fontsRemove: 'fonts.remove',
  cloudConfigGet: 'cloud.config.get',
  cloudConfigSave: 'cloud.config.save',
  cloudConfigTest: 'cloud.config.test',
  cloudConfigClear: 'cloud.config.clear',
  cloudWebdavGet: 'cloud.webdav.get',
  cloudWebdavPut: 'cloud.webdav.put',
  cloudBackup: 'cloud.backup',
  cloudRestore: 'cloud.restore',
  secretSet: 'secret.set',
  secretDelete: 'secret.delete',
} as const

export interface SystemPingRequest {
  readonly nonce: string
}

export interface SystemPingResponse {
  readonly nonce: string
  readonly serverTime: ISO8601
  readonly appVersion: string
}

export interface AppInfo {
  readonly appName: string
  readonly appVersion: string
  readonly os: string
  readonly arch: string
}

/** One persisted highlight/annotation, anchored by CFI (kernel-level locator). */
export interface AnnotationRecord {
  readonly id: string
  readonly cfi: string
  readonly color: string
  readonly note?: string
  readonly excerpt?: string
  /** Record-level merge timestamp (sync §51); absent for pre-v3 rows. */
  readonly updatedAt?: ISO8601
  /** Tombstone: deleted on this device; kept so sync never resurrects it. */
  readonly deleted?: boolean
}

/** One bookmark: a named CFI anchor in the book. */
export interface BookmarkRecord {
  readonly id: string
  readonly cfi: string
  readonly label?: string
  readonly createdAt: ISO8601
  /** Tombstone: deleted on this device; kept so sync never resurrects it. */
  readonly deleted?: boolean
}

/** Per-book reader state, persisted keyed by the hash of the book file. */
export interface ReaderStatePayload {
  readonly progress: { readonly cfi: string; readonly fraction: number } | null
  readonly annotations: readonly AnnotationRecord[]
  readonly bookmarks: readonly BookmarkRecord[]
  readonly updatedAt: ISO8601
}

/**
 * A book registered in the library. The file stays at its original location
 * (spec: original content is never moved or modified); it is served to the
 * reader kernel through the asset protocol.
 */
export interface LibraryBook {
  readonly hash: string
  readonly fileName: string
  /**
   * Clean, human-facing title (from the book's own metadata when available).
   * `null` means "not resolved yet" — the shelf falls back to a cleaned file
   * name and backfills lazily.
   */
  readonly displayName: string | null
  /** Author from the book's own metadata, or typed by hand. Shown on the card. */
  readonly author: string | null
  readonly subtitle: string | null
  readonly publisher: string | null
  readonly language: string | null
  readonly format: string
  readonly path: string
  readonly size: number
  readonly addedAt: ISO8601
  /** Reading fraction (0-1) joined in by `library.list`; null = never opened. */
  readonly progress: number | null
  /** User collections; empty means untagged. */
  readonly tags: readonly string[]
}

export interface LibraryListResponse {
  readonly books: readonly LibraryBook[]
}

export interface LibraryImportRequest {
  readonly path: string
}

export interface LibraryImportResponse {
  readonly book: LibraryBook
}

export interface LibraryRemoveRequest {
  readonly bookHash: string
}

export interface LibraryRemoveResponse {
  readonly removed: boolean
}

/**
 * 书籍元数据的整表提交:面板一次给全部字段,`null` = 清空该项。
 * 不做「只写变化列」的局部更新 —— 那要动态拼 SQL,而面板本来就是整表编辑。
 */
export interface LibraryInfoSetRequest {
  readonly bookHash: string
  readonly displayName: string | null
  readonly author: string | null
  readonly subtitle: string | null
  readonly publisher: string | null
  readonly language: string | null
}

export interface LibraryInfoSetResponse {
  readonly book: LibraryBook
}

export interface ReaderStatsAddRequest {
  readonly bookHash: string
  /** Local calendar day of the reading session, `YYYY-MM-DD`. */
  readonly day: string
  readonly seconds: number
}

export interface ReaderStatsAddResponse {
  /** Total for that book on that day after the update. */
  readonly daySeconds: number
}

export interface ReaderStatsGetResponse {
  /** Per-day totals across all books, newest first. */
  readonly days: readonly { readonly day: string; readonly seconds: number }[]
  readonly totalSeconds: number
}

/**
 * 一本书累计读了多少(排行榜用)。
 *
 * 标题两个来源都给:Rust 不做文件名清洗,前端复用与书架同一个 `shelfTitle`。
 */
export interface BookReadingStat {
  readonly bookHash: string
  readonly displayName: string | null
  readonly fileName: string
  readonly seconds: number
}

export interface ReaderStatsBooksResponse {
  /** 按总时长降序;上限 20 本 —— 排行榜是给人看的,不是全量导出。 */
  readonly books: readonly BookReadingStat[]
}

/**
 * 一条批注,离开它所属的书出现在笔记页上。
 *
 * 标题两个字段都给:Rust 侧不做清洗(那套规则属于前端),前端用与书架同一个
 * `shelfTitle` 回退逻辑,免得同一个书名在两处长得不一样。
 */
export interface NoteEntry {
  readonly id: string
  readonly bookHash: string
  /** 书籍自带元数据标题;`null` = 尚未解析,回退到清洗后的文件名。 */
  readonly displayName: string | null
  readonly fileName: string
  readonly cfi: string
  readonly color: string
  /** 用户自己写的那句话。 */
  readonly note: string | null
  /** 原文摘录。 */
  readonly excerpt: string | null
  /** 记录级合并时间戳(同步 §51);v3 之前的行为 `null`。 */
  readonly updatedAt: ISO8601 | null
}

export interface ReaderNotesListResponse {
  /** 未删除的批注,新→旧;没有时间戳的排在最后,整体上限 2000 条。 */
  readonly notes: readonly NoteEntry[]
}

export interface ReaderNoteUpdateRequest {
  readonly noteId: string
  /** 自己写的那句话;空串 = 清空,回到纯高亮。 */
  readonly note: string
}

export interface ReaderNoteUpdateResponse {
  /** 更新后的完整条目(与 notes.list 的行形状一致)。 */
  readonly entry: NoteEntry
}

export interface LibraryTagSetRequest {
  readonly bookHash: string
  /** Full replacement set: the shelf sends what the book should end up with. */
  readonly tags: readonly string[]
}

export interface LibraryTagSetResponse {
  readonly book: LibraryBook
}

export interface LibraryCoverGetRequest {
  readonly bookHash: string
}

export interface LibraryCoverGetResponse {
  /** Absolute path of the cached cover; null when it has not been extracted yet. */
  readonly path: string | null
}

export interface LibraryCoverPutRequest {
  readonly bookHash: string
  /** Base64 of the extracted cover image (bytes travel badly through JSON IPC). */
  readonly data: string
}

export interface LibraryCoverPutResponse {
  readonly path: string
}

/**
 * 导出批注到本地 Markdown。桌面端 WebView 会拦截 `<a download>`,所以落盘
 * 必须走系统保存对话框 + Rust 写文件 —— 这条命令就是那个入口。
 */
export interface NotesExportRequest {
  readonly markdown: string
  /** 保存对话框的默认文件名(不含 `.md`)。 */
  readonly defaultName: string
}

export interface NotesExportResponse {
  /** 用户最终选定的绝对路径;null = 用户取消了对话框。 */
  readonly path: string | null
}

/** A registered StarDict dictionary (files stay at their original location). */
export interface DictionaryMeta {
  readonly id: string
  readonly name: string
  readonly wordCount: number
  readonly sametypesequence?: string
  readonly ifoPath: string
  readonly idxPath: string
  readonly dictPath: string
}

export interface DictionaryListResponse {
  readonly dictionaries: readonly DictionaryMeta[]
}

export interface DictionaryRegisterRequest {
  readonly path: string
}

export interface DictionaryRegisterResponse {
  readonly dictionary: DictionaryMeta
}

export interface DictionaryRemoveRequest {
  readonly id: string
}

export interface DictionaryRemoveResponse {
  readonly removed: boolean
}

/**
 * AI provider configuration (non-secret half). The API key lives in the OS
 * keychain, addressed by the config id — it never crosses IPC back to the UI.
 */
export interface AiProviderConfig {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly model: string
  /** Embedding model for RAG; defaults to the chat model when absent. */
  readonly embeddingModel?: string
  /** Speech-synthesis model for cloud TTS (spec §31: configured separately). */
  readonly ttsModel?: string
}

export interface AiConfigListResponse {
  readonly providers: readonly AiProviderConfig[]
}

export interface AiConfigSaveRequest {
  readonly provider: AiProviderConfig
  readonly apiKey: string
}

export interface AiConfigSaveResponse {
  readonly provider: AiProviderConfig
}

export interface AiConfigRemoveRequest {
  readonly id: string
}

export interface AiConfigRemoveResponse {
  readonly removed: boolean
}

export interface AiChatRequest {
  readonly taskId: string
  readonly configId: string
  /** OpenAI-compatible chat messages (validated by zod on the sender side). */
  readonly messages: readonly {
    readonly role: 'system' | 'user' | 'assistant'
    readonly content: string
  }[]
  readonly temperature?: number
}

/** ai.chat returns the taskId immediately; stream events arrive via channel. */
export interface AiChatResponse {
  readonly taskId: string
}

export interface AiCancelRequest {
  readonly taskId: string
}

export interface AiCancelResponse {
  readonly cancelled: boolean
}

export interface AiEmbedRequest {
  readonly taskId: string
  readonly configId: string
  readonly texts: readonly string[]
}

export interface AiEmbedResponse {
  readonly vectors: readonly (readonly number[])[]
}

/** One indexed chunk of a book (chapter-labeled, embedded). */
export interface AiIndexChunk {
  readonly label: string
  readonly text: string
  readonly vector: readonly number[]
}

export interface AiIndexPayload {
  readonly chunks: readonly AiIndexChunk[]
  readonly embeddingModel: string
  readonly createdAt: ISO8601
}

export interface AiIndexGetRequest {
  readonly bookHash: string
}

export interface AiIndexGetResponse {
  readonly index: AiIndexPayload | null
}

export interface AiIndexSetRequest {
  readonly bookHash: string
  readonly index: AiIndexPayload
}

export interface AiIndexSetResponse {
  readonly savedAt: ISO8601
}

/** Generic per-book AI artifact (summary/outline/notes/…), JSON value payload. */
export type AiArtifactKind = 'summary' | 'outline' | 'notes' | 'characters'

export interface AiArtifactGetRequest {
  readonly bookHash: string
  readonly kind: AiArtifactKind
}

export interface AiArtifactGetResponse {
  readonly payload: Record<string, unknown> | null
  readonly createdAt: ISO8601 | null
}

export interface AiArtifactSetRequest {
  readonly bookHash: string
  readonly kind: AiArtifactKind
  readonly payload: Record<string, unknown>
}

export interface AiArtifactSetResponse {
  readonly savedAt: ISO8601
}

/** Backup the SQLite database to a user-chosen file (spec §126). */
export interface StorageBackupRequest {
  readonly path: string
}
export interface StorageBackupResponse {
  readonly bytes: number
  readonly checksum: string
}

/** Restore from a validated snapshot; migrations re-run if the backup is older. */
export interface StorageRestoreRequest {
  readonly path: string
  readonly checksum: string
}

export interface StorageRestoreResponse {
  readonly restored: boolean
}

export interface SecretSetRequest {
  readonly key: string
  readonly value: string
}

export interface SecretGetRequest {
  readonly key: string
}

export interface SecretGetResponse {
  readonly value: string | null
}

export interface SecretDeleteRequest {
  readonly key: string
}

export interface SecretDeleteResponse {
  readonly deleted: boolean
}

export interface ReaderStateGetRequest {
  readonly bookHash: string
}

export interface ReaderStateGetResponse {
  readonly state: ReaderStatePayload | null
}

export interface ReaderStateSetRequest {
  readonly bookHash: string
  readonly state: ReaderStatePayload
}

export interface ReaderStateSetResponse {
  readonly savedAt: ISO8601
}

/** One learning card (flashcard, quiz item or mistake) with SM-2-lite state. */
export type CardSource = 'highlight' | 'quiz' | 'mistake'

export interface LearningCard {
  readonly id: string
  readonly bookHash: string
  readonly front: string
  readonly back: string
  readonly source: CardSource
  readonly cfi?: string
  readonly ease: number
  readonly intervalDays: number
  readonly reps: number
  readonly lapses: number
  readonly dueAt: ISO8601
  readonly createdAt: ISO8601
}

export interface CardsListRequest {
  readonly bookHash?: string
}

export interface CardsListResponse {
  readonly cards: readonly LearningCard[]
}

export interface NewCardInput {
  readonly id: string
  readonly front: string
  readonly back: string
  readonly source: CardSource
  readonly cfi?: string
  readonly dueAt: ISO8601
}

export interface CardsAddRequest {
  readonly bookHash: string
  readonly cards: readonly NewCardInput[]
}

export interface CardsAddResponse {
  readonly added: number
  readonly savedAt: ISO8601
}

export interface CardsRemoveRequest {
  readonly id: string
}

export interface CardsRemoveResponse {
  readonly removed: boolean
}

/** The frontend schedules (SM-2 lite, `@deepread/shared/srs`); the backend stores. */
export interface CardsReviewRequest {
  readonly id: string
  readonly ease: number
  readonly intervalDays: number
  readonly reps: number
  readonly lapses: number
  readonly dueAt: ISO8601
}

export interface CardsReviewResponse {
  readonly dueAt: ISO8601
}

/**
 * Cloud speech synthesis through the provider proxy (spec §44). Returns the
 * path of a cached audio file (keyed by a hash of the request) that the
 * webview plays via the asset protocol.
 */
export interface TtsAudioRequest {
  readonly configId: string
  readonly text: string
  readonly voice: string
  readonly speed?: number
}

export interface TtsAudioResponse {
  readonly path: string
  readonly cached: boolean
}

/**
 * Edge read-aloud synthesis (spec §44b): same cached-audio contract as the
 * cloud path, no API key — the Edge browser endpoint is keyless.
 */
export interface EdgeTtsAudioRequest {
  readonly text: string
  readonly voice: string
  readonly lang?: string
  readonly rate?: number
}

export interface EdgeTtsAudioResponse {
  readonly path: string
  readonly cached: boolean
}

export interface EdgeTtsVoice {
  readonly shortName: string
  readonly friendlyName: string
  readonly locale: string
  readonly gender: string
}

export interface EdgeTtsVoicesResponse {
  readonly voices: readonly EdgeTtsVoice[]
}

/** 用户导入的阅读字体(存放在应用数据目录,经 asset protocol 提供)。 */
export interface ReadingFont {
  readonly id: string
  readonly name: string
  readonly fileName: string
  readonly path: string
}

export interface FontImportRequest {
  readonly path: string
}

export interface FontRemoveRequest {
  readonly id: string
}

/** WebDAV cloud configuration (non-secret half; password lives in the keychain). */
export interface CloudConfig {
  readonly endpoint: string
  readonly username: string
}

export interface CloudConfigGetResponse {
  readonly config: CloudConfig | null
  readonly deviceId: string
  readonly deviceName: string
}

export interface CloudConfigSaveRequest {
  readonly endpoint: string
  readonly username: string
  readonly password: string
}

export interface CloudConfigSaveResponse {
  readonly config: CloudConfig
}

/** Probe credentials; empty password reuses the stored one. */
export interface CloudConfigTestRequest {
  readonly endpoint: string
  readonly username: string
  readonly password: string
}

export interface CloudConfigTestResponse {
  readonly ok: boolean
}

export interface CloudConfigClearResponse {
  readonly cleared: boolean
}

/** Raw WebDAV transport used by the frontend merge engine (spec §50-§53). */
export interface CloudWebdavGetRequest {
  readonly path: string
}

export interface CloudWebdavGetResponse {
  /** null when the remote document does not exist yet. */
  readonly body: string | null
}

export interface CloudWebdavPutRequest {
  readonly path: string
  readonly body: string
}

export interface CloudWebdavPutResponse {
  readonly ok: boolean
}

/** Snapshot the SQLite database and upload it to WebDAV (spec §126/§53). */
export interface CloudBackupResponse {
  readonly remotePath: string
  readonly bytes: number
  readonly checksum: string
}

export interface CloudRestoreResponse {
  readonly restored: boolean
}

/** The single source of truth for command request/response shapes. */
export interface CommandMap {
  [COMMAND.systemPing]: {
    readonly request: SystemPingRequest
    readonly response: SystemPingResponse
  }
  [COMMAND.appInfo]: {
    readonly request: undefined
    readonly response: AppInfo
  }
  [COMMAND.readerStateGet]: {
    readonly request: ReaderStateGetRequest
    readonly response: ReaderStateGetResponse
  }
  [COMMAND.readerStateSet]: {
    readonly request: ReaderStateSetRequest
    readonly response: ReaderStateSetResponse
  }
  [COMMAND.libraryList]: {
    readonly request: undefined
    readonly response: LibraryListResponse
  }
  [COMMAND.libraryImport]: {
    readonly request: LibraryImportRequest
    readonly response: LibraryImportResponse
  }
  [COMMAND.libraryRemove]: {
    readonly request: LibraryRemoveRequest
    readonly response: LibraryRemoveResponse
  }
  [COMMAND.libraryInfoSet]: {
    readonly request: LibraryInfoSetRequest
    readonly response: LibraryInfoSetResponse
  }
  [COMMAND.libraryTagSet]: {
    readonly request: LibraryTagSetRequest
    readonly response: LibraryTagSetResponse
  }
  [COMMAND.readerStatsAdd]: {
    readonly request: ReaderStatsAddRequest
    readonly response: ReaderStatsAddResponse
  }
  [COMMAND.readerStatsGet]: {
    readonly request: undefined
    readonly response: ReaderStatsGetResponse
  }
  [COMMAND.readerStatsBooks]: {
    readonly request: undefined
    readonly response: ReaderStatsBooksResponse
  }
  [COMMAND.readerNotesList]: {
    readonly request: undefined
    readonly response: ReaderNotesListResponse
  }
  [COMMAND.readerNoteUpdate]: {
    readonly request: ReaderNoteUpdateRequest
    readonly response: ReaderNoteUpdateResponse
  }
  [COMMAND.libraryCoverGet]: {
    readonly request: LibraryCoverGetRequest
    readonly response: LibraryCoverGetResponse
  }
  [COMMAND.libraryCoverPut]: {
    readonly request: LibraryCoverPutRequest
    readonly response: LibraryCoverPutResponse
  }
  [COMMAND.notesExport]: {
    readonly request: NotesExportRequest
    readonly response: NotesExportResponse
  }
  [COMMAND.dictionaryList]: {
    readonly request: undefined
    readonly response: DictionaryListResponse
  }
  [COMMAND.dictionaryRegister]: {
    readonly request: DictionaryRegisterRequest
    readonly response: DictionaryRegisterResponse
  }
  [COMMAND.dictionaryRemove]: {
    readonly request: DictionaryRemoveRequest
    readonly response: DictionaryRemoveResponse
  }
  [COMMAND.aiConfigList]: {
    readonly request: undefined
    readonly response: AiConfigListResponse
  }
  [COMMAND.aiConfigSave]: {
    readonly request: AiConfigSaveRequest
    readonly response: AiConfigSaveResponse
  }
  [COMMAND.aiConfigRemove]: {
    readonly request: AiConfigRemoveRequest
    readonly response: AiConfigRemoveResponse
  }
  /** ai.chat streams events through a Tauri Channel, not the return value. */
  [COMMAND.aiChat]: {
    readonly request: AiChatRequest
    readonly response: AiChatResponse
  }
  [COMMAND.aiCancel]: {
    readonly request: AiCancelRequest
    readonly response: AiCancelResponse
  }
  [COMMAND.aiEmbed]: {
    readonly request: AiEmbedRequest
    readonly response: AiEmbedResponse
  }
  [COMMAND.aiIndexGet]: {
    readonly request: AiIndexGetRequest
    readonly response: AiIndexGetResponse
  }
  [COMMAND.aiIndexSet]: {
    readonly request: AiIndexSetRequest
    readonly response: AiIndexSetResponse
  }
  [COMMAND.aiArtifactGet]: {
    readonly request: AiArtifactGetRequest
    readonly response: AiArtifactGetResponse
  }
  [COMMAND.storageBackup]: {
    readonly request: StorageBackupRequest
    readonly response: StorageBackupResponse
  }
  [COMMAND.storageRestore]: {
    readonly request: StorageRestoreRequest
    readonly response: StorageRestoreResponse
  }
  [COMMAND.cardsList]: {
    readonly request: CardsListRequest
    readonly response: CardsListResponse
  }
  [COMMAND.cardsAdd]: {
    readonly request: CardsAddRequest
    readonly response: CardsAddResponse
  }
  [COMMAND.cardsRemove]: {
    readonly request: CardsRemoveRequest
    readonly response: CardsRemoveResponse
  }
  [COMMAND.cardsReview]: {
    readonly request: CardsReviewRequest
    readonly response: CardsReviewResponse
  }
  [COMMAND.ttsAudio]: {
    readonly request: TtsAudioRequest
    readonly response: TtsAudioResponse
  }
  [COMMAND.ttsEdgeAudio]: {
    readonly request: EdgeTtsAudioRequest
    readonly response: EdgeTtsAudioResponse
  }
  [COMMAND.ttsEdgeVoices]: {
    readonly request: undefined
    readonly response: EdgeTtsVoicesResponse
  }
  [COMMAND.fontsList]: {
    readonly request: undefined
    readonly response: readonly ReadingFont[]
  }
  [COMMAND.fontsImport]: {
    readonly request: FontImportRequest
    readonly response: ReadingFont
  }
  [COMMAND.fontsRemove]: {
    readonly request: FontRemoveRequest
    readonly response: boolean
  }
  [COMMAND.cloudConfigGet]: {
    readonly request: undefined
    readonly response: CloudConfigGetResponse
  }
  [COMMAND.cloudConfigSave]: {
    readonly request: CloudConfigSaveRequest
    readonly response: CloudConfigSaveResponse
  }
  [COMMAND.cloudConfigTest]: {
    readonly request: CloudConfigTestRequest
    readonly response: CloudConfigTestResponse
  }
  [COMMAND.cloudConfigClear]: {
    readonly request: undefined
    readonly response: CloudConfigClearResponse
  }
  [COMMAND.cloudWebdavGet]: {
    readonly request: CloudWebdavGetRequest
    readonly response: CloudWebdavGetResponse
  }
  [COMMAND.cloudWebdavPut]: {
    readonly request: CloudWebdavPutRequest
    readonly response: CloudWebdavPutResponse
  }
  [COMMAND.cloudBackup]: {
    readonly request: undefined
    readonly response: CloudBackupResponse
  }
  [COMMAND.cloudRestore]: {
    readonly request: undefined
    readonly response: CloudRestoreResponse
  }
  [COMMAND.aiArtifactSet]: {
    readonly request: AiArtifactSetRequest
    readonly response: AiArtifactSetResponse
  }
  [COMMAND.secretSet]: {
    readonly request: { readonly key: string; readonly value: string }
    readonly response: null
  }
  [COMMAND.secretDelete]: {
    readonly request: { readonly key: string }
    readonly response: { readonly deleted: boolean }
  }
}

export type CommandName = keyof CommandMap

const iso8601 = z.string().regex(ISO8601_PATTERN, 'must be an ISO 8601 timestamp')

export const systemPingRequestSchema = z.object({
  nonce: z.string().min(1).max(128),
})

export const systemPingResponseSchema = z.object({
  nonce: z.string().min(1),
  serverTime: iso8601,
  appVersion: z.string().min(1),
})

export const appInfoSchema = z.object({
  appName: z.string().min(1),
  appVersion: z.string().min(1),
  os: z.string().min(1),
  arch: z.string().min(1),
})

/** Book file hashes are lowercase SHA-256 hex strings (frontend computes via WebCrypto). */
const bookHash = z.string().regex(/^[a-f0-9]{64}$/, 'must be a SHA-256 hex digest')

const annotationRecordSchema = z.object({
  id: z.string().min(1).max(128),
  cfi: z.string().min(1).max(2048),
  color: z.string().min(1).max(32),
  note: z.string().max(4000).optional(),
  excerpt: z.string().max(2000).optional(),
  updatedAt: iso8601.optional(),
  deleted: z.boolean().optional(),
})

export const readerStatePayloadSchema = z.object({
  progress: z
    .object({ cfi: z.string().min(1).max(2048), fraction: z.number().min(0).max(1) })
    .nullable(),
  annotations: z.array(annotationRecordSchema).max(10_000),
  bookmarks: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        cfi: z.string().min(1).max(2048),
        label: z.string().max(200).optional(),
        createdAt: iso8601,
        deleted: z.boolean().optional(),
      }),
    )
    .max(2000),
  updatedAt: iso8601,
})

export const libraryBookSchema = z.object({
  hash: bookHash,
  fileName: z.string().min(1).max(512),
  displayName: z.string().min(1).max(512).nullable(),
  author: z.string().max(512).nullable(),
  subtitle: z.string().max(512).nullable(),
  publisher: z.string().max(512).nullable(),
  language: z.string().max(64).nullable(),
  format: z.string().min(1).max(16),
  path: z.string().min(1).max(4096),
  size: z.number().int().min(0),
  addedAt: iso8601,
  progress: z.number().min(0).max(1).nullable(),
  tags: z.array(z.string().min(1).max(32)).max(20),
})

export const readerStateGetRequestSchema = z.object({ bookHash })
export const readerStateGetResponseSchema = z.object({
  state: readerStatePayloadSchema.nullable(),
})
export const readerStateSetRequestSchema = z.object({
  bookHash,
  state: readerStatePayloadSchema,
})
export const readerStateSetResponseSchema = z.object({ savedAt: iso8601 })

export const libraryListResponseSchema = z.object({ books: z.array(libraryBookSchema).max(10_000) })
export const libraryImportRequestSchema = z.object({ path: z.string().min(1).max(4096) })
export const libraryImportResponseSchema = z.object({ book: libraryBookSchema })
export const libraryRemoveRequestSchema = z.object({ bookHash: bookHash })
export const libraryRemoveResponseSchema = z.object({ removed: z.boolean() })
export const libraryInfoSetRequestSchema = z.object({
  bookHash: bookHash,
  displayName: z.string().min(1).max(512).nullable(),
  author: z.string().max(512).nullable(),
  subtitle: z.string().max(512).nullable(),
  publisher: z.string().max(512).nullable(),
  language: z.string().max(64).nullable(),
})
export const libraryInfoSetResponseSchema = z.object({ book: libraryBookSchema })
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const readerStatsAddRequestSchema = z.object({
  bookHash: bookHash,
  day: dayKey,
  // One report never covers more than an hour (the reader flushes every 30s).
  seconds: z.number().int().min(0).max(3600),
})
export const readerStatsAddResponseSchema = z.object({ daySeconds: z.number().int().min(0) })
export const readerStatsGetResponseSchema = z.object({
  days: z.array(z.object({ day: dayKey, seconds: z.number().int().min(0) })).max(400),
  totalSeconds: z.number().int().min(0),
})
const bookReadingStatSchema = z.object({
  bookHash,
  displayName: z.string().max(512).nullable(),
  fileName: z.string().min(1).max(1024),
  seconds: z.number().int().min(0),
})
export const readerStatsBooksResponseSchema = z.object({
  books: z.array(bookReadingStatSchema).max(20),
})
const noteEntrySchema = z.object({
  id: z.string().min(1).max(128),
  bookHash,
  displayName: z.string().max(512).nullable(),
  fileName: z.string().min(1).max(1024),
  cfi: z.string().min(1).max(2048),
  color: z.string().min(1).max(32),
  note: z.string().max(4000).nullable(),
  excerpt: z.string().max(2000).nullable(),
  updatedAt: iso8601.nullable(),
})
export const readerNotesListResponseSchema = z.object({
  notes: z.array(noteEntrySchema).max(2000),
})
export const readerNoteUpdateRequestSchema = z.object({
  noteId: z.string().min(1).max(128),
  note: z.string().max(4000),
})
export const readerNoteUpdateResponseSchema = z.object({ entry: noteEntrySchema })
export const libraryTagSetRequestSchema = z.object({
  bookHash: bookHash,
  tags: z.array(z.string().min(1).max(32)).max(20),
})
export const libraryTagSetResponseSchema = z.object({ book: libraryBookSchema })
export const libraryCoverGetRequestSchema = z.object({ bookHash: bookHash })
export const libraryCoverGetResponseSchema = z.object({ path: z.string().max(4096).nullable() })
export const libraryCoverPutRequestSchema = z.object({
  bookHash: bookHash,
  data: z.string().min(1).max(12_000_000),
})
export const libraryCoverPutResponseSchema = z.object({ path: z.string().min(1).max(4096) })
export const notesExportRequestSchema = z.object({
  // 20 MB 上限:一整套批注的 Markdown 远小于它,留出余量防超大输入。
  markdown: z.string().max(20_000_000),
  defaultName: z.string().max(200),
})
export const notesExportResponseSchema = z.object({ path: z.string().max(4096).nullable() })

const dictionaryMetaSchema = z.object({
  id: z.string().min(8).max(64),
  name: z.string().min(1).max(256),
  wordCount: z.number().int().min(0),
  sametypesequence: z.string().max(16).optional(),
  ifoPath: z.string().min(1).max(4096),
  idxPath: z.string().min(1).max(4096),
  dictPath: z.string().min(1).max(4096),
})

export const dictionaryListResponseSchema = z.object({
  dictionaries: z.array(dictionaryMetaSchema).max(1000),
})
export const dictionaryRegisterRequestSchema = z.object({ path: z.string().min(1).max(4096) })
export const dictionaryRegisterResponseSchema = z.object({ dictionary: dictionaryMetaSchema })
export const dictionaryRemoveRequestSchema = z.object({ id: z.string().min(8).max(64) })
export const dictionaryRemoveResponseSchema = z.object({ removed: z.boolean() })

export const aiProviderConfigSchema = z.object({
  id: z.string().min(8).max(64),
  name: z.string().min(1).max(64),
  baseUrl: z.string().url().max(512),
  model: z.string().min(1).max(128),
  embeddingModel: z.string().min(1).max(128).optional(),
  ttsModel: z.string().min(1).max(128).optional(),
})
export type AiProviderConfigWire = z.output<typeof aiProviderConfigSchema>

export const aiConfigListResponseSchema = z.object({
  providers: z.array(aiProviderConfigSchema).max(100),
})
export const aiConfigSaveRequestSchema = z.object({
  provider: aiProviderConfigSchema,
  apiKey: z.string().min(1).max(512),
})
export const aiConfigSaveResponseSchema = z.object({ provider: aiProviderConfigSchema })
export const aiConfigRemoveRequestSchema = z.object({ id: z.string().min(8).max(64) })
export const aiConfigRemoveResponseSchema = z.object({ removed: z.boolean() })

export const aiChatRequestSchema = z.object({
  taskId: z.string().min(8).max(64),
  configId: z.string().min(8).max(64),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().max(100_000),
      }),
    )
    .min(1)
    .max(100),
  temperature: z.number().min(0).max(2).optional(),
})
export const aiChatResponseSchema = z.object({ taskId: z.string().min(8).max(64) })
export const aiCancelRequestSchema = z.object({ taskId: z.string().min(8).max(64) })
export const aiCancelResponseSchema = z.object({ cancelled: z.boolean() })

export const aiEmbedRequestSchema = z.object({
  taskId: z.string().min(8).max(64),
  configId: z.string().min(8).max(64),
  texts: z.array(z.string().max(20_000)).min(1).max(500),
})
export const aiEmbedResponseSchema = z.object({
  vectors: z.array(z.array(z.number()).min(1).max(4096)).max(500),
})
const aiIndexChunkSchema = z.object({
  label: z.string().min(1).max(200),
  text: z.string().max(20_000),
  vector: z.array(z.number()).min(1).max(4096),
})
export const aiIndexPayloadSchema = z.object({
  chunks: z.array(aiIndexChunkSchema).max(5000),
  embeddingModel: z.string().min(1).max(128),
  createdAt: iso8601,
})
export const aiIndexGetRequestSchema = z.object({ bookHash })
export const aiIndexGetResponseSchema = z.object({ index: aiIndexPayloadSchema.nullable() })
export const aiIndexSetRequestSchema = z.object({ bookHash, index: aiIndexPayloadSchema })
export const aiIndexSetResponseSchema = z.object({ savedAt: iso8601 })

export const artifactKindSchema = z.enum(['summary', 'outline', 'notes', 'characters'])
export const aiArtifactGetRequestSchema = z.object({
  bookHash,
  kind: artifactKindSchema,
})
export const storageBackupRequestSchema = z.object({
  path: z.string().min(1).max(4096),
})
export const storageBackupResponseSchema = z.object({
  bytes: z.number().int().min(0),
  checksum: z.string().length(64),
})
export const storageRestoreRequestSchema = z.object({
  path: z.string().min(1).max(4096),
  checksum: z.string().length(64),
})
export const storageRestoreResponseSchema = z.object({ restored: z.boolean() })
export const aiArtifactGetResponseSchema = z.object({
  payload: z.record(z.string(), z.unknown()).nullable(),
  createdAt: iso8601.nullable(),
})
export const aiArtifactSetRequestSchema = z.object({
  bookHash,
  kind: artifactKindSchema,
  payload: z.record(z.string(), z.unknown()),
})
export const aiArtifactSetResponseSchema = z.object({ savedAt: iso8601 })

export const secretSetRequestSchema = z.object({
  key: z.string().min(4).max(128),
  value: z.string().max(4096),
})
export const secretSetResponseSchema = z.null()
export const secretDeleteRequestSchema = z.object({ key: z.string().min(4).max(128) })
export const secretDeleteResponseSchema = z.object({ deleted: z.boolean() })

const cardSourceSchema = z.enum(['highlight', 'quiz', 'mistake'])

export const cardsListRequestSchema = z.object({ bookHash: bookHash.optional() })
export const learningCardSchema = z.object({
  id: z.string().min(1).max(128),
  bookHash: bookHash,
  front: z.string().min(1).max(2000),
  back: z.string().min(1).max(4000),
  source: cardSourceSchema,
  cfi: z.string().min(1).max(2048).optional(),
  ease: z.number().min(1).max(10),
  intervalDays: z.number().min(0).max(365),
  reps: z.number().int().min(0).max(100_000),
  lapses: z.number().int().min(0).max(100_000),
  dueAt: iso8601,
  createdAt: iso8601,
})
export const cardsListResponseSchema = z.object({
  cards: z.array(learningCardSchema).max(50_000),
})
export const cardsAddRequestSchema = z.object({
  bookHash: bookHash,
  cards: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        front: z.string().min(1).max(2000),
        back: z.string().min(1).max(4000),
        source: cardSourceSchema,
        cfi: z.string().min(1).max(2048).optional(),
        dueAt: iso8601,
      }),
    )
    .min(1)
    .max(200),
})
export const cardsAddResponseSchema = z.object({
  added: z.number().int().min(0).max(200),
  savedAt: iso8601,
})
export const cardsRemoveRequestSchema = z.object({ id: z.string().min(1).max(128) })
export const cardsRemoveResponseSchema = z.object({ removed: z.boolean() })
export const cardsReviewRequestSchema = z.object({
  id: z.string().min(1).max(128),
  ease: z.number().min(1).max(10),
  intervalDays: z.number().min(0).max(365),
  reps: z.number().int().min(0).max(100_000),
  lapses: z.number().int().min(0).max(100_000),
  dueAt: iso8601,
})
export const cardsReviewResponseSchema = z.object({ dueAt: iso8601 })

export const ttsAudioRequestSchema = z.object({
  configId: z.string().min(8).max(64),
  text: z.string().min(1).max(5000),
  voice: z.string().min(1).max(64),
  speed: z.number().min(0.25).max(4).optional(),
})
export const ttsAudioResponseSchema = z.object({
  path: z.string().min(1).max(4096),
  cached: z.boolean(),
})

export const edgeTtsAudioRequestSchema = z.object({
  text: z.string().min(1).max(5000),
  voice: z.string().min(1).max(128),
  lang: z.string().max(16).optional(),
  rate: z.number().min(0.25).max(4).optional(),
})
export const edgeTtsAudioResponseSchema = z.object({
  path: z.string().min(1).max(4096),
  cached: z.boolean(),
})
export const edgeTtsVoiceSchema = z.object({
  shortName: z.string().min(1).max(128),
  friendlyName: z.string().max(256),
  locale: z.string().max(32),
  gender: z.string().max(16),
})
export const edgeTtsVoicesResponseSchema = z.object({
  voices: z.array(edgeTtsVoiceSchema),
})

export const readingFontSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  fileName: z.string().min(1).max(256),
  path: z.string().min(1).max(1024),
})

export const fontsListResponseSchema = z.array(readingFontSchema)
export const fontsImportResponseSchema = readingFontSchema
export const fontsRemoveResponseSchema = z.boolean()
export const fontImportRequestSchema = z.object({ path: z.string().min(1).max(1024) })
export const fontRemoveRequestSchema = z.object({ id: z.string().min(1).max(64) })

const webdavEndpoint = z.string().url().max(512)
const webdavPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes('\\'), {
    message: 'path must not contain backslashes',
  })

export const cloudConfigGetResponseSchema = z.object({
  config: z.object({ endpoint: webdavEndpoint, username: z.string().min(1).max(256) }).nullable(),
  deviceId: z.string().min(8).max(64),
  deviceName: z.string().min(1).max(128),
})
export const cloudConfigSaveRequestSchema = z.object({
  endpoint: webdavEndpoint,
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(512),
})
export const cloudConfigSaveResponseSchema = z.object({
  config: z.object({ endpoint: webdavEndpoint, username: z.string().min(1).max(256) }),
})
export const cloudConfigTestRequestSchema = z.object({
  endpoint: webdavEndpoint,
  username: z.string().min(1).max(256),
  password: z.string().max(512),
})
export const cloudConfigTestResponseSchema = z.object({ ok: z.literal(true) })
export const cloudConfigClearResponseSchema = z.object({ cleared: z.literal(true) })
export const cloudWebdavGetRequestSchema = z.object({ path: webdavPath })
export const cloudWebdavGetResponseSchema = z.object({
  body: z
    .string()
    .max(64 * 1024 * 1024)
    .nullable(),
})
export const cloudWebdavPutRequestSchema = z.object({
  path: webdavPath,
  body: z.string().max(64 * 1024 * 1024),
})
export const cloudWebdavPutResponseSchema = z.object({ ok: z.literal(true) })
export const cloudBackupResponseSchema = z.object({
  remotePath: z.string().min(1).max(1024),
  bytes: z.number().int().min(0),
  checksum: z.string().length(64),
})
export const cloudRestoreResponseSchema = z.object({ restored: z.literal(true) })

/** Minimal structural interface any zod schema satisfies — keeps the map version-proof. */
export interface ResponseValidator<T> {
  parse(value: unknown): T
}

export const responseValidators: {
  [K in CommandName]: ResponseValidator<CommandMap[K]['response']>
} = {
  [COMMAND.systemPing]: systemPingResponseSchema,
  [COMMAND.appInfo]: appInfoSchema,
  [COMMAND.readerStateGet]: readerStateGetResponseSchema,
  [COMMAND.readerStateSet]: readerStateSetResponseSchema,
  [COMMAND.libraryList]: libraryListResponseSchema,
  [COMMAND.libraryImport]: libraryImportResponseSchema,
  [COMMAND.libraryRemove]: libraryRemoveResponseSchema,
  [COMMAND.libraryInfoSet]: libraryInfoSetResponseSchema,
  [COMMAND.libraryTagSet]: libraryTagSetResponseSchema,
  [COMMAND.readerStatsAdd]: readerStatsAddResponseSchema,
  [COMMAND.readerStatsGet]: readerStatsGetResponseSchema,
  [COMMAND.readerStatsBooks]: readerStatsBooksResponseSchema,
  [COMMAND.readerNotesList]: readerNotesListResponseSchema,
  [COMMAND.readerNoteUpdate]: readerNoteUpdateResponseSchema,
  [COMMAND.libraryCoverGet]: libraryCoverGetResponseSchema,
  [COMMAND.libraryCoverPut]: libraryCoverPutResponseSchema,
  [COMMAND.notesExport]: notesExportResponseSchema,
  [COMMAND.dictionaryList]: dictionaryListResponseSchema,
  [COMMAND.dictionaryRegister]: dictionaryRegisterResponseSchema,
  [COMMAND.dictionaryRemove]: dictionaryRemoveResponseSchema,
  [COMMAND.aiConfigList]: aiConfigListResponseSchema,
  [COMMAND.aiConfigSave]: aiConfigSaveResponseSchema,
  [COMMAND.aiConfigRemove]: aiConfigRemoveResponseSchema,
  [COMMAND.aiChat]: aiChatResponseSchema,
  [COMMAND.aiCancel]: aiCancelResponseSchema,
  [COMMAND.aiEmbed]: aiEmbedResponseSchema,
  [COMMAND.aiIndexGet]: aiIndexGetResponseSchema,
  [COMMAND.aiIndexSet]: aiIndexSetResponseSchema,
  [COMMAND.aiArtifactGet]: aiArtifactGetResponseSchema,
  [COMMAND.aiArtifactSet]: aiArtifactSetResponseSchema,
  [COMMAND.storageBackup]: storageBackupResponseSchema,
  [COMMAND.storageRestore]: storageRestoreResponseSchema,
  [COMMAND.secretSet]: secretSetResponseSchema,
  [COMMAND.secretDelete]: secretDeleteResponseSchema,
  [COMMAND.cardsList]: cardsListResponseSchema,
  [COMMAND.cardsAdd]: cardsAddResponseSchema,
  [COMMAND.cardsRemove]: cardsRemoveResponseSchema,
  [COMMAND.cardsReview]: cardsReviewResponseSchema,
  [COMMAND.ttsAudio]: ttsAudioResponseSchema,
  [COMMAND.ttsEdgeAudio]: edgeTtsAudioResponseSchema,
  [COMMAND.ttsEdgeVoices]: edgeTtsVoicesResponseSchema,
  [COMMAND.fontsList]: fontsListResponseSchema,
  [COMMAND.fontsImport]: fontsImportResponseSchema,
  [COMMAND.fontsRemove]: fontsRemoveResponseSchema,
  [COMMAND.cloudConfigGet]: cloudConfigGetResponseSchema,
  [COMMAND.cloudConfigSave]: cloudConfigSaveResponseSchema,
  [COMMAND.cloudConfigTest]: cloudConfigTestResponseSchema,
  [COMMAND.cloudConfigClear]: cloudConfigClearResponseSchema,
  [COMMAND.cloudWebdavGet]: cloudWebdavGetResponseSchema,
  [COMMAND.cloudWebdavPut]: cloudWebdavPutResponseSchema,
  [COMMAND.cloudBackup]: cloudBackupResponseSchema,
  [COMMAND.cloudRestore]: cloudRestoreResponseSchema,
}

export const requestValidators: { [K in CommandName]: ResponseValidator<unknown> | undefined } = {
  [COMMAND.systemPing]: systemPingRequestSchema,
  [COMMAND.appInfo]: undefined,
  [COMMAND.readerStateGet]: readerStateGetRequestSchema,
  [COMMAND.readerStateSet]: readerStateSetRequestSchema,
  [COMMAND.libraryList]: undefined,
  [COMMAND.libraryImport]: libraryImportRequestSchema,
  [COMMAND.libraryRemove]: libraryRemoveRequestSchema,
  [COMMAND.libraryInfoSet]: libraryInfoSetRequestSchema,
  [COMMAND.libraryTagSet]: libraryTagSetRequestSchema,
  [COMMAND.readerStatsAdd]: readerStatsAddRequestSchema,
  [COMMAND.readerStatsGet]: undefined,
  [COMMAND.readerStatsBooks]: undefined,
  [COMMAND.readerNotesList]: undefined,
  [COMMAND.readerNoteUpdate]: readerNoteUpdateRequestSchema,
  [COMMAND.libraryCoverGet]: libraryCoverGetRequestSchema,
  [COMMAND.libraryCoverPut]: libraryCoverPutRequestSchema,
  [COMMAND.notesExport]: notesExportRequestSchema,
  [COMMAND.dictionaryList]: undefined,
  [COMMAND.dictionaryRegister]: dictionaryRegisterRequestSchema,
  [COMMAND.dictionaryRemove]: dictionaryRemoveRequestSchema,
  [COMMAND.aiChat]: aiChatRequestSchema,
  [COMMAND.aiCancel]: aiCancelRequestSchema,
  [COMMAND.aiEmbed]: aiEmbedRequestSchema,
  [COMMAND.aiIndexGet]: aiIndexGetRequestSchema,
  [COMMAND.aiIndexSet]: aiIndexSetRequestSchema,
  [COMMAND.aiArtifactGet]: aiArtifactGetRequestSchema,
  [COMMAND.storageBackup]: storageBackupRequestSchema,
  [COMMAND.storageRestore]: storageRestoreRequestSchema,
  [COMMAND.aiArtifactSet]: aiArtifactSetRequestSchema,
  [COMMAND.aiConfigSave]: aiConfigSaveRequestSchema,
  [COMMAND.aiConfigRemove]: aiConfigRemoveRequestSchema,
  [COMMAND.secretSet]: secretSetRequestSchema,
  [COMMAND.secretDelete]: secretDeleteRequestSchema,
  [COMMAND.aiConfigList]: undefined,
  [COMMAND.cardsList]: cardsListRequestSchema,
  [COMMAND.cardsAdd]: cardsAddRequestSchema,
  [COMMAND.cardsRemove]: cardsRemoveRequestSchema,
  [COMMAND.cardsReview]: cardsReviewRequestSchema,
  [COMMAND.ttsAudio]: ttsAudioRequestSchema,
  [COMMAND.ttsEdgeAudio]: edgeTtsAudioRequestSchema,
  [COMMAND.ttsEdgeVoices]: undefined,
  [COMMAND.fontsList]: undefined,
  [COMMAND.fontsImport]: fontImportRequestSchema,
  [COMMAND.fontsRemove]: fontRemoveRequestSchema,
  [COMMAND.cloudConfigGet]: undefined,
  [COMMAND.cloudConfigSave]: cloudConfigSaveRequestSchema,
  [COMMAND.cloudConfigTest]: cloudConfigTestRequestSchema,
  [COMMAND.cloudConfigClear]: undefined,
  [COMMAND.cloudWebdavGet]: cloudWebdavGetRequestSchema,
  [COMMAND.cloudWebdavPut]: cloudWebdavPutRequestSchema,
  [COMMAND.cloudBackup]: undefined,
  [COMMAND.cloudRestore]: undefined,
}
