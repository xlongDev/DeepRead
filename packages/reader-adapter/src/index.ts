/// <reference path="./foliate-js.d.ts" />
/// <reference path="./vite-env.d.ts" />

export * from './engine'
export * from './covers'
export * from './enhance/text-repair'
export * from './format'
export { buildMobiBook } from './books/mobi-book'
export {
  buildIndex,
  type DefinitionField,
  decodeFields,
  dictionaryFileCandidates,
  inflateGzip,
  lookupWord,
  sanitizeDefinitionHtml,
} from './dictionary/stardict'
export {
  buildTextBook,
  chapterSections,
  decodeText,
  escapeHtml,
  splitParagraphs,
} from './books/text-book'
export { buildMarkdownBook, markdownToHtml } from './books/markdown-book'
export { convertSectionDocument, convertZhText, prepareZhConvert } from './zh-convert'
