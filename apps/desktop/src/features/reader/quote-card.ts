/**
 * 金句分享卡:选区/划线 → 一张可保存的 PNG。
 *
 * 刻意不用 quote-image 之类的现成库:卡面要跟阅读主题同一套纸色与墨色,库的
 * 版式反而帮倒忙,而排版 + 文本折行 + 一条分割线是自己写得完的量。折行与
 * 排版决策是纯函数(量宽以回调注入)才可单测 —— jsdom 没有 canvas。
 *
 * 版面(v2):**高度随内容自适应**(1080~1440),引文块在引号区与署名区之间
 * 做光学分配(富余空间 38% 在上、62% 在下 —— 视觉重心偏下更稳),字号随
 * 引句长度缩放。分享卡是「顺手一次」的动作,不给样式选项。
 */

/** CJK 字符逐字断行;西文单词与空格作整块,不在词中间断。 */
export function wrapLines(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
): string[] {
  const units = text.match(/\s+|[\w'’-]+|[^\s]/gu)
  const lines: string[] = []
  let line = ''
  for (const unit of units ?? []) {
    if (/^\s+$/.test(unit)) {
      // 空白:行首丢弃,行尾暂挂 —— 推行时随 trimEnd 一起吞掉。
      if (line !== '') line += ' '
      continue
    }
    if (line !== '' && measure(line + unit) > maxWidth) {
      if (NO_LINE_START.test(unit)) {
        // 行头禁则:标点挂在本行行尾,轻微超宽也比分行头一个标点好看。
        line += unit
      } else {
        lines.push(line.trimEnd())
        line = unit
      }
    } else {
      line += unit
    }
  }
  if (line !== '') lines.push(line.trimEnd())
  return lines
}

/** 行头禁则:这些收尾标点不打头,宁可轻微超宽也要追到上一行行尾。 */
const NO_LINE_START = /^[，。、；：？！”’』」）》〕…—·%,;:?!)]$/u

/** 卡片装不下整段划线:超长截断(工具条的笔记上限是 500,卡片再放宽就散了)。 */
const QUOTE_MAX_CHARS = 400
/** 版心能排下的行数上限(44px 档、最高卡):超出加省略号,不悄悄丢行。 */
const QUOTE_MAX_LINES = 12

const QUOTE_FONT_STACK = `'LXGW WenKai', 'Songti SC', 'Noto Serif CJK SC', serif`

/** 排版决策(纯):字号随引句长度缩放 —— 短句给大字,长句收敛;折行按最终
 *  字号量宽(量宽回调带字号),行数封顶、溢出末行打省略号。 */
export function quoteLayout(
  measureAt: (fontSize: number, text: string) => number,
  quote: string,
  maxWidth: number,
): { fontSize: number; lineHeight: number; lines: string[]; truncated: boolean } {
  // 按码点截断(slice 会把 emoji 切成半个代理对,画出来是 replacement char)。
  const chars = [...quote.trim()]
  const truncatedByChars = chars.length > QUOTE_MAX_CHARS
  const trimmed = chars.slice(0, QUOTE_MAX_CHARS).join('')
  const fontSize = trimmed.length <= 60 ? 58 : trimmed.length <= 150 ? 50 : 44
  const lineHeight = Math.round(fontSize * 1.75)
  let lines = wrapLines((text) => measureAt(fontSize, text), trimmed, maxWidth)
  let truncated = truncatedByChars
  if (lines.length > QUOTE_MAX_LINES) {
    lines = lines.slice(0, QUOTE_MAX_LINES)
    lines[QUOTE_MAX_LINES - 1] += '…'
    truncated = true
  }
  return { fontSize, lineHeight, lines, truncated }
}

export interface QuoteCardSpec {
  readonly quote: string
  readonly bookTitle: string
  /** 作者(书元数据里有就带上):署名区第二行,比书名更淡一号。 */
  readonly author?: string
  /** 墨水色(划线色),用作引号、分割线的强调色。 */
  readonly accent: string
  /** 纸色与字色:跟当前阅读主题同源,深色主题分享出深色卡。 */
  readonly paper: string
  readonly ink: string
}

/** 画一张分享卡并返回 PNG data URL。canvas 上下文拿不到(null)返回 null。 */
export function drawQuoteCard(
  canvas: HTMLCanvasElement,
  { quote, bookTitle, author, accent, paper, ink }: QuoteCardSpec,
): string | null {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null

  const CARD_WIDTH = 1080
  const MIN_HEIGHT = 1080
  const MAX_HEIGHT = 1440
  const PAD_X = 108
  const PAD_TOP = 96
  const PAD_BOTTOM = 92
  /** 引号占位:mark 画在它的基线上。 */
  const MARK_ZONE = 168
  const maxWidth = CARD_WIDTH - PAD_X * 2

  const layout = quoteLayout(
    (fontSize, text) => {
      ctx.font = `${fontSize}px ${QUOTE_FONT_STACK}`
      return ctx.measureText(text).width
    },
    quote,
    maxWidth,
  )
  const textH = layout.lines.length * layout.lineHeight
  const metaZone = author ? 176 : 132
  const height = Math.max(
    MIN_HEIGHT,
    Math.min(MAX_HEIGHT, PAD_TOP + MARK_ZONE + textH + metaZone + PAD_BOTTOM),
  )

  canvas.width = CARD_WIDTH
  canvas.height = height
  ctx.fillStyle = paper
  ctx.fillRect(0, 0, CARD_WIDTH, height)

  // 双线框:分享卡在别人的图堆里要有一眼可辨的「书」气质。
  ctx.strokeStyle = ink
  ctx.globalAlpha = 0.12
  ctx.lineWidth = 2
  ctx.strokeRect(40, 40, CARD_WIDTH - 80, height - 80)
  ctx.globalAlpha = 1

  // 引号:强调色,压在正文上方。
  ctx.fillStyle = accent
  ctx.font = `bold 104px ${QUOTE_FONT_STACK}`
  ctx.fillText('「', PAD_X, PAD_TOP + 104)

  // 引文块:在引号区与署名区之间做光学分配 —— 富余空间 38% 在上、62% 在下,
  // 视觉重心偏下;短句不悬空,长句贴边但不顶死。
  const free = height - PAD_TOP - MARK_ZONE - textH - metaZone - PAD_BOTTOM
  let top = PAD_TOP + MARK_ZONE + Math.max(0, free) * 0.38 + layout.fontSize * 0.92
  ctx.fillStyle = ink
  ctx.font = `${layout.fontSize}px ${QUOTE_FONT_STACK}`
  ctx.textBaseline = 'alphabetic'
  for (const line of layout.lines) {
    ctx.fillText(line, PAD_X, top)
    top += layout.lineHeight
  }

  // 署名:墨水色短横 → 书名 →(可选)作者,层层退淡 —— 出处是分享卡的信任来源。
  const metaTop = height - PAD_BOTTOM - metaZone
  ctx.fillStyle = accent
  ctx.fillRect(PAD_X, metaTop, 72, 4)
  ctx.globalAlpha = 0.78
  ctx.fillStyle = ink
  ctx.font = `30px ${QUOTE_FONT_STACK}`
  ctx.fillText(`—— ${bookTitle}`, PAD_X, metaTop + 56)
  if (author) {
    ctx.globalAlpha = 0.5
    ctx.font = `27px ${QUOTE_FONT_STACK}`
    ctx.fillText(`${author} 著`, PAD_X, metaTop + 102)
  }
  ctx.globalAlpha = 1

  return canvas.toDataURL('image/png')
}

/** data URL → 纯 base64(命令载荷要的就是摘头那段)。 */
export function base64OfDataUrl(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}
