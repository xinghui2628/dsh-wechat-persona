import { describe, expect, it } from 'vitest'

import { createChannel } from '../../src/channels/channel.ts'
import type { InboundMessage, RiskSignal } from '../../src/types.ts'
import { makeConfig, makeDeps, type TestDeps } from './helpers.ts'

function noopHandlers(): {
  handler: (message: InboundMessage) => void
  onRisk: (signal: RiskSignal) => void
} {
  return {
    handler: () => {},
    onRisk: () => {},
  }
}

describe('createChannel', () => {
  it('按 activeChannel 返回对应实现', async () => {
    const ids = ['mock', 'phone-adb', 'windows-vm', 'desktop'] as const
    for (const id of ids) {
      const config = makeConfig((cfg) => {
        cfg.activeChannel = id
        cfg.whitelist = []
        cfg.channels.mock.inboundFile = ''
      })
      const deps: TestDeps = makeDeps()
      const channel = await createChannel(config, deps)
      expect(channel.id).toBe(id)
      expect(channel.status().state).toBe('stopped')
    }
  })

  it('desktop 禁用时 start 不抛异常，状态为 error', async () => {
    const config = makeConfig((cfg) => {
      cfg.activeChannel = 'desktop'
      cfg.channels.desktop.enabled = false
    })
    const deps = makeDeps()
    const channel = await createChannel(config, deps)
    expect(channel.id).toBe('desktop')

    const { handler, onRisk } = noopHandlers()
    await expect(channel.start(handler, onRisk)).resolves.toBeUndefined()
    expect(channel.status().state).toBe('error')
    expect(channel.status().lastError).toBe('桌面通道已禁用')

    const sendResult = await channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(sendResult).toEqual({ ok: false, error: '桌面通道已禁用' })
  })

  it('未知 activeChannel 时 warn 并回退到 mock', async () => {
    const config = makeConfig((cfg) => {
      cfg.activeChannel = 'legacy-unknown-channel' as never
      cfg.channels.mock.inboundFile = ''
    })
    const deps = makeDeps()
    const channel = await createChannel(config, deps)
    expect(channel.id).toBe('mock')
    expect(deps.logger.has('warn', '未知 activeChannel')).toBe(true)
  })

  it('mock 通道默认空转：未配置 inboundFile 时不产生消息', async () => {
    const config = makeConfig((cfg) => {
      cfg.activeChannel = 'mock'
      cfg.channels.mock.inboundFile = ''
    })
    const deps = makeDeps()
    const channel = await createChannel(config, deps)
    const messages: InboundMessage[] = []
    await channel.start(
      (message) => messages.push(message),
      () => {},
    )
    expect(channel.status().state).toBe('running')
    expect(messages).toEqual([])
    await channel.stop()
  })
})
