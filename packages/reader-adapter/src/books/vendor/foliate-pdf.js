/*
 * Vendored from foliate-js (https://github.com/johnfactotum/foliate-js/blob/main/pdf.js, MIT).
 * Adapted for Vite bundling:
 * - PDF.js comes from the `pdfjs-dist` npm package and is configured by
 *   `../pdf-book.ts` (which sets `globalThis.pdfjsLib` and the worker URL);
 * - the PDF.js viewer stylesheets are inlined at build time (`?inline`)
 *   instead of being fetched at runtime;
 * - cMaps and standard fonts are served from the app's static `/pdfjs/`
 *   directory (see `scripts/make-fixtures.sh`).
 */
import textLayerBuilderCSS from './pdfjs/text_layer_builder.css?inline'
import annotationLayerBuilderCSS from './pdfjs/annotation_layer_builder.css?inline'
const pdfjsLib = globalThis.pdfjsLib

// ---- PDF 夜间模式:feColorMatrix 重着色 + 内嵌图片保色 -----------------------
// 移植自 readest 的 foliate-js fork(commit 2d0ad8c "feat(pdf): recolor pages
// smoothly and keep embedded photos",MIT)。pdf.js 自带的 `pageColors` 过滤会
// 先把页面解码到线性光、再量化成主题色之间的六个平调,照片和渐变被压成脏块,
// 内嵌图片也跟着文字一起被改色(readest #6548)。这里改成:渲染时不传
// pageColors,对成品画布做一次重着色 —— 每个像素的亮度线性映射到前景色→
// 背景色梯度并保留色度,文字和纸面取主题色、渐变保持平滑、彩色链接保住色相。
// 矩阵是线性的,比 pdf.js 的三段过滤还便宜。
// 套用方式从 SVG filter 改成了逐像素(getImageData/putImageData,数学等价):
// WKWebView(Tauri macOS 桌面端的引擎)的 ctx.filter 属性存在却静默失效,
// 走 filter 的版本在桌面端整页不染色(2026-10-21,Playwright WebKit 实测)。
// `keepImages` 时,内嵌位图按原色贴回:设备空间矩形来自渲染的 operator list,
// 像 pdf.js 的 CanvasGraphics 那样重放 save/restore、transform、表单、组和
// 标注。图片掩码同文字一起主题化;覆盖半页以上的图按扫描页处理(否则扫描书
// 在暗色下还是白的)。

// Rec. 709 luma weights
const LUMA = [0.2126, 0.7152, 0.0722]

const parseHexColor = color => {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color ?? '')?.[1]
  if (!hex) return null
  const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255)
}

// 亮度线性映射到 foreground -> background 梯度、保留色度(相对灰的偏移):
// 两步都在 RGB 里线性,所以合成一个 feColorMatrix。黑白主题原样返回 null。
// 注意这里只做线性映射 —— 对比度膝点放在 recolorPixels 里:线性矩阵左乘膝点
// 矩阵保不住端点(白纸会被推离主题背景色),膝点的截断语义必须在像素级做。
export const getPageColorMatrix = colors => {
  const { foreground, background } = colors ?? {}
  const fg = parseHexColor(foreground)
  const bg = parseHexColor(background)
  if (!fg || !bg) return null
  if (fg.every(v => v === 0) && bg.every(v => v === 1)) return null
  return [0, 1, 2].flatMap(i => [
    ...LUMA.map((w, j) => (i === j ? 1 : 0) + (bg[i] - fg[i] - 1) * w), 0, fg[i],
  ]).concat([0, 0, 0, 1, 0])
}

const multiply = ([a, b, c, d, e, f], [a2, b2, c2, d2, e2, f2]) => [
  a * a2 + c * b2, b * a2 + d * b2,
  a * c2 + c * d2, b * c2 + d * d2,
  a * e2 + c * f2 + e, b * e2 + d * f2 + f,
]

// 页面绘制的位图的设备空间矩形:重放 operator list 里的变换,应用方式同
// pdf.js 的 CanvasGraphics。图片掩码不计入 —— 它用当前颜色填充,和文字一样
// 参与主题化。
const getImageRects = ({ fnArray, argsArray }, baseTransform) => {
  const { OPS } = pdfjsLib
  const rects = []
  const stack = []
  let ctm = baseTransform
  for (let i = 0; i < fnArray.length; i++) {
    const args = argsArray[i]
    switch (fnArray[i]) {
      case OPS.save:
      case OPS.beginGroup:
        stack.push(ctm)
        break
      case OPS.restore:
      case OPS.endGroup:
      case OPS.paintFormXObjectEnd:
      case OPS.endAnnotation:
        ctm = stack.pop() ?? ctm
        break
      case OPS.transform:
        ctm = multiply(ctm, args)
        break
      case OPS.paintFormXObjectBegin:
        stack.push(ctm)
        if (args[0]) ctm = multiply(ctm, args[0])
        break
      case OPS.beginAnnotation:
        stack.push(ctm)
        ctm = multiply(multiply(baseTransform, args[2]), args[3])
        break
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject: {
        // 位图绘制进单位 square
        const [a, b, c, d, e, f] = ctm
        const xs = [e, a + e, c + e, a + c + e]
        const ys = [f, b + f, d + f, b + d + f]
        rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
      }
    }
  }
  return rects
}

// 覆盖这么多比例的图按扫描页处理:跟着页面一起主题化,否则扫描书在暗色
// 主题下还是白的。
const MAX_KEPT_IMAGE_COVERAGE = 0.5

// 逐像素套用「亮度 → fg→bg 梯度」映射,数学与 getPageColorMatrix 的 20 值
// feColorMatrix(type=matrix, sRGB)等价(out_i = fg_i + Δ_i·t + (in_i − t),
// 两端 clamp),但走 getImageData/putImageData 而不是 ctx.filter:后者在
// WebKit(WKWebView,即 Tauri macOS 桌面端的渲染引擎)里属性存在却静默失效,
// PDF 夜间模式会整页不染色(2026-10-21 实测:Chromium 生效、Playwright WebKit
// 无效)。alpha 原样保留。
// `contrast`(默认 1 = 不加)是以中灰为膝点的对比度,作用在亮度域并带截断:
// PDF 文字是位图抗锯齿渲染,小字号笔画的边缘像素占截面大半,线性映射下这些
// 中灰落在 fg→bg 中段,字看着发虚;膝点把中灰推回两端,边缘归边、笔画变实。
// 端点(纸→bg、字→fg)因为截断而天然保住 —— 线性矩阵左乘膝点做不到这件事
// (合成矩阵的中间值不截断,白纸会被推离主题背景色)。
export const recolorPixels = (data, { foreground, background }, contrast = 1) => {
  const fg = parseHexColor(foreground)
  const bg = parseHexColor(background)
  if (!fg || !bg) return
  const delta = [0, 1, 2].map(i => bg[i] - fg[i])
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255
    const g = data[i + 1] / 255
    const b = data[i + 2] / 255
    const t = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
    const tt = contrast === 1 ? t : Math.min(1, Math.max(0, contrast * (t - 0.5) + 0.5))
    let v = fg[0] + delta[0] * tt + (r - t)
    data[i] = (v > 0 ? (v < 1 ? v : 1) : 0) * 255
    v = fg[1] + delta[1] * tt + (g - t)
    data[i + 1] = (v > 0 ? (v < 1 ? v : 1) : 0) * 255
    v = fg[2] + delta[2] * tt + (b - t)
    data[i + 2] = (v > 0 ? (v < 1 ? v : 1) : 0) * 255
  }
}

const applyPageColors = (canvas, colors, imageRects) => {
  const { width, height } = canvas
  if (width <= 0 || height <= 0) return
  const ctx = canvas.getContext('2d')
  const image = ctx.getImageData(0, 0, width, height)
  // 向内取整:只被图片部分覆盖的边缘像素与纸面混色,保留它会让图片描一圈
  // 纸色的边。快照在重着色前取(从 image.data 行式复制,subarray 是视图会
  // 被后面的逐像素改写污染)。
  const kept = imageRects.map(([x0, y0, x1, y1]) => {
    const x = Math.max(0, Math.ceil(x0))
    const y = Math.max(0, Math.ceil(y0))
    return [x, y, Math.min(width, Math.floor(x1)) - x, Math.min(height, Math.floor(y1)) - y]
  }).filter(([, , w, h]) => w > 0 && h > 0 && w * h < width * height * MAX_KEPT_IMAGE_COVERAGE)
    .map(([x, y, w, h]) => {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let row = 0; row < h; row++) {
        const src = ((y + row) * width + x) * 4
        data.set(image.data.subarray(src, src + w * 4), row * w * 4)
      }
      return { x, y, w, h, data }
    })
  recolorPixels(image.data, colors, colors.contrast)
  ctx.putImageData(image, 0, 0)
  for (const { x, y, w, h, data } of kept) {
    const copy = ctx.createImageData(w, h)
    copy.data.set(data)
    ctx.putImageData(copy, x, y)
  }
}

// `renderTask` 正在渲染的 operator list。PDFPageProxy 没有公开句柄,但能从
// 页的 intent states 里够到。
const getRenderOperatorList = (page, renderTask) => {
  for (const { renderTasks, operatorList } of page._intentStates?.values() ?? [])
    for (const task of renderTasks ?? [])
      if (task.task === renderTask) return operatorList
}

// 当前 PDF 页面重着色色;engine 的 setTheme 下发(见 setPageColors)。
// foliate-js npm 包的 fixed-layout 渲染器没有把主题色传进 onZoom 的通道
// (readest 是给它 fork 的 fixed-layout.js 加的 pageColors 属性),这里按
// 模块级状态持有,onZoom 渲染时读取。
let currentPageColors = null

export const setPageColors = colors => {
  currentPageColors = colors
}

const render = async (page, doc, zoom, pageColors = currentPageColors) => {
  if (!doc) return

  const scale = zoom * devicePixelRatio
  doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
  doc.documentElement.style.transformOrigin = 'top left'
  doc.documentElement.style.setProperty('--scale-factor', scale)
  const viewport = page.getViewport({ scale })

  // the canvas must be in the `PDFDocument`'s `ownerDocument`
  // (`globalThis.document` by default); that's where the fonts are loaded
  const canvas = document.createElement('canvas')
  canvas.height = viewport.height
  canvas.width = viewport.width
  const canvasContext = canvas.getContext('2d')
  // 不带 pageColors 渲染(readest #6548:pdf.js 自带过滤会压平照片),
  // 渲染完成后按需对画布做重着色。矩阵只用来判断「要不要重着色」
  // (黑白主题返回 null);重着色本体走 recolorPixels(见 applyPageColors)。
  const renderTask = page.render({ canvasContext, viewport })
  const needsRecolor = pageColors && getPageColorMatrix(pageColors) ? pageColors : null
  const operatorList = needsRecolor && pageColors.keepImages
    ? getRenderOperatorList(page, renderTask) : null

  try {
    await renderTask.promise
  } catch {
    // 渲染被取消或失败:释放位图,保留 DOM 上的旧画布等下一次渲染。
    canvas.width = 0
    canvas.height = 0
    return
  }

  // 必须在 adoptNode 之前重着色:putImageData 写的就是这块画布,adopt 之后
  // 拿到的就是另一个文档的画布了。
  if (needsRecolor) applyPageColors(canvas, needsRecolor,
    operatorList ? getImageRects(operatorList, viewport.transform) : [])
  doc.querySelector('#canvas').replaceChildren(doc.adoptNode(canvas))

  const container = doc.querySelector('.textLayer')
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: await page.streamTextContent(),
    container,
    viewport,
  })
  await textLayer.render()

  // hide "offscreen" canvases appended to docuemnt when rendering text layer
  // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
  for (const canvas of document.querySelectorAll('.hiddenCanvasElement'))
    Object.assign(canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      display: 'none',
    })

  // fix text selection
  // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.js#L105-L107
  const endOfContent = document.createElement('div')
  endOfContent.className = 'endOfContent'
  container.append(endOfContent)
  // TODO: this only works in Firefox; see https://github.com/mozilla/pdf.js/pull/17923
  container.onpointerdown = () => container.classList.add('selecting')
  container.onpointerup = () => container.classList.remove('selecting')

  const div = doc.querySelector('.annotationLayer')
  const linkService = {
    goToDestination: () => {},
    getDestinationHash: (dest) => JSON.stringify(dest),
    addLinkAttributes: (link, url) => (link.href = url),
  }
  await new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService }).render({
    annotations: await page.getAnnotations(),
  })
}

const renderPage = async (page, getImageBlob) => {
  const viewport = page.getViewport({ scale: 1 })
  // 页面的自然尺寸(CSS px):滚动条要用它预排每页的占位高度(见
  // pdf-scroll.ts 的 PdfScrollStrip),不依赖 iframe 挂载后才能量。
  const size = { width: viewport.width, height: viewport.height }
  if (getImageBlob) {
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    await page.render({ canvasContext, viewport }).promise
    return new Promise((resolve) => canvas.toBlob(resolve))
  }
  const src = URL.createObjectURL(
    new Blob(
      [
        `
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        /*
        https://github.com/mozilla/pdf.js/commit/bd05b255fabfc313b194bfe9a17ccded4d90fb5a
        */
        :root {
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --scale-round-x: 1px;
          --scale-round-y: 1px;
        }
        ${textLayerBuilderCSS}
        ${annotationLayerBuilderCSS}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `,
      ],
      { type: 'text/html' },
    ),
  )
  // pageColors 走 render 的默认参数(模块级 currentPageColors):npm 包的
  // fixed-layout 渲染器调 onZoom 时只给 { doc, scale }。
  const onZoom = ({ doc, scale }) => render(page, doc, scale)
  return { src, onZoom, ...size }
}

const makeTOCItem = (item) => ({
  label: item.title,
  href: JSON.stringify(item.dest),
  subitems: item.items.length ? item.items.map(makeTOCItem) : null,
})

// ---- 全书搜索:sections.createDocument -------------------------------------
// 内核 view.search 逐节调 createDocument() 拿伪文档跑匹配,再把命中的 DOM
// Range 转成 CFI(view.getCFI = fake 基址 + CFI.fromRange);TTS 洗色时同一条
// 偏移模型还会解析回**真实渲染的页文档**。所以伪文档与真页文档的 DOM 结构
// 必须逐元素一致(span/br 的数量与顺序),否则 CFI 与高亮 Range 全部错位。
//
// 主路径(readest 同款):伪文档直接用真 pdfjsLib.TextLayer 渲染 —— 同一个
// 类、同一份 streamTextContent 输入,结构同构由构造保证,不随 pdf.js 版本
// 漂移(见 makeSearchDocument)。
//
// 兜底(appendPdfTextItems):无 canvas 的环境(jsdom 单测等)手工镜像
// TextLayer(6.4.299,MIT)的结构规则:
//   - 文本项 str !== '' → span[role=presentation],textContent = str
//       (hasText 判据是 str !== '',空串项只可能带 hasEOL);
//   - 项 hasEOL → 追加 br[role=presentation];
//   - streamTextContent 默认不含 marked content(includeMarkedContent=false),
//     所以 textLayer 是扁平的,无嵌套 span;
//   - 真渲染在 textDivs 超过 MAX_TEXT_DIVS_TO_RENDER(100000)后整页截断,
//     这里镜像同一上限,避免伪文档比真文档多出尾部文本。
export const appendPdfTextItems = (layer, doc, items) => {
  const MAX_TEXT_DIVS = 100000
  let count = 0
  for (const item of items) {
    if (count > MAX_TEXT_DIVS) break
    if (item.str === undefined) continue
    count += 1
    if (item.str !== '') {
      const span = doc.createElement('span')
      span.setAttribute('role', 'presentation')
      span.textContent = item.str
      layer.append(span)
    }
    if (item.hasEOL) {
      const br = doc.createElement('br')
      br.setAttribute('role', 'presentation')
      layer.append(br)
    }
  }
}

const makeSearchDocument = async (pdf, index) => {
  const page = await pdf.getPage(index + 1)
  const doc = document.implementation.createHTMLDocument('')
  // 骨架与真实页文档一致:body > #canvas + .textLayer + .annotationLayer,
  // CFI 的元素路径(/4/2/span[i]…)两边才对得上。
  const canvas = doc.createElement('div')
  canvas.id = 'canvas'
  const textLayer = doc.createElement('div')
  textLayer.className = 'textLayer'
  const annotationLayer = doc.createElement('div')
  annotationLayer.className = 'annotationLayer'
  doc.body.append(canvas, textLayer, annotationLayer)

  // readest 同款做法:伪文档直接用真 TextLayer 渲染 —— 与真实页面是同一个
  // 类、同一份输入,结构同构由构造保证,不随 pdf.js 版本漂移。无 canvas 的
  // 环境(单测/jsdom)退回手工镜像 span(appendPdfTextItems,规则同 TextLayer)。
  const probe = doc.createElement('canvas')
  if (probe.getContext?.('2d')) {
    try {
      const instance = new pdfjsLib.TextLayer({
        textContentSource: await page.streamTextContent(),
        container: textLayer,
        viewport: page.getViewport({ scale: 1 }),
      })
      await instance.render()
      return doc
    } catch {
      textLayer.replaceChildren()
    }
  }
  const { items } = await page.getTextContent()
  appendPdfTextItems(textLayer, doc, items)
  return doc
}

export const makePDF = async (file) => {
  const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
  transport.requestDataRange = (begin, end) => {
    file
      .slice(begin, end)
      .arrayBuffer()
      .then((chunk) => {
        transport.onDataRange(begin, chunk)
      })
  }
  const pdf = await pdfjsLib.getDocument({
    range: transport,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    isEvalSupported: false,
  }).promise

  const book = { rendition: { layout: 'pre-paginated' } }

  const { metadata, info } = (await pdf.getMetadata()) ?? {}
  // TODO: for better results, parse `metadata.getRaw()`
  book.metadata = {
    title: metadata?.get('dc:title') ?? info?.Title,
    author: metadata?.get('dc:creator') ?? info?.Author,
    contributor: metadata?.get('dc:contributor'),
    description: metadata?.get('dc:description') ?? info?.Subject,
    language: metadata?.get('dc:language'),
    publisher: metadata?.get('dc:publisher'),
    subject: metadata?.get('dc:subject'),
    identifier: metadata?.get('dc:identifier'),
    source: metadata?.get('dc:source'),
    rights: metadata?.get('dc:rights'),
  }

  const outline = await pdf.getOutline()
  book.toc = outline?.map(makeTOCItem)

  const cache = new Map()
  book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
    id: i,
    load: async () => {
      const cached = cache.get(i)
      if (cached) return cached
      const url = await renderPage(await pdf.getPage(i + 1))
      cache.set(i, url)
      return url
    },
    // 全书搜索用:返回镜像 textLayer 结构的伪文档(见 makeSearchDocument)。
    createDocument: () => makeSearchDocument(pdf, i),
    size: 1000,
  }))
  book.isExternal = (uri) => /^\w+:/i.test(uri)
  book.resolveHref = async (href) => {
    const parsed = JSON.parse(href)
    const dest = typeof parsed === 'string' ? await pdf.getDestination(parsed) : parsed
    const index = await pdf.getPageIndex(dest[0])
    return { index }
  }
  book.splitTOCHref = async (href) => {
    const parsed = JSON.parse(href)
    const dest = typeof parsed === 'string' ? await pdf.getDestination(parsed) : parsed
    const index = await pdf.getPageIndex(dest[0])
    return [index, null]
  }
  book.getTOCFragment = (doc) => doc.documentElement
  book.getCover = async () => renderPage(await pdf.getPage(1), true)
  book.destroy = () => pdf.destroy()
  return book
}
