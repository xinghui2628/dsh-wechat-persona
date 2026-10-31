import { describe, expect, it } from 'vitest'
import { createInitialState } from '../../src/core/state.ts'
import { detectRisk, resetBreaker, tripBreaker } from '../../src/core/breaker.ts'
import { FRIDAY_EVENING, testConfig } from './fakes.ts'

const config = testConfig()

describe('detectRisk 风控文案识别', () => {
  it('验证码/安全验证 -> captcha', () => {
    expect(detectRisk('请完成验证', config)?.kind).toBe('captcha')
    expect(detectRisk('请完成安全验证后继续', config)?.kind).toBe('captcha')
    expect(detectRisk('输入验证码', config)?.kind).toBe('captcha')
    expect(detectRisk('Please enter the captcha code', config)?.kind).toBe('captcha')
  })

  it('异常登录类 -> login-abnormal', () => {
    expect(detectRisk('你的账号在异地登录', config)?.kind).toBe('login-abnormal')
    expect(detectRisk('检测到异常登录', config)?.kind).toBe('login-abnormal')
    expect(detectRisk('unusual login detected', config)?.kind).toBe('login-abnormal')
  })

  it('账号异常/限制/冻结类 -> restricted', () => {
    expect(detectRisk('你的账号异常，已被限制登录', config)?.kind).toBe('restricted')
    expect(detectRisk('账号存在风险，请谨慎操作', config)?.kind).toBe('restricted')
    expect(detectRisk('该账号已被冻结', config)?.kind).toBe('restricted')
    expect(detectRisk('账号封禁通知', config)?.kind).toBe('restricted')
  })

  it('操作频繁类 -> spam-limit', () => {
    expect(detectRisk('操作频繁，请稍后再试', config)?.kind).toBe('spam-limit')
    expect(detectRisk('发送过于频繁', config)?.kind).toBe('spam-limit')
  })

  it('matched 是命中片段且不超过 40 字', () => {
    const signal = detectRisk('前面一些话，你的账号异常，后面一些话', config)
    expect(signal?.matched).toBe('账号异常')
    expect(signal?.text).toContain('你的账号异常')
    const longKeyword = '风控自定义关键词'.repeat(10)
    const custom = testConfig((value) => {
      value.safety.riskKeywords = [longKeyword]
    })
    const longSignal = detectRisk(`前缀${longKeyword}后缀`, custom)
    expect(longSignal?.kind).toBe('unknown')
    expect([...(longSignal?.matched ?? '')].length).toBeLessThanOrEqual(40)
  })

  it('无命中返回 null', () => {
    expect(detectRisk('今天天气不错', config)).toBeNull()
    expect(detectRisk('', config)).toBeNull()
    expect(detectRisk('   ', config)).toBeNull()
  })

  it('config.safety.riskKeywords 追加识别为 unknown', () => {
    const custom = testConfig((value) => {
      value.safety.riskKeywords = ['扫二维码', '请扫码']
    })
    const signal = detectRisk('麻烦你扫二维码登录', custom)
    expect(signal?.kind).toBe('unknown')
    expect(signal?.matched).toBe('扫二维码')
  })
})

describe('tripBreaker / resetBreaker', () => {
  it('触发熔断：tripped + reason + 同时暂停', () => {
    const state = createInitialState(FRIDAY_EVENING)
    tripBreaker(state, { kind: 'captcha', text: '验证码', matched: '验证码', at: 123456 })
    expect(state.breaker).toEqual({ tripped: true, reason: 'captcha:验证码', at: 123456 })
    expect(state.paused).toBe(true)
    expect(state.pauseReason).toBe('risk-control')
    expect(state.pausedAt).toBe(123456)
  })

  it('signal.at 非法时用当前时间兜底', () => {
    const state = createInitialState(FRIDAY_EVENING)
    tripBreaker(state, { kind: 'restricted', text: '冻结', matched: '冻结', at: 0 })
    expect(state.breaker.tripped).toBe(true)
    expect(state.breaker.at ?? 0).toBeGreaterThan(0)
    expect(state.breaker.reason).toBe('restricted:冻结')
  })

  it('resetBreaker 只清熔断，不动暂停状态', () => {
    const state = createInitialState(FRIDAY_EVENING)
    tripBreaker(state, { kind: 'spam-limit', text: '操作频繁', matched: '操作频繁', at: 1 })
    resetBreaker(state)
    expect(state.breaker).toEqual({ tripped: false })
    expect(state.paused).toBe(true)
    expect(state.pauseReason).toBe('risk-control')
  })
})
