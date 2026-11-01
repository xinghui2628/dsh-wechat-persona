/**
 * 发送生命周期状态机单测（任务书 9.1 / task-12）。
 *
 * 覆盖：全部合法转换、全部非法转换（遍历 10×10 状态对）、终态语义、中文标签。
 */

import { describe, expect, it } from 'vitest'
import {
  SEND_STATES,
  SEND_STATE_LABELS,
  SEND_TRANSITIONS,
  assertTransition,
  canTransition,
  describeSendState,
  isRetryableFailureState,
  isSendState,
  isTerminalSendState,
} from '../../src/core/send-state.ts'
import type { SendState } from '../../src/core/send-state.ts'

function tableAllows(from: SendState, to: SendState): boolean {
  return SEND_TRANSITIONS[from].includes(to)
}

describe('send-state：发送生命周期状态机（9.1）', () => {
  it('暴露固定的 10 个状态，且每个状态都有转换表', () => {
    expect(SEND_STATES).toHaveLength(10)
    expect(new Set(SEND_STATES).size).toBe(10)
    for (const state of SEND_STATES) {
      expect(Array.isArray(SEND_TRANSITIONS[state])).toBe(true)
      expect(SEND_STATE_LABELS[state]).toBeTruthy()
    }
    expect(SEND_STATES).toEqual([
      'received',
      'validated',
      'generating',
      'draft',
      'ready',
      'sending',
      'confirmed',
      'failed',
      'unknown',
      'cancelled',
    ])
  })

  it('遍历 10×10 状态对：canTransition 与转换表完全一致（合法不抛、非法必抛）', () => {
    let legal = 0
    let illegal = 0
    for (const from of SEND_STATES) {
      for (const to of SEND_STATES) {
        const allowed = tableAllows(from, to)
        if (allowed) {
          legal += 1
          expect(canTransition(from, to)).toBe(true)
          expect(() => assertTransition(from, to)).not.toThrow()
        } else {
          illegal += 1
          expect(canTransition(from, to)).toBe(false)
          expect(() => assertTransition(from, to)).toThrow(/非法发送状态转换/)
        }
      }
    }
    expect(legal).toBeGreaterThan(0)
    expect(illegal).toBeGreaterThan(0)
    expect(legal + illegal).toBe(SEND_STATES.length * SEND_STATES.length)
  })

  it('终态 confirmed / unknown / cancelled 没有出边；failed 只允许显式重排回 ready', () => {
    expect(SEND_TRANSITIONS.confirmed).toEqual([])
    expect(SEND_TRANSITIONS.unknown).toEqual([])
    expect(SEND_TRANSITIONS.cancelled).toEqual([])
    expect(SEND_TRANSITIONS.failed).toEqual(['ready'])
    for (const state of ['confirmed', 'unknown', 'cancelled'] as const) {
      expect(isTerminalSendState(state)).toBe(true)
    }
    expect(isTerminalSendState('failed')).toBe(true)
    expect(isRetryableFailureState('failed')).toBe(true)
    expect(isRetryableFailureState('unknown')).toBe(false)
    expect(isTerminalSendState('sending')).toBe(false)
    expect(isTerminalSendState('draft')).toBe(false)
  })

  it('sending 只能进入 confirmed / failed / unknown / cancelled，不能回到 ready', () => {
    expect(canTransition('sending', 'confirmed')).toBe(true)
    expect(canTransition('sending', 'failed')).toBe(true)
    expect(canTransition('sending', 'unknown')).toBe(true)
    expect(canTransition('sending', 'cancelled')).toBe(true)
    expect(canTransition('sending', 'ready')).toBe(false)
    expect(canTransition('sending', 'sending')).toBe(false)
  })

  it('draft 只能由批准（ready）/拒绝（cancelled）/失败离开，不能被当作已发送', () => {
    expect(canTransition('draft', 'ready')).toBe(true)
    expect(canTransition('draft', 'cancelled')).toBe(true)
    expect(canTransition('draft', 'failed')).toBe(true)
    expect(canTransition('draft', 'sending')).toBe(false)
    expect(canTransition('draft', 'confirmed')).toBe(false)
  })

  it('describeSendState 返回中文标签，isSendState 做运行时校验', () => {
    expect(describeSendState('unknown')).toBe('结果未知')
    expect(describeSendState('confirmed')).toBe('已确认发出')
    expect(describeSendState('not-a-state' as SendState)).toBe('not-a-state')
    expect(isSendState('sending')).toBe(true)
    expect(isSendState('bogus')).toBe(false)
    expect(isSendState(42)).toBe(false)
  })
})
