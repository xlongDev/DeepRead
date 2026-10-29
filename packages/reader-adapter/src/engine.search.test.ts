// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { collectSearchYield, ensureSearchableSections } from './engine'

describe('内核 search 产出的两种形态都要折进结果', () => {
  // 回归:全书搜索(#searchBook)把每章命中打包成 {index, subitems},旧实现
  // 只认扁平 {cfi, excerpt} —— 全书搜索在任何格式上都返回空,PDF 只是第一个
  // 被用户撞见的格式。
  it('subitems 打包形态逐条拍平,保序', () => {
    const results: { location: { cfi: string; progress: number }; excerpt: string }[] = []
    const done = collectSearchYield(
      {
        index: 3,
        subitems: [
          { cfi: 'epubcfi(/6/2)', excerpt: '命中一' },
          { cfi: 'epubcfi(/6/4)', excerpt: '命中二' },
        ],
      },
      results,
      200,
    )
    expect(done).toBe(false)
    expect(results.map((r) => r.excerpt)).toEqual(['命中一', '命中二'])
    expect(results[0]!.location.cfi).toBe('epubcfi(/6/2)')
  })

  it('扁平形态(单章搜索)照常收集', () => {
    const results: { location: { cfi: string; progress: number }; excerpt: string }[] = []
    collectSearchYield({ cfi: 'epubcfi(/6/8)', excerpt: '命中' }, results, 200)
    expect(results).toHaveLength(1)
  })

  it('残缺条目跳过,不炸整轮', () => {
    const results: { location: { cfi: string; progress: number }; excerpt: string }[] = []
    collectSearchYield(
      {
        subitems: [
          { cfi: '', excerpt: '无锚点' },
          { cfi: 'epubcfi(x)', excerpt: '好条目' },
        ],
      },
      results,
      200,
    )
    expect(results.map((r) => r.excerpt)).toEqual(['好条目'])
  })

  it('excerpt 是内核的 {pre, match, post} 三段体时拼成纯文本', () => {
    // 回归:excerpt 对象直接进 React 会整树崩掉(Objects are not valid as a
    // React child)—— 这个崩溃一直被 subitems bug 挡着(从没拿到过结果)。
    const results: { location: { cfi: string; progress: number }; excerpt: string }[] = []
    collectSearchYield(
      {
        subitems: [
          { cfi: 'epubcfi(/6/2)', excerpt: { pre: '简体中文', match: '版由', post: '人民邮电' } },
        ],
      },
      results,
      200,
    )
    expect(results[0]!.excerpt).toBe('简体中文版由人民邮电')
  })

  it('达到上限即报告应停(部分结果也有效)', () => {
    const results: { location: { cfi: string; progress: number }; excerpt: string }[] = []
    const done = collectSearchYield(
      { subitems: Array.from({ length: 5 }, (_, i) => ({ cfi: `c${i}`, excerpt: `e${i}` })) },
      results,
      3,
    )
    expect(done).toBe(true)
    expect(results).toHaveLength(3)
  })
})

describe('无 body 的节要兜住,否则内核 searchMatcher 读 doc.body.lang 炸整轮', () => {
  type TestSection = {
    size: number
    load: () => Promise<string>
    createDocument?: () => Promise<Document>
  }
  const asSections = (list: TestSection[]) =>
    list as unknown as Parameters<typeof ensureSearchableSections>[0]

  it('没有 body 的文档被换成空 HTML 文档,有 body 的原样返回', async () => {
    const bodyless = document.implementation.createHTMLDocument('')
    bodyless.documentElement.remove()
    const normal = document.implementation.createHTMLDocument('')
    normal.body.append(normal.createTextNode('正文'))
    const sections: TestSection[] = [
      { size: 1, load: async () => '', createDocument: async () => bodyless },
      { size: 1, load: async () => '', createDocument: async () => normal },
      { size: 1, load: async () => '' },
    ]
    ensureSearchableSections(asSections(sections))
    const first = await sections[0]!.createDocument!()
    expect(first.body).not.toBeNull()
    const second = await sections[1]!.createDocument!()
    expect(second.body.textContent).toBe('正文')
    expect(sections[2]!.createDocument).toBeUndefined()
  })

  it('同一节重复 open 不二次包壳(幂等)', async () => {
    const bodyless = document.implementation.createHTMLDocument('')
    const section: TestSection = {
      size: 1,
      load: async () => '',
      createDocument: async () => bodyless,
    }
    ensureSearchableSections(asSections([section]))
    const wrapped = section.createDocument
    ensureSearchableSections(asSections([section]))
    expect(section.createDocument).toBe(wrapped)
  })
})
