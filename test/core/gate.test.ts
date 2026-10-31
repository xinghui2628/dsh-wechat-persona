import { describe, expect, it } from 'vitest'
import { createInitialState } from '../../src/core/state.ts'
import { evaluateInbound } from '../../src/core/gate.ts'
import { dayKey, hourKey } from '../../src/util/time.ts'
import type { RateCounter } from '../../src/types.ts'
import { FRIDAY_EVENING, MONDAY_NOON, atLocal, inbound, testConfig } from './fakes.ts'

function setup(now = FRIDAY_EVENING): { config: ReturnType<typeof testConfig>; state: ReturnType<typeof createInitialState>; now: number } {
  return { config: testConfig(), state: createInitialState(now), now }
}

function rateCounter(now: number, overrides: Partial<RateCounter> = {}): RateCounter {
  return { hourKey: hourKey(now), hourCount: 0, dayKey: dayKey(now), dayCount: 0, lastReplyAt: 0, ...overrides }
}

describe('evaluateInbound 入站闸门', () => {
  it('白名单消息放行，并记录去重指纹', () => {
    const { config, state, now } = setup()
    const result = evaluateInbound({ message: inbound(), config, state, now })
    expect(result.decision).toEqual({ skip: false })
    expect(result.halt).toBeUndefined()
    expect(state.seen['wxid_alice:msg-1']).toBe(now)
  })

  it('重复消息 -> duplicate，且不重复写指纹', () => {
    const { config, state, now } = setup()
    state.seen['wxid_alice:msg-1'] = now - 1000
    const result = evaluateInbound({ message: inbound(), config, state, now })
    expect(result.decision.skip && result.decision.reason).toBe('duplicate')
    expect(state.seen).toEqual({ 'wxid_alice:msg-1': now - 1000 })
  })

  it('白名单外 -> not-whitelisted（无副作用）', () => {
    const { config, state, now } = setup()
    const result = evaluateInbound({ message: inbound({ contactId: 'wxid_bob', contactName: '路人' }), config, state, now })
    expect(result.decision.skip && result.decision.reason).toBe('not-whitelisted')
    expect(state.seen).toEqual({})
  })

  it('群聊 -> group-chat', () => {
    const { config, state, now } = setup()
    const result = evaluateInbound({ message: inbound({ chatType: 'group' }), config, state, now })
    expect(result.decision.skip && result.decision.reason).toBe('group-chat')
    expect(state.seen).toEqual({})
  })

  it('空消息 -> empty-message', () => {
    const { config, state, now } = setup()
    for (const text of ['', '   ']) {
      const result = evaluateInbound({ message: inbound({ text }), config, state, now })
      expect(result.decision.skip && result.decision.reason).toBe('empty-message')
    }
    expect(state.seen).toEqual({})
  })

  it('纯标点/空白 -> noise', () => {
    const { config, state, now } = setup()
    const result = evaluateInbound({ message: inbound({ text: '。。。' }), config, state, now })
    expect(result.decision.skip && result.decision.reason).toBe('noise')
  })

  it('纯表情/非文本 -> pure-sticker', () => {
    const { config, now } = setup()
    const cases = [inbound({ kind: 'sticker', text: '[表情]' }), inbound({ kind: 'text', text: '😀😀' }), inbound({ kind: 'voice', text: '[语音]' })]
    for (const message of cases) {
      const state = createInitialState(now)
      const result = evaluateInbound({ message, config, state, now })
      expect(result.decision.skip && result.decision.reason).toBe('pure-sticker')
      expect(state.seen).toEqual({})
    }
  })

  it('ignorePureSticker=false 时纯表情也放行', () => {
    const config = testConfig((value) => {
      value.reply.ignorePureSticker = false
    })
    const state = createInitialState(FRIDAY_EVENING)
    const result = evaluateInbound({ message: inbound({ kind: 'sticker', text: '[表情]' }), config, state, now: FRIDAY_EVENING })
    expect(result.decision).toEqual({ skip: false })
  })

  it('已暂停 -> paused 且不返回 halt（避免 engine 重复风控通知）', () => {
    const { config, state, now } = setup()
    state.paused = true
    state.pauseReason = 'chat-stop-command'
    const result = evaluateInbound({ message: inbound(), config, state, now })
    expect(result.decision.skip && result.decision.reason).toBe('paused')
    expect(result.halt).toBeUndefined()
    expect(state.paused).toBe(true)
  })

  it('已熔断 -> breaker 并返回 halt（让 engine 走风控流程）', () => {
    const { config, state, now } = setup()
    state.breaker = { tripped: true, reason: 'captcha:验证码', at: now }
    const result = evaluateInbound({ message: inbound(), config, state, now })
    expect(result.decision.skip && result.decision.reason).toBe('breaker')
    expect(result.halt).toEqual({ type: 'breaker', reason: 'captcha:验证码' })
  })

  it('插件禁用 -> disabled', () => {
    const { config, state, now } = setup()
    config.enabled = false
    const result = evaluateInbound({ message: inbound(), config, state, now })
    expect(result.decision.skip && result.decision.reason).toBe('disabled')
  })

  it('自己的消息 -> self-message', () => {
    const { config, state, now } = setup()
    const result = evaluateInbound({ message: inbound(), config, state, now, selfContactId: 'wxid_alice' })
    expect(result.decision.skip && result.decision.reason).toBe('self-message')
    expect(state.seen).toEqual({})
  })

  it('免打扰时段 -> offline-hours', () => {
    const now = atLocal(2026, 9, 30, 3, 0)
    const { config, state } = setup(now)
    const result = evaluateInbound({ message: inbound({}, now), config, state, now })
    expect(result.decision.skip && result.decision.reason).toBe('offline-hours')
    expect(state.seen).toEqual({})
  })

  it('每小时频控 -> rate-hour-limit（无副作用）', () => {
    const { config, state, now } = setup()
    state.rate['wxid_alice'] = rateCounter(now, { hourCount: 10, dayCount: 10 })
    const result = evaluateInbound({ message: inbound(), config, state, now })
    expect(result.decision.skip && result.decision.reason).toBe('rate-hour-limit')
    expect(state.seen).toEqual({})
    expect(state.rate['wxid_alice']?.hourCount).toBe(10)
  })

  it('低活跃日上限 -> low-activity-day-limit', () => {
    const now = MONDAY_NOON
    const { config, state } = setup(now)
    state.rate['wxid_alice'] = rateCounter(now, { hourCount: 0, dayCount: 5 })
    const result = evaluateInbound({ message: inbound({}, now), config, state, now })
    expect(result.decision.skip && result.decision.reason).toBe('low-activity-day-limit')
  })

  it('禁止话题 -> forbidden-content + halt pause', () => {
    const { config, state, now } = setup()
    const result = evaluateInbound({ message: inbound({ text: '我先给你转账' }), config, state, now })
    expect(result.decision.skip && result.decision.reason).toBe('forbidden-content')
    expect(result.decision.skip && result.decision.detail).toContain('转账')
    expect(result.halt).toEqual({ type: 'pause', reason: 'forbidden-content:转账' })
    expect(state.seen).toEqual({})
    expect(state.paused).toBe(false)
  })

  it('pauseOnForbiddenInbound=false 时只 skip 不返回 halt', () => {
    const config = testConfig((value) => {
      value.safety.pauseOnForbiddenInbound = false
    })
    const state = createInitialState(FRIDAY_EVENING)
    const result = evaluateInbound({ message: inbound({ text: '验证码是多少' }), config, state, now: FRIDAY_EVENING })
    expect(result.decision.skip && result.decision.reason).toBe('forbidden-content')
    expect(result.halt).toBeUndefined()
  })

  it('白名单按别名/联系人名匹配', () => {
    const { config, state, now } = setup()
    const result = evaluateInbound({ message: inbound({ contactId: 'wxid_unknown', contactName: 'Alice' }), config, state, now })
    expect(result.decision).toEqual({ skip: false })
    expect(state.seen['wxid_unknown:msg-1']).toBe(now)
  })

  it('去重指纹超过上限时淘汰最旧的一条', () => {
    const { config, state, now } = setup()
    for (let index = 0; index < 2000; index += 1) {
      state.seen[`c:${index}`] = now - 2000 + index
    }
    const result = evaluateInbound({ message: inbound(), config, state, now })
    expect(result.decision).toEqual({ skip: false })
    expect(Object.keys(state.seen).length).toBe(2000)
    expect(state.seen['c:0']).toBeUndefined()
    expect(state.seen['wxid_alice:msg-1']).toBe(now)
  })

  it('去重指纹超过上限时清理 >6 小时的旧记录', () => {
    const { config, state, now } = setup()
    const sevenHoursAgo = now - 7 * 60 * 60 * 1000
    for (let index = 0; index < 2000; index += 1) {
      state.seen[`old:${index}`] = sevenHoursAgo
    }
    const result = evaluateInbound({ message: inbound(), config, state, now })
    expect(result.decision).toEqual({ skip: false })
    expect(Object.keys(state.seen)).toEqual(['wxid_alice:msg-1'])
  })
})
