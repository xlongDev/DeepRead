// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AnnotationRegistry } from './annotation-registry'

describe('AnnotationRegistry', () => {
  it('登记后按 id 取回锚点', () => {
    const registry = new AnnotationRegistry()
    registry.set('a1', { cfi: 'epubcfi(/6/4)', index: 2 })
    expect(registry.cfiOf('a1')).toBe('epubcfi(/6/4)')
    expect(registry.size).toBe(1)
  })

  it('同 id 再登记是覆盖(重绘划线的路径)', () => {
    const registry = new AnnotationRegistry()
    registry.set('a1', { cfi: 'epubcfi(/6/4)', color: '#f5d76e', index: 2 })
    registry.set('a1', { cfi: 'epubcfi(/6/4)', color: '#86b6f0', index: 2 })
    expect(registry.cfiOf('a1')).toBe('epubcfi(/6/4)')
    expect(registry.size).toBe(1)
    expect(registry.forSection(2)).toEqual([{ cfi: 'epubcfi(/6/4)', color: '#86b6f0', index: 2 }])
  })

  it('只回答属于该 section 的标注 —— 翻到别章不重放别人的画', () => {
    const registry = new AnnotationRegistry()
    registry.set('a1', { cfi: 'epubcfi(/6/4)', index: 0 })
    registry.set('a2', { cfi: 'epubcfi(/8/2)', index: 3 })
    registry.set('a3', { cfi: 'epubcfi(/10/2)', index: 3 })
    expect(registry.forSection(3).map((entry) => entry.cfi)).toEqual([
      'epubcfi(/8/2)',
      'epubcfi(/10/2)',
    ])
    expect(registry.forSection(1)).toEqual([])
  })

  it('没有 section index 的标注不参与重放(内核没给回执时画的)', () => {
    const registry = new AnnotationRegistry()
    registry.set('a1', { cfi: 'epubcfi(/6/4)' })
    expect(registry.forSection(0)).toEqual([])
    expect(registry.cfiOf('a1')).toBe('epubcfi(/6/4)')
  })

  it('删除后不再重放,锚点也取不到', () => {
    const registry = new AnnotationRegistry()
    registry.set('a1', { cfi: 'epubcfi(/6/4)', index: 0 })
    registry.delete('a1')
    expect(registry.cfiOf('a1')).toBeUndefined()
    expect(registry.forSection(0)).toEqual([])
  })

  it('clear 清空全部(关书/重开)', () => {
    const registry = new AnnotationRegistry()
    registry.set('a1', { cfi: 'epubcfi(/6/4)', index: 0 })
    registry.clear()
    expect(registry.size).toBe(0)
    expect(registry.cfiOf('a1')).toBeUndefined()
  })
})
