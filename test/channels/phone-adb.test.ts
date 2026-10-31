import { describe, expect, it } from 'vitest'

import {
  PhoneAdbChannel,
  parseWechatNotifications,
  type CommandRunner,
} from '../../src/channels/phone-adb.ts'
import type { InboundMessage, RiskSignal, SendResult } from '../../src/types.ts'
import { makeConfig, makeDeps, readFixture, waitFor, type TestDeps } from './helpers.ts'

interface Reply {
  code: number
  stdout: string
  stderr: string
}

const DEVICES_OK: Reply = {
  code: 0,
  stdout: 'List of devices attached\nemulator-5554\tdevice\n',
  stderr: '',
}

const DUMPSYS_EMPTY: Reply = {
  code: 0,
  stdout: 'Current Notification State:\n  NotificationRecord(0x00 pkg=com.android.settings user=0 id=1):\n    android.title=String (设置)\n    android.text=String (与微信无关)\n    postedTime=1\n',
  stderr: '',
}

interface FakeAdb {
  calls: string[][]
  run: CommandRunner
}

function fakeAdb(handler: (args: string[]) => Reply | null): FakeAdb {
  const calls: string[][] = []
  const run: CommandRunner = async (args) => {
    calls.push([...args])
    return handler(args) ?? { code: 0, stdout: '', stderr: '' }
  }
  return { calls, run }
}

function healthyAdb(dumpsys: Reply = DUMPSYS_EMPTY): FakeAdb {
  return fakeAdb((args) => {
    if (args.includes('devices')) return DEVICES_OK
    if (args.includes('dumpsys')) return dumpsys
    return null
  })
}

interface Harness {
  channel: PhoneAdbChannel
  deps: TestDeps
  messages: InboundMessage[]
  risks: RiskSignal[]
  start: () => Promise<void>
}

function makeHarness(options: {
  run: CommandRunner
  serial?: string
  phoneAdb?: (cfg: ReturnType<typeof makeConfig>['channels']['phoneAdb']) => void
  whitelist?: boolean
}): Harness {
  const deps = makeDeps()
  const config = makeConfig((cfg) => {
    cfg.activeChannel = 'phone-adb'
    cfg.whitelist = options.whitelist === false
      ? []
      : [{ id: 'wxid_zhangsan', name: '张三', aliases: ['老张'], note: '' }]
    if (options.serial !== undefined) cfg.channels.phoneAdb.serial = options.serial
    options.phoneAdb?.(cfg.channels.phoneAdb)
  })
  const channel = new PhoneAdbChannel({ config, deps, run: options.run })
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

describe('parseWechatNotifications', () => {
  it('解析 dumpsys 夹具：只保留微信包，并拼接标题/正文', () => {
    const records = parseWechatNotifications(readFixture('dumpsys-sample.txt'), 'com.tencent.mm')
    expect(records).toHaveLength(4)
    expect(records[0]).toMatchObject({
      packageName: 'com.tencent.mm',
      title: '张三',
      text: '在吗？晚上吃啥',
      postedTime: '1700000000123',
    })
    expect(records.map((record) => record.title)).toEqual(['张三', '微信团队', '老张', '项目群'])
  })

  it('自定义 packageName 也生效，且非微信包被忽略', () => {
    const records = parseWechatNotifications(readFixture('dumpsys-sample.txt'), 'com.android.settings')
    expect(records.some((record) => record.packageName === 'com.android.settings')).toBe(true)
    expect(records.some((record) => record.packageName === 'com.tencent.mm')).toBe(true)
  })
})

describe('PhoneAdbChannel', () => {
  it('无设备时 start 不抛异常，状态为 error/degraded 并记录 lastError', async () => {
    const adb = fakeAdb((args) => {
      if (args.includes('devices')) {
        return { code: 1, stdout: '', stderr: 'error: no devices/emulators found' }
      }
      return null
    })
    const harness = makeHarness({ run: adb.run })

    await expect(harness.start()).resolves.toBeUndefined()

    const status = await waitFor(
      () => {
        const current = harness.channel.status()
        return current.state === 'error' || current.state === 'degraded' ? current : null
      },
      { label: '等待 adb 健康检查失败状态' },
    )
    expect(status.lastError).toBeTruthy()
    expect(status.lastError).toContain('adb devices 失败')
    // 并没有真去跑 dumpsys。
    expect(adb.calls.some((args) => args.includes('dumpsys'))).toBe(false)
    await harness.channel.stop()
  })

  it('有设备时解析通知：白名单单聊投递、风控上报、群聊与非微信包过滤、同批不重复', async () => {
    const adb = healthyAdb({ code: 0, stdout: readFixture('dumpsys-sample.txt'), stderr: '' })
    const harness = makeHarness({ run: adb.run, serial: 'emulator-5554' })

    await harness.start()

    await waitFor(() => harness.messages.length >= 2, { label: '等待两条白名单入站' })
    await waitFor(() => harness.risks.length >= 1, { label: '等待风控信号' })

    expect(adb.calls).toContainEqual(['-s', 'emulator-5554', 'shell', 'dumpsys', 'notification', '--noredact'])
    expect(harness.messages.map((message) => message.contactName)).toEqual(['张三', '老张'])
    expect(harness.messages.every((message) => message.chatType === 'single')).toBe(true)
    expect(harness.messages[0]).toMatchObject({
      contactId: 'wxid_zhangsan',
      kind: 'text',
      text: '在吗？晚上吃啥',
      receivedAt: 1700000000123,
    })
    // 微信团队不在白名单，但风控文案必须先于白名单被上报。
    expect(harness.risks[0]!.kind).toBe('login-abnormal')
    expect(harness.risks[0]!.matched).toBe('异常登录')
    expect(harness.channel.status().state).toBe('running')

    // 同一份通知在下一轮轮询中不得重复投递。
    await harness.deps.clock.advance(1000)
    await harness.deps.clock.flush()
    expect(harness.messages).toHaveLength(2)
    expect(harness.risks).toHaveLength(1)
    await harness.channel.stop()
  })

  it('发送文本走 ADB_INPUT_B64 广播，随后回车键发送', async () => {
    const adb = healthyAdb()
    const harness = makeHarness({ run: adb.run })
    await harness.start()
    await waitFor(() => harness.channel.status().state === 'running', { label: '等待通道 running' })

    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '晚上好呀' })
    expect(result).toEqual({ ok: true })

    const broadcast = adb.calls.find((args) => args.includes('ADB_INPUT_B64'))
    expect(broadcast).toBeTruthy()
    expect(broadcast).toContain('am')
    expect(broadcast).toContain('--es')
    expect(broadcast).toContain('msg')
    const payload = broadcast!.at(-1)!
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('晚上好呀')

    expect(adb.calls).toContainEqual(['shell', 'input', 'keyevent', '66'])
    expect(harness.channel.status().lastSendAt).toBe(harness.deps.clock.now())
    await harness.channel.stop()
  })

  it('配置 sendButton 时改为点击坐标发送', async () => {
    const adb = healthyAdb()
    const harness = makeHarness({
      run: adb.run,
      phoneAdb: (cfg) => {
        cfg.sendButton = { x: 1000, y: 2000 }
      },
    })
    await harness.start()
    await waitFor(() => harness.channel.status().state === 'running', { label: '等待通道 running' })

    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '坐标发送' })
    expect(result.ok).toBe(true)
    expect(adb.calls).toContainEqual(['shell', 'input', 'tap', '1000', '2000'])
    expect(adb.calls.some((args) => args.includes('keyevent'))).toBe(false)
    await harness.channel.stop()
  })

  it('inputMethod=tap-keys 时逐字符 input text', async () => {
    const adb = healthyAdb()
    const harness = makeHarness({
      run: adb.run,
      phoneAdb: (cfg) => {
        cfg.inputMethod = 'tap-keys'
      },
    })
    await harness.start()
    await waitFor(() => harness.channel.status().state === 'running', { label: '等待通道 running' })

    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: 'hi' })
    expect(result.ok).toBe(true)

    const textCalls = adb.calls.filter((args) => args.includes('input') && args.includes('text'))
    expect(textCalls).toEqual([
      ['shell', 'input', 'text', 'h'],
      ['shell', 'input', 'text', 'i'],
    ])
    expect(adb.calls.some((args) => args.includes('ADB_INPUT_B64'))).toBe(false)
    await harness.channel.stop()
  })

  it('发送表情：先点表情按钮，等 300ms，再点随机格子', async () => {
    const adb = healthyAdb()
    const grid = [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }]
    const harness = makeHarness({
      run: adb.run,
      phoneAdb: (cfg) => {
        cfg.stickerButton = { x: 1, y: 2 }
        cfg.stickerGrid = grid
      },
    })
    await harness.start()
    await waitFor(() => harness.channel.status().state === 'running', { label: '等待通道 running' })

    const pending: Promise<SendResult> = harness.channel.send('wxid_zhangsan', {
      kind: 'sticker',
      stickerId: 'sticker-1',
      file: 'stickers/sticker-1.png',
    })
    // 等第一次 tap（表情按钮）发生，再让 300ms 面板动画 sleep 注册进假时钟。
    await waitFor(() => adb.calls.some((args) => args.join(' ') === 'shell input tap 1 2'), {
      label: '等待点击表情按钮',
    })
    await harness.deps.clock.flush()
    expect(harness.deps.clock.pendingTimers).toBeGreaterThan(0)
    await harness.deps.clock.advance(300)
    const result = await pending

    expect(result.ok).toBe(true)
    const gridTaps = adb.calls
      .filter((args) => args.includes('tap'))
      .map((args) => `${args.at(-2)},${args.at(-1)}`)
    expect(gridTaps[0]).toBe('1,2')
    expect(grid.map((point) => `${point.x},${point.y}`)).toContain(gridTaps[1])
    await harness.channel.stop()
  })

  it('表情坐标未配置时返回明确错误', async () => {
    const adb = healthyAdb()
    const harness = makeHarness({ run: adb.run })
    await harness.start()
    await waitFor(() => harness.channel.status().state === 'running', { label: '等待通道 running' })

    const result = await harness.channel.send('wxid_zhangsan', {
      kind: 'sticker',
      stickerId: 'sticker-1',
      file: 'stickers/sticker-1.png',
    })
    expect(result).toEqual({ ok: false, error: 'sticker 坐标未配置' })
    await harness.channel.stop()
  })

  it('广播失败时返回 ok:false 且错误包含 ADB_INPUT_B64', async () => {
    const adb = fakeAdb((args) => {
      if (args.includes('devices')) return DEVICES_OK
      if (args.includes('dumpsys')) return DUMPSYS_EMPTY
      if (args.includes('ADB_INPUT_B64')) return { code: 1, stdout: '', stderr: 'Error: broadcast failed' }
      return null
    })
    const harness = makeHarness({ run: adb.run })
    await harness.start()
    await waitFor(() => harness.channel.status().state === 'running', { label: '等待通道 running' })

    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '发不出去' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ADB_INPUT_B64')
    await harness.channel.stop()
  })

  it('未 start 时发送返回通道未启动', async () => {
    const adb = healthyAdb()
    const harness = makeHarness({ run: adb.run })
    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(result).toEqual({ ok: false, error: '通道未启动' })
  })

  it('默认不截图：allowScreenshot=false 时 captureScreenshot 直接拒绝', async () => {
    const adb = healthyAdb()
    const harness = makeHarness({ run: adb.run })
    const result = await harness.channel.captureScreenshot()
    expect(result.ok).toBe(false)
    expect(result.error).toBe('截图未启用（channels.phoneAdb.allowScreenshot=false）')
    expect(adb.calls).toEqual([])
  })
})
