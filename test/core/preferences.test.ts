/**
 * 联系人偏好提取/合并/渲染测试（0 token 规则）。
 */
import { describe, expect, it } from 'vitest'
import {
  extractPreferences,
  formatProfile,
  isEmptyProfile,
  mergePreferences,
} from '../../src/core/preferences.ts'
import type { MemoryProfile } from '../../src/types.ts'

const T0 = new Date(2026, 9, 30, 12, 0, 0).getTime()

describe('extractPreferences 保守提取', () => {
  it('提取称呼', () => {
    expect(extractPreferences('以后叫我老王吧')?.nickname).toBe('老王')
    expect(extractPreferences('喊我阿杰就行')?.nickname).toBe('阿杰')
  })

  it('提取忌口/雷区', () => {
    const patch = extractPreferences('我不吃香菜，也受不了烟味')
    expect(patch.taboos).toContain('香菜')
    expect(patch.taboos).toContain('烟味')
  })

  it('提取最近话题', () => {
    const patch = extractPreferences('我最近在准备考研，好累')
    expect(patch.topics?.includes('准备考研')).toBe(true)
  })

  it('无意义消息不产生偏好', () => {
    for (const text of ['哈哈哈哈', '在吗', '哦', '好的', '']) {
      expect(Object.keys(extractPreferences(text))).toHaveLength(0)
    }
  })

  it('最多保留 3 个忌口、5 个话题', () => {
    const taboos = extractPreferences('不吃辣不吃甜不吃酸不吃苦')
    expect((taboos.taboos ?? []).length).toBeLessThanOrEqual(3)
    const topics = extractPreferences('我最近在跑步我最近在看书我最近在学吉他我最近在做饭我最近在钓鱼我最近在拼图')
    expect((topics.topics ?? []).length).toBeLessThanOrEqual(5)
  })
})

describe('mergePreferences 合并', () => {
  it('昵称覆盖、忌口/话题去重并保留最近', () => {
    const current: MemoryProfile = {
      nickname: '小明',
      taboos: ['香菜', '辣'],
      topics: ['考研'],
      updatedAt: T0,
    }
    const merged = mergePreferences(
      current,
      { nickname: '老王', taboos: ['辣', '烟味'], topics: ['实习'] },
      T0 + 1000,
    )
    expect(merged.nickname).toBe('老王')
    expect(merged.taboos).toEqual(['香菜', '辣', '烟味'])
    expect(merged.topics).toEqual(['考研', '实习'])
    expect(merged.updatedAt).toBe(T0 + 1000)
  })

  it('空 patch 不改已有值', () => {
    const current: MemoryProfile = { nickname: '阿杰', taboos: ['酒'], topics: [], updatedAt: T0 }
    const merged = mergePreferences(current, {}, T0 + 1)
    expect(merged.nickname).toBe('阿杰')
    expect(merged.taboos).toEqual(['酒'])
  })

  it('无已有记录时从空开始', () => {
    const merged = mergePreferences(undefined, { topics: ['看剧'] }, T0)
    expect(merged).toEqual({ nickname: '', taboos: [], topics: ['看剧'], updatedAt: T0 })
  })
})

describe('formatProfile / isEmptyProfile', () => {
  it('空偏好返回空串', () => {
    expect(formatProfile(undefined)).toBe('')
    expect(formatProfile({ nickname: '', taboos: [], topics: [], updatedAt: T0 })).toBe('')
    expect(isEmptyProfile(undefined)).toBe(true)
  })

  it('渲染称呼/忌口/话题', () => {
    const text = formatProfile({
      nickname: '老王',
      taboos: ['香菜'],
      topics: ['考研'],
      updatedAt: T0,
    })
    expect(text).toContain('老王')
    expect(text).toContain('香菜')
    expect(text).toContain('考研')
    expect(isEmptyProfile({ nickname: '老王', taboos: [], topics: [], updatedAt: T0 })).toBe(false)
  })
})
