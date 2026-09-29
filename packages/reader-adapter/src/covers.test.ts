import { describe, expect, it } from 'vitest'
import { metadataToFields } from './covers'

/**
 * 这里锁的是**字段形状**,不是取值逻辑。
 *
 * 曾经踩过的坑:`metadata.author` 在 EPUB 里是贡献者对象数组、在 MOBI 里是字符串
 * 数组,而代码按 `typeof raw === 'string'` 读 —— 于是标题能出来、作者永远为空。
 * 下面这些 fixture 是照 foliate-js 源码里的真实结构抄的(epub.js 的
 * makeContributor / getMetadata,mobi.js 的 getMetadata)。
 */
describe('metadataToFields', () => {
  it('读得出 EPUB 的贡献者对象(title 是字符串,publisher 是对象)', () => {
    // 来自 foliate epub.js:dc:creator → { name, sortAs, role, code, scheme }
    const meta = {
      title: '百年孤独',
      author: [
        {
          name: '加西亚·马尔克斯',
          sortAs: 'García Márquez, Gabriel',
          role: ['aut'],
          code: null,
          scheme: null,
        },
      ],
      publisher: { name: '南海出版公司', sortAs: null, role: ['pbl'], code: null, scheme: null },
      language: ['zh'],
    }
    expect(metadataToFields(meta)).toEqual({
      title: '百年孤独',
      author: '加西亚·马尔克斯',
      publisher: '南海出版公司',
      language: 'zh',
    })
  })

  it('读得出 MOBI 的字符串数组(同一份代码要同时伺候两种形状)', () => {
    // 来自 foliate mobi.js:author 是 exth.creator.map(unescapeHTML)
    const meta = {
      title: 'AI 未来已来',
      author: ['李开复'],
      publisher: '中信出版社',
      language: 'zh-CN',
    }
    expect(metadataToFields(meta)).toEqual({
      title: 'AI 未来已来',
      author: '李开复',
      publisher: '中信出版社',
      language: 'zh-CN',
    })
  })

  it('标题带 alternate-script 时是语言映射,取得到值而不是 null', () => {
    // makeLanguageMap:有 alt-script/lang 不同时返回 { [lang]: value }
    expect(metadataToFields({ title: { 'zh-Hant': '紅樓夢' }, language: ['zh-Hant'] }).title).toBe(
      '紅樓夢',
    )
  })

  it('缺字段、空数组、垃圾值都退回 null,不抛错', () => {
    expect(metadataToFields(undefined)).toEqual({
      title: null,
      author: null,
      publisher: null,
      language: null,
    })
    expect(metadataToFields({ author: [], publisher: null, language: 0 })).toEqual({
      title: null,
      author: null,
      publisher: null,
      language: null,
    })
  })

  it('文件名样子的元数据标题被拒(下载站的命名不该上书架)', () => {
    expect(metadataToFields({ title: '认知觉醒.mobi' }).title).toBeNull()
  })
})
