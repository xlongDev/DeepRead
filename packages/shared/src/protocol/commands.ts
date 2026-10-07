/**
 * Typed IPC command catalog.
 *
 * Rules (spec §40 / §57 / ADR-0008):
 * - every command has a name, request type, response type and error type (`AppErrorPayload`)
 * - **类型源 = Rust DTO**:wire 类型由 ts-rs 从 Rust 结构体生成到 `./generated/`
 *   (`cargo test` 刷新,CI 以 `git diff --exit-code` 门禁,生成物不入手改)。
 *   下面的 import 把生成类型以协议名重导出 —— 改形状去改 Rust,不要改这里。
 * - responses are untrusted input: the frontend validates them with the zod
 *   schemas below; `protocol.test.ts` 把校验器输出对生成类型做编译期断言,
 *   类型漂移从此是编译错误而不是靠人眼
 * - requests are validated on the Rust side by typed serde structs + explicit checks
 */

import { z } from 'zod'
import { ISO8601_PATTERN } from '../types'

// ---------- wire 类型:ts-rs 生成(ADR-0008),别名保持前端既有命名 ----------

import type { PingRequest as SystemPingRequest } from './generated/PingRequest'
import type { PingResponse as SystemPingResponse } from './generated/PingResponse'
import type { AppInfo } from './generated/AppInfo'
import type { StoredAnnotation as AnnotationRecord } from './generated/StoredAnnotation'
import type { StoredBookmark as BookmarkRecord } from './generated/StoredBookmark'
import type { ReaderState as ReaderStatePayload } from './generated/ReaderState'
import type { BookReadingStat } from './generated/BookReadingStat'
import type { NoteEntry } from './generated/NoteEntry'
import type { StateGetRequest as ReaderStateGetRequest } from './generated/StateGetRequest'
import type { StateGetResponse as ReaderStateGetResponse } from './generated/StateGetResponse'
import type { StateSetRequest as ReaderStateSetRequest } from './generated/StateSetRequest'
import type { StateSetResponse as ReaderStateSetResponse } from './generated/StateSetResponse'
import type { StatsAddRequest as ReaderStatsAddRequest } from './generated/StatsAddRequest'
import type { StatsAddResponse as ReaderStatsAddResponse } from './generated/StatsAddResponse'
import type { StatsGetResponse as ReaderStatsGetResponse } from './generated/StatsGetResponse'
import type { StatsBooksResponse as ReaderStatsBooksResponse } from './generated/StatsBooksResponse'
import type { NotesListResponse as ReaderNotesListResponse } from './generated/NotesListResponse'
import type { NoteUpdateRequest as ReaderNoteUpdateRequest } from './generated/NoteUpdateRequest'
import type { NoteUpdateResponse as ReaderNoteUpdateResponse } from './generated/NoteUpdateResponse'
import type { LibraryBook } from './generated/LibraryBook'
import type { LibraryListResponse } from './generated/LibraryListResponse'
import type { LibraryImportRequest } from './generated/LibraryImportRequest'
import type { LibraryImportResponse } from './generated/LibraryImportResponse'
import type { LibraryRemoveRequest } from './generated/LibraryRemoveRequest'
import type { LibraryRemoveResponse } from './generated/LibraryRemoveResponse'
import type { LibraryInfoSetRequest } from './generated/LibraryInfoSetRequest'
import type { LibraryInfoSetResponse } from './generated/LibraryInfoSetResponse'
import type { LibraryTagSetRequest } from './generated/LibraryTagSetRequest'
import type { LibraryTagSetResponse } from './generated/LibraryTagSetResponse'
import type { LibraryCoverGetRequest } from './generated/LibraryCoverGetRequest'
import type { LibraryCoverGetResponse } from './generated/LibraryCoverGetResponse'
import type { LibraryCoverPutRequest } from './generated/LibraryCoverPutRequest'
import type { LibraryCoverPutResponse } from './generated/LibraryCoverPutResponse'
import type { NotesExportRequest } from './generated/NotesExportRequest'
import type { NotesExportResponse } from './generated/NotesExportResponse'
import type { DictionaryMeta } from './generated/DictionaryMeta'
import type { DictionaryListResponse } from './generated/DictionaryListResponse'
import type { DictionaryRegisterRequest } from './generated/DictionaryRegisterRequest'
import type { DictionaryRegisterResponse } from './generated/DictionaryRegisterResponse'
import type { DictionaryRemoveRequest } from './generated/DictionaryRemoveRequest'
import type { DictionaryRemoveResponse } from './generated/DictionaryRemoveResponse'
import type { AiProviderConfig } from './generated/AiProviderConfig'
import type { AiConfigListResponse } from './generated/AiConfigListResponse'
import type { AiConfigSaveRequest } from './generated/AiConfigSaveRequest'
import type { AiConfigSaveResponse } from './generated/AiConfigSaveResponse'
import type { AiConfigRemoveRequest } from './generated/AiConfigRemoveRequest'
import type { AiConfigRemoveResponse } from './generated/AiConfigRemoveResponse'
import type { AiChatRequest } from './generated/AiChatRequest'
import type { AiChatResponse } from './generated/AiChatResponse'
import type { AiCancelRequest } from './generated/AiCancelRequest'
import type { AiCancelResponse } from './generated/AiCancelResponse'
import type { AiEmbedRequest } from './generated/AiEmbedRequest'
import type { AiEmbedResponse } from './generated/AiEmbedResponse'
import type { AiIndexChunk } from './generated/AiIndexChunk'
import type { AiIndexPayload } from './generated/AiIndexPayload'
import type { AiIndexGetRequest } from './generated/AiIndexGetRequest'
import type { AiIndexGetResponse } from './generated/AiIndexGetResponse'
import type { AiIndexSetRequest } from './generated/AiIndexSetRequest'
import type { AiIndexSetResponse } from './generated/AiIndexSetResponse'
import type { AiArtifactGetRequest } from './generated/AiArtifactGetRequest'
import type { AiArtifactGetResponse } from './generated/AiArtifactGetResponse'
import type { AiArtifactSetRequest } from './generated/AiArtifactSetRequest'
import type { AiArtifactSetResponse } from './generated/AiArtifactSetResponse'
import type { StorageBackupRequest } from './generated/StorageBackupRequest'
import type { StorageBackupResponse } from './generated/StorageBackupResponse'
import type { StorageRestoreRequest } from './generated/StorageRestoreRequest'
import type { StorageRestoreResponse } from './generated/StorageRestoreResponse'
import type { SecretSetRequest } from './generated/SecretSetRequest'
import type { SecretDeleteRequest } from './generated/SecretDeleteRequest'
import type { SecretDeleteResponse } from './generated/SecretDeleteResponse'
import type { CardRow as LearningCard } from './generated/CardRow'
import type { NewCard as NewCardInput } from './generated/NewCard'
import type { CardsListRequest } from './generated/CardsListRequest'
import type { CardsListResponse } from './generated/CardsListResponse'
import type { CardsAddRequest } from './generated/CardsAddRequest'
import type { CardsAddResponse } from './generated/CardsAddResponse'
import type { CardsRemoveRequest } from './generated/CardsRemoveRequest'
import type { CardsRemoveResponse } from './generated/CardsRemoveResponse'
import type { CardsReviewRequest } from './generated/CardsReviewRequest'
import type { CardsReviewResponse } from './generated/CardsReviewResponse'
import type { TtsAudioRequest } from './generated/TtsAudioRequest'
import type { TtsAudioResponse } from './generated/TtsAudioResponse'
import type { EdgeTtsAudioRequest } from './generated/EdgeTtsAudioRequest'
import type { EdgeTtsAudioResponse } from './generated/EdgeTtsAudioResponse'
import type { EdgeVoice as EdgeTtsVoice } from './generated/EdgeVoice'
import type { EdgeVoicesResponse as EdgeTtsVoicesResponse } from './generated/EdgeVoicesResponse'
import type { ReadingFont } from './generated/ReadingFont'
import type { FontImportRequest } from './generated/FontImportRequest'
import type { FontRemoveRequest } from './generated/FontRemoveRequest'
import type { CloudConfig } from './generated/CloudConfig'
import type { CloudConfigGetResponse } from './generated/CloudConfigGetResponse'
import type { CloudConfigSaveRequest } from './generated/CloudConfigSaveRequest'
import type { CloudConfigSaveResponse } from './generated/CloudConfigSaveResponse'
import type { CloudConfigTestRequest } from './generated/CloudConfigTestRequest'
import type { CloudTestResponse as CloudConfigTestResponse } from './generated/CloudTestResponse'
import type { CloudClearResponse as CloudConfigClearResponse } from './generated/CloudClearResponse'
import type { CloudWebdavGetRequest } from './generated/CloudWebdavGetRequest'
import type { CloudWebdavGetResponse } from './generated/CloudWebdavGetResponse'
import type { CloudWebdavPutRequest } from './generated/CloudWebdavPutRequest'
import type { CloudWebdavPutResponse } from './generated/CloudWebdavPutResponse'
import type { CloudBackupResponse } from './generated/CloudBackupResponse'
import type { CloudRestoreResponse } from './generated/CloudRestoreResponse'

export type {
  AiArtifactGetRequest,
  AiArtifactGetResponse,
  AiArtifactSetRequest,
  AiArtifactSetResponse,
  AiCancelRequest,
  AiCancelResponse,
  AiChatRequest,
  AiChatResponse,
  AiConfigListResponse,
  AiConfigRemoveRequest,
  AiConfigRemoveResponse,
  AiConfigSaveRequest,
  AiConfigSaveResponse,
  AiEmbedRequest,
  AiEmbedResponse,
  AiIndexChunk,
  AiIndexGetRequest,
  AiIndexGetResponse,
  AiIndexPayload,
  AiIndexSetRequest,
  AiIndexSetResponse,
  AiProviderConfig,
  AnnotationRecord,
  AppInfo,
  BookReadingStat,
  BookmarkRecord,
  CardsAddRequest,
  CardsAddResponse,
  CardsListRequest,
  CardsListResponse,
  CardsRemoveRequest,
  CardsRemoveResponse,
  CardsReviewRequest,
  CardsReviewResponse,
  CloudBackupResponse,
  CloudConfig,
  CloudConfigClearResponse,
  CloudConfigGetResponse,
  CloudConfigSaveRequest,
  CloudConfigSaveResponse,
  CloudConfigTestRequest,
  CloudConfigTestResponse,
  CloudRestoreResponse,
  CloudWebdavGetRequest,
  CloudWebdavGetResponse,
  CloudWebdavPutRequest,
  CloudWebdavPutResponse,
  DictionaryListResponse,
  DictionaryMeta,
  DictionaryRegisterRequest,
  DictionaryRegisterResponse,
  DictionaryRemoveRequest,
  DictionaryRemoveResponse,
  EdgeTtsAudioRequest,
  EdgeTtsAudioResponse,
  EdgeTtsVoice,
  EdgeTtsVoicesResponse,
  FontImportRequest,
  FontRemoveRequest,
  LearningCard,
  LibraryBook,
  LibraryCoverGetRequest,
  LibraryCoverGetResponse,
  LibraryCoverPutRequest,
  LibraryCoverPutResponse,
  LibraryImportRequest,
  LibraryImportResponse,
  LibraryInfoSetRequest,
  LibraryInfoSetResponse,
  LibraryListResponse,
  LibraryRemoveRequest,
  LibraryRemoveResponse,
  LibraryTagSetRequest,
  LibraryTagSetResponse,
  NewCardInput,
  NoteEntry,
  NotesExportRequest,
  NotesExportResponse,
  ReaderNoteUpdateRequest,
  ReaderNoteUpdateResponse,
  ReaderNotesListResponse,
  ReaderStateGetRequest,
  ReaderStateGetResponse,
  ReaderStatePayload,
  ReaderStateSetRequest,
  ReaderStateSetResponse,
  ReaderStatsAddRequest,
  ReaderStatsAddResponse,
  ReaderStatsBooksResponse,
  ReaderStatsGetResponse,
  ReadingFont,
  SecretDeleteRequest,
  SecretDeleteResponse,
  SecretSetRequest,
  StorageBackupRequest,
  StorageBackupResponse,
  StorageRestoreRequest,
  StorageRestoreResponse,
  SystemPingRequest,
  SystemPingResponse,
  TtsAudioRequest,
  TtsAudioResponse,
}

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

/** The single source of truth for command request/response shapes(类型 = 生成物). */
export interface CommandMap {
  [COMMAND.systemPing]: {
    readonly request: SystemPingRequest
    readonly response: SystemPingResponse
  }
  [COMMAND.appInfo]: { readonly request: undefined; readonly response: AppInfo }
  [COMMAND.readerStateGet]: {
    readonly request: ReaderStateGetRequest
    readonly response: ReaderStateGetResponse
  }
  [COMMAND.readerStateSet]: {
    readonly request: ReaderStateSetRequest
    readonly response: ReaderStateSetResponse
  }
  [COMMAND.libraryList]: { readonly request: undefined; readonly response: LibraryListResponse }
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
  [COMMAND.aiConfigList]: { readonly request: undefined; readonly response: AiConfigListResponse }
  [COMMAND.aiConfigSave]: {
    readonly request: AiConfigSaveRequest
    readonly response: AiConfigSaveResponse
  }
  [COMMAND.aiConfigRemove]: {
    readonly request: AiConfigRemoveRequest
    readonly response: AiConfigRemoveResponse
  }
  /** ai.chat streams events through a Tauri Channel, not the return value. */
  [COMMAND.aiChat]: { readonly request: AiChatRequest; readonly response: AiChatResponse }
  [COMMAND.aiCancel]: { readonly request: AiCancelRequest; readonly response: AiCancelResponse }
  [COMMAND.aiEmbed]: { readonly request: AiEmbedRequest; readonly response: AiEmbedResponse }
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
  [COMMAND.aiArtifactSet]: {
    readonly request: AiArtifactSetRequest
    readonly response: AiArtifactSetResponse
  }
  [COMMAND.storageBackup]: {
    readonly request: StorageBackupRequest
    readonly response: StorageBackupResponse
  }
  [COMMAND.storageRestore]: {
    readonly request: StorageRestoreRequest
    readonly response: StorageRestoreResponse
  }
  [COMMAND.secretSet]: { readonly request: SecretSetRequest; readonly response: null }
  [COMMAND.secretDelete]: {
    readonly request: SecretDeleteRequest
    readonly response: SecretDeleteResponse
  }
  [COMMAND.cardsList]: { readonly request: CardsListRequest; readonly response: CardsListResponse }
  [COMMAND.cardsAdd]: { readonly request: CardsAddRequest; readonly response: CardsAddResponse }
  [COMMAND.cardsRemove]: {
    readonly request: CardsRemoveRequest
    readonly response: CardsRemoveResponse
  }
  [COMMAND.cardsReview]: {
    readonly request: CardsReviewRequest
    readonly response: CardsReviewResponse
  }
  [COMMAND.ttsAudio]: { readonly request: TtsAudioRequest; readonly response: TtsAudioResponse }
  [COMMAND.ttsEdgeAudio]: {
    readonly request: EdgeTtsAudioRequest
    readonly response: EdgeTtsAudioResponse
  }
  [COMMAND.ttsEdgeVoices]: { readonly request: undefined; readonly response: EdgeTtsVoicesResponse }
  [COMMAND.fontsList]: { readonly request: undefined; readonly response: ReadingFont[] }
  [COMMAND.fontsImport]: { readonly request: FontImportRequest; readonly response: ReadingFont }
  [COMMAND.fontsRemove]: { readonly request: FontRemoveRequest; readonly response: boolean }
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
  [COMMAND.cloudBackup]: { readonly request: undefined; readonly response: CloudBackupResponse }
  [COMMAND.cloudRestore]: { readonly request: undefined; readonly response: CloudRestoreResponse }
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

/**
 * 响应校验器的具体 zod 表 —— 仅供 protocol.test.ts 的编译期 wire 断言读取
 * (responseValidators 的注解类型把 zod 形状擦成了 ResponseValidator<T>)。
 */
export const responseSchemas = {
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

export const responseValidators: {
  [K in CommandName]: ResponseValidator<CommandMap[K]['response']>
} = responseSchemas

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

/** 协议枚举的 TS 侧单一来源:与 Rust 侧的字符串清单(ADD_CARDS/validate_artifact_kind)对齐。 */
export type AiArtifactKind = z.output<typeof artifactKindSchema>
export type CardSource = z.output<typeof cardSourceSchema>
