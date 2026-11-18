/**
 * 金句分享卡:选区/划线 → 一张可保存的 PNG。
 *
 * 刻意不用 quote-image 之类的现成库:卡面要跟阅读主题同一套纸色与墨色,库的
 * 版式反而帮倒忙,而排版 + 文本折行 + 一条分割线是自己写得完的量。折行逻辑
 * 独立成纯函数(量宽以回调注入)才可单测 —— jsdom 没有 canvas。
 *
 * 卡面只有一种版式:大引号、金句、墨水色分割线、书名署名。不提供样式选择
 * —— 分享卡是「顺手一次」的动作,选项越多越不做。
 */

/** 行头禁则:这些收尾标点不打头,宁可轻微超宽也要追到上一行行尾。 */
const NO_LINE_START = /^[，。、；：？！”’』」）》〕…—·%,;:?!)]$/u

/** 断行:西文单词与连续空白作整块,其余(CJK 与标点)逐字 —— 换行只落在
 *  单元边界,任何字符都不会被丢掉。量宽以回调注入(单测不用真 canvas)。 */
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

/** 卡片装不下整段划线:超长截断(工具条的笔记上限是 500,卡片再放宽就散了)。 */
const QUOTE_MAX_CHARS = 400

export interface QuoteCardSpec {
  readonly quote: string
  readonly bookTitle: string
  /** 墨水色(划线色),用作分割线与引号的强调色。 */
  readonly accent: string
  /** 纸色与字色:跟当前阅读主题同源,深色主题分享出深色卡。 */
  readonly paper: string
  readonly ink: string
}

const CARD_WIDTH = 1080
const CARD_HEIGHT = 1440
const CARD_PADDING = 96
const QUOTE_FONT = `44px 'LXGW WenKai', 'Songti SC', 'Noto Serif CJK SC', serif`
const META_FONT = `30px 'LXGW WenKai', 'Songti SC', 'Noto Serif CJK SC', serif`
/** 版心能排下的行数上限:超出加省略号,不悄悄丢行。 */
const QUOTE_MAX_LINES = 11

/** 画一张分享卡并返回 PNG data URL。canvas 上下文拿不到(null)返回 null。 */
export function drawQuoteCard(
  canvas: HTMLCanvasElement,
  { quote, bookTitle, accent, paper, ink }: QuoteCardSpec,
): string | null {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  // 按码点截断(slice 会把 emoji 切成半个代理对,画出来是 replacement char)。
  const chars = [...quote.trim()]
  const trimmed = chars.slice(0, QUOTE_MAX_CHARS).join('')

  canvas.width = CARD_WIDTH
  canvas.height = CARD_HEIGHT
  ctx.fillStyle = paper
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)

  // 双线框:分享卡在别人的图堆里要有一眼可辨的「书」气质。
  ctx.strokeStyle = ink
  ctx.globalAlpha = 0.12
  ctx.lineWidth = 2
  ctx.strokeRect(40, 40, CARD_WIDTH - 80, CARD_HEIGHT - 80)
  ctx.globalAlpha = 1

  const maxWidth = CARD_WIDTH - CARD_PADDING * 2
  ctx.fillStyle = ink

  // 引号:强调色,压在正文上方。
  ctx.fillStyle = accent
  ctx.font = `bold 96px 'LXGW WenKai', 'Songti SC', serif`
  ctx.fillText('「', CARD_PADDING, CARD_PADDING + 84)

  // 金句:2 倍行距居中排;行数超版心就在末行打省略号,不悄悄丢行。
  ctx.fillStyle = ink
  ctx.font = QUOTE_FONT
  ctx.textBaseline = 'alphabetic'
  const lineHeight = 76
  let top = CARD_PADDING + 220
  let lines = wrapLines((text) => ctx.measureText(text).width, trimmed, maxWidth)
  if (lines.length > QUOTE_MAX_LINES) {
    lines = lines.slice(0, QUOTE_MAX_LINES)
    lines[QUOTE_MAX_LINES - 1] += '…'
  }
  for (const line of lines) {
    ctx.fillText(line, CARD_PADDING, top)
    top += lineHeight
  }

  // 分割线 + 署名:墨水色短横,书名跟在后面 —— 出处是分享卡的信任来源。
  ctx.fillStyle = accent
  ctx.fillRect(CARD_PADDING, CARD_HEIGHT - CARD_PADDING - 84, 72, 4)
  ctx.fillStyle = ink
  ctx.globalAlpha = 0.72
  ctx.font = META_FONT
  ctx.fillText(bookTitle, CARD_PADDING, CARD_HEIGHT - CARD_PADDING - 16)
  ctx.globalAlpha = 1

  return canvas.toDataURL('image/png')
}

/** data URL → 纯 base64(命令载荷要的就是摘头那段)。 */
export function base64OfDataUrl(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}
