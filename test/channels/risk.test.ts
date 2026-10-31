import { describe, expect, it } from 'vitest'

import { detectChannelRisk, riskKeywordsOf, BUILTIN_RISK_PATTERNS } from '../../src/channels/risk.ts'
import { makeConfig } from './helpers.ts'

describe('detectChannelRisk', () => {
  it('识别异常登录', () => {
    const signal = detectChannelRisk('你的账号存在异常登录行为，请立即处理', makeConfig())
    expect(signal).not.toBeNull()
    expect(signal!.kind).toBe('login-abnormal')
    expect(signal!.matched).toBe('异常登录')
    expect(signal!.text).toContain('异常登录')
    expect(typeof signal!.at).toBe('number')
  })

  it('识别验证码 / 安全验证文案', () => {
    const captcha = detectChannelRisk('请输入短信验证码完成登录', makeConfig())
    expect(captcha?.kind).toBe('captcha')
    expect(captcha?.matched).toBe('短信验证码')

    const verify = detectChannelRisk('为保障账号安全，请完成安全验证', makeConfig())
    expect(verify?.kind).toBe('captcha')
    expect(verify?.matched).toBe('安全验证')
  })

  it('识别账号受限与封禁', () => {
    expect(detectChannelRisk('你的账号已被限制登录', makeConfig())?.kind).toBe('restricted')
    expect(detectChannelRisk('该账号存在异常，已被冻结', makeConfig())?.kind).toBe('restricted')
    expect(detectChannelRisk('因违规发送，账号被封禁 7 天', makeConfig())?.kind).toBe('restricted')
  })

  it('识别发送频率限制，并采用最长的关键词', () => {
    const signal = detectChannelRisk('你操作过于频繁，请稍后再试', makeConfig())
    expect(signal?.kind).toBe('spam-limit')
    // 「操作过于频繁」比「频繁」「请稍后再试」都长，必须报最长的那个。
    expect(signal?.matched).toBe('操作过于频繁')
  })

  it('普通聊天文本返回 null', () => {
    expect(detectChannelRisk('在吗？晚上一起吃火锅不', makeConfig())).toBeNull()
    expect(detectChannelRisk('今天天气不错，出去走走', makeConfig())).toBeNull()
  })

  it('空串与非法输入返回 null', () => {
    expect(detectChannelRisk('', makeConfig())).toBeNull()
    expect(detectChannelRisk(null as unknown as string, makeConfig())).toBeNull()
    expect(detectChannelRisk(undefined as unknown as string, makeConfig())).toBeNull()
  })

  it('config.safety.riskKeywords 作为追加规则，kind 为 unknown', () => {
    const config = makeConfig()
    config.safety.riskKeywords = ['本机测试暗号']
    const signal = detectChannelRisk('收到一条本机测试暗号消息', config)
    expect(signal?.kind).toBe('unknown')
    expect(signal?.matched).toBe('本机测试暗号')
    expect(signal?.text).toContain('本机测试暗号')
  })

  it('用户追加词与内置词完全重复时，保留内置 kind', () => {
    const config = makeConfig()
    config.safety.riskKeywords = ['验证码']
    const signal = detectChannelRisk('请输入验证码', config)
    expect(signal?.kind).toBe('captcha')
    expect(signal?.matched).toBe('验证码')
  })

  it('长文本的 excerpt 截断到 80 字符以内且带省略号', () => {
    const text = `${'前置内容'.repeat(40)}你的账号存在异常登录${'后续内容'.repeat(40)}`
    const signal = detectChannelRisk(text, makeConfig())
    expect(signal).not.toBeNull()
    expect(signal!.text.length).toBeLessThanOrEqual(80)
    expect(signal!.text).toContain('异常登录')
    expect(signal!.text.startsWith('…')).toBe(true)
    expect(signal!.text.endsWith('…')).toBe(true)
  })

  it('at 是当前时间戳', () => {
    const before = Date.now()
    const signal = detectChannelRisk('请输入验证码', makeConfig())
    const after = Date.now()
    expect(signal!.at).toBeGreaterThanOrEqual(before)
    expect(signal!.at).toBeLessThanOrEqual(after)
  })

  it('riskKeywordsOf 返回内置词表分组', () => {
    expect(riskKeywordsOf('captcha')).toContain('验证码')
    expect(riskKeywordsOf('captcha')).toContain('安全验证')
    expect(riskKeywordsOf('restricted')).toContain('限制登录')
    expect(riskKeywordsOf('spam-limit')).toContain('操作过于频繁')
    expect(BUILTIN_RISK_PATTERNS.length).toBeGreaterThan(20)
  })
})
