import { describe, expect, it } from 'vitest'
import { planExportChapters } from './tts-export'

describe('planExportChapters', () => {
  it('与听书同一套句级单元:缓存共享,断点续跑免费', () => {
    const plan = planExportChapters([
      { index: 0, title: '一', text: '镇上的人把灯点亮。雪落下来。' },
      { index: 1, title: '二', text: '' },
    ])
    expect(plan).toHaveLength(2)
    // 两个句子各成一块 —— 与播放管线合成的单元一一对应。
    expect(plan[0].blocks).toEqual(['镇上的人把灯点亮。', '雪落下来。'])
    // 空章如实交空块清单:Rust 侧提交占位 mp3,manifest 计 0 块。
    expect(plan[1].blocks).toEqual([])
  })
})
