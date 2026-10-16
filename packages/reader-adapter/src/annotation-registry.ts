/**
 * 划词标注的注册表:让划线活得比 section 的 overlayer 久。
 *
 * 内核(foliate-js)把标注画在 section 的 overlayer 上,而 overlayer 跟着
 * iframe 文档一起生灭 —— 翻页走远再回来,那一章的文档是**重新加载**的
 * (`renderer` 再次派发 `create-overlayer`),新 overlayer 是张白纸:内核
 * 自己的 `#createOverlayer` 只回放搜索结果,不回放标注。不在这登记,
 * 「翻页回来划线还在」就只剩运气。
 *
 * 所以每次 `addAnnotation` 都把内核回执的 section index 存下来,
 * `create-overlayer` 响时按 index 把这一章的标的重放一遍(同 foliate 官方
 * reader 的 Map<spine_index, annotations> 打法,只是挂在 renderer 上——
 * 事件不冒泡,挂在 view 元素上永远等不到)。
 *
 * 纯数据、无 DOM:重放的时机由 engine 接线,这里只回答「哪些标注属于这章」。
 */

/** 一条已交给内核的标注。 */
export interface AnnotationEntry {
  /** CFI 锚点:内核靠它把标注定位回正文。 */
  readonly cfi: string
  /** 墨水颜色,重放时原样带回。 */
  readonly color?: string
  /** 墨水样式(highlight / underline / squiggly),重放时原样带回。 */
  readonly style?: string
  /** 该标注落在哪个 section;内核 `addAnnotation` 的回执。没有它就无法
   *  在 section 重建时判断「这画是不是我的」。 */
  readonly index?: number
}

export class AnnotationRegistry {
  readonly #entries = new Map<string, AnnotationEntry>()

  /** 登记(或更新)一条标注。同 id 再登记是覆盖 —— 重绘划线的路径。 */
  set(id: string, entry: AnnotationEntry): void {
    this.#entries.set(id, entry)
  }

  /** 摘掉一条标注。删除划线后它不该再被重放。 */
  delete(id: string): void {
    this.#entries.delete(id)
  }

  /** 取一条标注的锚点;没有返回 undefined(删过的、从没建过的)。 */
  cfiOf(id: string): string | undefined {
    return this.#entries.get(id)?.cfi
  }

  /** 属于 `index` 这一章的全部标注,按登记顺序。 */
  forSection(index: number): readonly AnnotationEntry[] {
    const found: AnnotationEntry[] = []
    for (const entry of this.#entries.values()) {
      if (entry.index === index) found.push(entry)
    }
    return found
  }

  /** 清空(关书 / 重开)。overlayer 随 view 销毁,登记不摘就会在下次开书时
   *  试图重放上一本书的标注。 */
  clear(): void {
    this.#entries.clear()
  }

  get size(): number {
    return this.#entries.size
  }
}
