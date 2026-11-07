import { describe, expect, it } from 'vitest'
import {
  MOTION_PREFERENCE_OPTIONS,
  MOTION_STORAGE_KEY,
  motionAttribute,
  parseMotionPreference,
} from './motion'

describe('motion preference(界面动效)', () => {
  it('只认 reduce,空值与脏值一律回落 system', () => {
    expect(parseMotionPreference(null)).toBe('system')
    expect(parseMotionPreference('system')).toBe('system')
    expect(parseMotionPreference('reduce')).toBe('reduce')
    expect(parseMotionPreference('REDUCE')).toBe('system')
    expect(parseMotionPreference('{}')).toBe('system')
  })

  it('system 不写 DOM 属性,reduce 写 reduce —— 系统偏好交还原生 @media', () => {
    expect(motionAttribute('system')).toBeNull()
    expect(motionAttribute('reduce')).toBe('reduce')
  })

  it('目录:两项、值唯一、默认跟随系统,每项都有说明', () => {
    expect(MOTION_STORAGE_KEY).toBe('deepread.motion')
    expect(MOTION_PREFERENCE_OPTIONS.map((option) => option.value)).toEqual(['system', 'reduce'])
    expect(
      MOTION_PREFERENCE_OPTIONS.every(
        (option) => option.label.length > 0 && option.hint.length > 0,
      ),
    ).toBe(true)
  })
})
