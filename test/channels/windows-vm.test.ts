import net from 'node:net'

import { describe, expect, it } from 'vitest'

import { WindowsVmChannel } from '../../src/channels/windows-vm.ts'
import type { InboundMessage, RiskSignal } from '../../src/types.ts'
import { delay, makeConfig, makeDeps, waitFor, type TestDeps } from './helpers.ts'

interface FakeServerHandle {
  port: number
  received: Record<string, unknown>[]
  connectionCount: () => number
  sendLine: (payload: unknown) => void
  destroyClients: () => void
  close: () => Promise<void>
}

interface FakeServerOptions {
  token: string
  onHello?: (socket: net.Socket, message: Record<string, unknown>) => void
  onSend?: (socket: net.Socket, message: Record<string, unknown>) => void
}

function writeLine(socket: net.Socket, payload: unknown): void {
  if (socket.destroyed) return
  socket.write(`${JSON.stringify(payload)}\n`)
}

/** 本地 127.0.0.1 假 VM agent：JSON-lines 服务端，仅用于测试。 */
async function startFakeServer(options: FakeServerOptions): Promise<FakeServerHandle> {
  const received: Record<string, unknown>[] = []
  const sockets = new Set<net.Socket>()
  let connections = 0

  const server = net.createServer((socket) => {
    connections += 1
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        received.push(message)
        if (message.type === 'hello') {
          if (message.token !== options.token) {
            socket.destroy()
            continue
          }
          options.onHello?.(socket, message)
        } else if (message.type === 'send') {
          options.onSend?.(socket, message)
        } else if (message.type === 'ping') {
          writeLine(socket, { type: 'pong' })
        }
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as net.AddressInfo

  return {
    port: address.port,
    received,
    connectionCount: () => connections,
    sendLine: (payload) => {
      for (const socket of sockets) writeLine(socket, payload)
    },
    destroyClients: () => {
      for (const socket of sockets) socket.destroy()
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

interface VmHarness {
  channel: WindowsVmChannel
  deps: TestDeps
  messages: InboundMessage[]
  risks: RiskSignal[]
  start: () => Promise<void>
}

function makeVmHarness(options: {
  port: number
  token?: string
  connectTimeoutMs?: number
  reconnectIntervalMs?: number
}): VmHarness {
  const deps = makeDeps()
  const config = makeConfig((cfg) => {
    cfg.activeChannel = 'windows-vm'
    cfg.whitelist = [{ id: 'wxid_zhangsan', name: '张三', aliases: ['老张'], note: '' }]
    cfg.channels.windowsVm = {
      host: '127.0.0.1',
      port: options.port,
      token: options.token ?? 'secret-test',
      connectTimeoutMs: options.connectTimeoutMs ?? 300,
      reconnectIntervalMs: options.reconnectIntervalMs ?? 50,
    }
  })
  const channel = new WindowsVmChannel({ config, deps })
  const messages: InboundMessage[] = []
  const risks: RiskSignal[] = []
  return {
    channel,
    deps,
    messages,
    risks,
    start: async () => {
      await channel.start(
        (message) => messages.push(message),
        (signal) => risks.push(signal),
      )
    },
  }
}

describe('WindowsVmChannel', () => {
  it('hello 鉴权、inbound/risk 往返与白名单过滤', async () => {
    const server = await startFakeServer({
      token: 'secret-test',
      onHello: (socket) => {
        writeLine(socket, {
          type: 'inbound',
          message: {
            id: 'vm-1',
            contactId: 'wxid_zhangsan',
            contactName: '张三',
            chatType: 'single',
            kind: 'text',
            text: '虚拟机来的消息',
            receivedAt: 1_700_000_000_000,
          },
        })
        writeLine(socket, {
          type: 'inbound',
          message: {
            id: 'vm-2',
            contactId: 'wxid_zhangsan',
            contactName: '张三',
            chatType: 'group',
            kind: 'text',
            text: '群消息应被过滤',
          },
        })
        writeLine(socket, {
          type: 'inbound',
          message: { id: 'vm-3', contactId: 'wxid_stranger', contactName: '陌生人', text: '非白名单' },
        })
        writeLine(socket, { type: 'risk', kind: 'captcha', text: '请输入验证码' })
      },
    })
    const harness = makeVmHarness({ port: server.port })

    try {
      await harness.start()
      const hello = await waitFor(
        () => server.received.find((message) => message.type === 'hello'),
        { label: '等待 hello' },
      )
      expect(hello.token).toBe('secret-test')

      await waitFor(() => harness.messages.length >= 1, { label: '等待 inbound' })
      await waitFor(() => harness.risks.length >= 1, { label: '等待 risk' })
      // 群聊与非白名单不得投递。
      expect(harness.messages.map((message) => message.id)).toEqual(['vm-1'])
      expect(harness.messages[0]!.text).toBe('虚拟机来的消息')
      expect(harness.risks[0]!.kind).toBe('captcha')
      expect(harness.channel.status().state).toBe('running')
      expect(harness.channel.status().lastInboundAt).toBe(harness.deps.clock.now())
    } finally {
      await harness.channel.stop()
      await server.close()
    }
  })

  it('send 走 JSON-lines 并用 send-result 返回结果', async () => {
    const server = await startFakeServer({
      token: 'secret-test',
      onSend: (socket, message) => {
        writeLine(socket, { type: 'send-result', reqId: message.reqId, ok: true })
      },
    })
    const harness = makeVmHarness({ port: server.port })

    try {
      await harness.start()
      await waitFor(() => harness.channel.status().state === 'running', { label: '等待连接成功' })

      const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '晚上好' })
      expect(result).toEqual({ ok: true })

      const sent = server.received.find((message) => message.type === 'send')
      expect(sent).toBeTruthy()
      expect(typeof sent!.reqId).toBe('string')
      expect(sent!.contactId).toBe('wxid_zhangsan')
      expect(sent!.part).toEqual({ kind: 'text', text: '晚上好' })
      expect(harness.channel.status().lastSendAt).toBe(harness.deps.clock.now())
    } finally {
      await harness.channel.stop()
      await server.close()
    }
  })

  it('服务端返回 ok:false 时错误透传', async () => {
    const server = await startFakeServer({
      token: 'secret-test',
      onSend: (socket, message) => {
        writeLine(socket, {
          type: 'send-result',
          reqId: message.reqId,
          ok: false,
          error: 'UIA 驱动未实现',
        })
      },
    })
    const harness = makeVmHarness({ port: server.port })

    try {
      await harness.start()
      await waitFor(() => harness.channel.status().state === 'running', { label: '等待连接成功' })

      const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '发不出去' })
      expect(result).toEqual({ ok: false, error: 'UIA 驱动未实现' })
    } finally {
      await harness.channel.stop()
      await server.close()
    }
  })

  it('断线后 status 变 degraded，并自动重连恢复 running', async () => {
    const server = await startFakeServer({ token: 'secret-test' })
    const harness = makeVmHarness({ port: server.port })

    try {
      await harness.start()
      await waitFor(() => harness.channel.status().state === 'running', { label: '等待首次连接' })
      expect(server.connectionCount()).toBe(1)

      server.destroyClients()
      const degraded = await waitFor(
        () => {
          const status = harness.channel.status()
          return status.state === 'degraded' || status.state === 'error' ? status : null
        },
        { label: '等待断线状态' },
      )
      expect(degraded.state).toBe('degraded')

      await waitFor(() => server.connectionCount() >= 2, { label: '等待自动重连' })
      await waitFor(() => harness.channel.status().state === 'running', { label: '等待重连后 running' })
    } finally {
      await harness.channel.stop()
      await server.close()
    }
  })

  it('stop 之后不再重连，状态为 stopped', async () => {
    const server = await startFakeServer({ token: 'secret-test' })
    const harness = makeVmHarness({ port: server.port })

    try {
      await harness.start()
      await waitFor(() => harness.channel.status().state === 'running', { label: '等待连接成功' })
      await harness.channel.stop()
      expect(harness.channel.status().state).toBe('stopped')

      const connectionsAfterStop = server.connectionCount()
      await delay(250)
      expect(server.connectionCount()).toBe(connectionsAfterStop)
      expect(harness.channel.status().state).toBe('stopped')
    } finally {
      await server.close()
    }
  })

  it('VM agent 未运行时不抛异常，状态为 error 且带 lastError', async () => {
    // 先占一个端口再释放，保证端口无人监听。
    const probe = net.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    const freePort = (probe.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const harness = makeVmHarness({ port: freePort, connectTimeoutMs: 200, reconnectIntervalMs: 50 })
    try {
      await expect(harness.start()).resolves.toBeUndefined()
      const status = await waitFor(
        () => (harness.channel.status().state === 'error' ? harness.channel.status() : null),
        { label: '等待连接失败状态' },
      )
      expect(status.lastError).toBeTruthy()

      const sendResult = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
      expect(sendResult.ok).toBe(false)
      expect(sendResult.error).toContain('windows-vm 未连接')
    } finally {
      await harness.channel.stop()
    }
  })
})
