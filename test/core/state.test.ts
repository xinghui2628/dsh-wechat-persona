import { afterEach, describe, expect, it, vi } from 'vitest'
import { StateManager, createInitialState } from '../../src/core/state.ts'
import { dayKey } from '../../src/util/time.ts'
import { MemoryStore, atLocal } from './fakes.ts'

const NOW = atLocal(2026, 9, 30, 20, 0)
const TODAY = dayKey(NOW)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createInitialState', () => {
  it('返回完整可用的初始状态', () => {
    const state = createInitialState(NOW)
    expect(state.version).toBe(1)
    expect(state.paused).toBe(false)
    expect(state.breaker).toEqual({ tripped: false })
    expect(state.budget).toEqual({ dayKey: TODAY, spentTokens: 0 })
    expect(state.rate).toEqual({})
    expect(state.seen).toEqual({})
    expect(state.stats.startedAt).toBe(NOW)
    expect(state.stats.searchDayKey).toBe(TODAY)
    expect(state.stats.summaryDayKey).toBe(TODAY)
    expect(state.stats.llmCalls).toBe(0)
  })
})

describe('StateManager.load', () => {
  it('文件不存在返回初始状态', async () => {
    const manager = new StateManager(new MemoryStore())
    const state = await manager.load(NOW)
    expect(state).toEqual(createInitialState(NOW))
  })

  it('缺字段用默认值补齐，合法字段保留', async () => {
    const store = new MemoryStore()
    await store.writeJson('state.json', {
      version: 1,
      paused: true,
      breaker: { tripped: true, reason: 'captcha:验证码', at: 42 },
      budget: { dayKey: '2020-01-01', spentTokens: 7 },
      rate: {
        c1: { hourKey: 'h', hourCount: 2, dayKey: 'd', dayCount: 3, lastReplyAt: 111 },
        bad: 'not-a-counter',
      },
      seen: { 'a:b': NOW, bad: 'oops' },
      stats: { llmCalls: 3, sends: 2 },
      lastActivityAt: NOW - 1,
    })
    const manager = new StateManager(store)
    const state = await manager.load(NOW)
    expect(state.paused).toBe(true)
    expect(state.pauseReason).toBeUndefined()
    expect(state.breaker).toEqual({ tripped: true, reason: 'captcha:验证码', at: 42 })
    expect(state.budget).toEqual({ dayKey: '2020-01-01', spentTokens: 7 })
    expect(state.rate.c1).toEqual({ hourKey: 'h', hourCount: 2, dayKey: 'd', dayCount: 3, lastReplyAt: 111 })
    expect(state.rate.bad).toBeUndefined()
    expect(state.seen).toEqual({ 'a:b': NOW })
    expect(state.stats.llmCalls).toBe(3)
    expect(state.stats.sends).toBe(2)
    expect(state.stats.llmTokens).toBe(0)
    expect(state.stats.errors).toBe(0)
    expect(state.stats.startedAt).toBe(NOW)
    expect(state.lastActivityAt).toBe(NOW - 1)
  })

  it('损坏 JSON 回退默认并 warn', async () => {
    const store = new MemoryStore()
    await store.write('state.json', '{broken json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new StateManager(store)
    const state = await manager.load(NOW)
    expect(state.paused).toBe(false)
    expect(state.stats.startedAt).toBe(NOW)
    expect(warn).toHaveBeenCalled()
  })

  it('JSON 不是对象时也回退默认', async () => {
    const store = new MemoryStore()
    await store.write('state.json', '[1,2,3]')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state = await new StateManager(store).load(NOW)
    expect(state).toEqual(createInitialState(NOW))
  })
})

describe('StateManager.save', () => {
  it('保存后可读回（缺字段正常补齐）', async () => {
    const store = new MemoryStore()
    const manager = new StateManager(store)
    const state = createInitialState(NOW)
    state.paused = true
    state.pauseReason = 'chat-stop-command'
    state.stats.sends = 4
    await manager.save(state)
    const loaded = await manager.load(NOW)
    expect(loaded.paused).toBe(true)
    expect(loaded.pauseReason).toBe('chat-stop-command')
    expect(loaded.stats.sends).toBe(4)
    expect(store.has('state.json')).toBe(true)
  })

  it('同一实例内串行写：后一次快照覆盖前一次', async () => {
    const store = new MemoryStore()
    const manager = new StateManager(store)
    const first = createInitialState(NOW)
    first.paused = true
    const second = createInitialState(NOW)
    second.paused = false
    second.stats.sends = 9
    await Promise.all([manager.save(first), manager.save(second)])
    const loaded = await manager.load(NOW)
    expect(loaded.paused).toBe(false)
    expect(loaded.stats.sends).toBe(9)
  })
})
