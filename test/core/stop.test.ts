import { describe, expect, it } from 'vitest'
import { createInitialState } from '../../src/core/state.ts'
import { isResumeCommand, isStopCommand, pauseEngine, resumeEngine } from '../../src/core/stop.ts'
import { FRIDAY_EVENING } from './fakes.ts'

const NOW = FRIDAY_EVENING

describe('isStopCommand / isResumeCommand', () => {
  it('/stop 命令识别（trim + 忽略大小写）', () => {
    expect(isStopCommand('/stop')).toBe(true)
    expect(isStopCommand(' /STOP ')).toBe(true)
    expect(isStopCommand('/Stop')).toBe(true)
    expect(isStopCommand('/stop!')).toBe(false)
    expect(isStopCommand('stop')).toBe(false)
    expect(isStopCommand('')).toBe(false)
  })

  it('/resume 与 /start 命令识别', () => {
    expect(isResumeCommand('/resume')).toBe(true)
    expect(isResumeCommand(' /START ')).toBe(true)
    expect(isResumeCommand('/Resume')).toBe(true)
    expect(isResumeCommand('/stop')).toBe(false)
    expect(isResumeCommand('resume')).toBe(false)
  })
})

describe('pauseEngine / resumeEngine', () => {
  it('pauseEngine 记录暂停原因与时间', () => {
    const state = createInitialState(NOW)
    pauseEngine(state, 'chat-stop-command', NOW)
    expect(state.paused).toBe(true)
    expect(state.pauseReason).toBe('chat-stop-command')
    expect(state.pausedAt).toBe(NOW)
  })

  it('resumeEngine 清空暂停字段', () => {
    const state = createInitialState(NOW)
    pauseEngine(state, 'chat-stop-command', NOW)
    resumeEngine(state)
    expect(state.paused).toBe(false)
    expect(state.pauseReason).toBeUndefined()
    expect(state.pausedAt).toBeUndefined()
  })

  it('resumeEngine({ clearBreaker: true }) 同时清熔断', () => {
    const state = createInitialState(NOW)
    state.breaker = { tripped: true, reason: 'captcha:验证码', at: NOW }
    pauseEngine(state, 'risk-control', NOW)
    resumeEngine(state, { clearBreaker: true })
    expect(state.paused).toBe(false)
    expect(state.breaker).toEqual({ tripped: false })
  })
})
