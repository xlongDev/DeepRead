/**
 * AI provider wire schemas — single source of truth is the IPC protocol
 * catalog (`@deepread/shared`). This module re-exports the AI subset so
 * `@deepread/ai-core` keeps its public surface without a second copy that
 * can drift (the removed copy was already missing embeddingModel/ttsModel
 * and had a looser apiKey bound than the protocol).
 */

export {
  aiProviderConfigSchema,
  aiConfigListResponseSchema,
  aiConfigSaveRequestSchema,
  aiConfigRemoveRequestSchema,
  aiChatRequestSchema,
} from '@deepread/shared'
export type { AiProviderConfigWire } from '@deepread/shared'
