import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { DesktopChannel } from '../../src/channels/pc/desktop.ts'
import { defaultConfig, migrateConfig, type WechatPersonaConfig } from '../../src/config.ts'
import { MemoryStore } from '../../src/core/memory.ts'
import { createInitialState } from '../../src/core/state.ts'
import { PersonaEngine } from '../../src/engine/engine.ts'
import { createPersonaApi, type PersonaApiDeps } from '../../src/server/api.ts'
import type {
  AuditEvent,
  AuditEventType,
  AuditLogLike,
  AuditSummary,
  Channel,
  ChannelStatus,
  Clock,
  InboundMessage,
  LlmLike,
  LlmRequest,
  LlmResult,
  Logger,
  Notifier,
  PersonaEngineLike,
  SendResult,
  StickerCatalogLike,
} from '../../src/types.ts'
import type { DesktopScriptName, DesktopScriptResult } from '../../src/channels/pc/desktop.ts'
import { MemoryFileStore, TestLogger, makeConfig, makeDeps } from '../channels/helpers.ts'

/**
 * v3.0.0-beta.1 安全闸门（betaSafeMode）回归测试。
 *
 * 目标：全新安装与升级后**默认禁止真实发送**，四层（engine / desktop / API / PS1）都拒绝；
 * mock 通道与只读诊断不受影响；显式 betaSafeMode=false 才允许真实发送；旧配置迁移补 true。
 * 本文件不触达真实微信、不调用真实脚本（桌面通道注入 runScript 记录器，PS1 只做静态检查）。
 */

const NOW = new Date('2026-11-01T12:00:00+08:00').getTime()
const WHITELIST = [{ id: 'wxid_zhangsan', name: '张三', aliases: [], note: '' }]

function baseConfig(mutate: (config: WechatPersonaConfig) => void = () => {}): WechatPersonaConfig {
  return makeConfig((config) => {
    config.whitelist = [...WHITELIST]
    config.activeChannel = 'desktop'
    config.channels.desktop.enabled = true
    config.channels.desktop.driverEnabled = true
    config.reply.stickerProbability = 0
    mutate(config)
  })
}

function inbound(id = 'msg-beta-1'): InboundMessage {
  return {
    id,
    contactId: 'wxid_zhangsan',
    contactName: '张三',
    chatType: 'single',
    kind: 'text',
    text: '在吗？',
    receivedAt: NOW,
  }
}

class InstantClock implements Clock {
  private current: number

  constructor(now: number) {
    this.current = now
  }

  now(): number {
    return this.current
  }

  /**
   * 引擎在拟人延迟里 await clock.sleep；这里立即推进并 resolve，
   * 避免测试像真实时间一样挂起（同 acceptance.test.ts 的 FakeClock 行为）。
   */
  async sleep(ms: number): Promise<void> {
    this.current += ms
  }

  advance(ms: number): void {
    this.current += ms
  }
}

class BetaChannel implements Channel {
  readonly id: 'mock' | 'desktop'
  state: ChannelStatus['state'] = 'stopped'
  handler: ((message: InboundMessage) => Promise<void>) | null = null
  readonly sent: Array<{ contactId: string; part: unknown }> = []
  startCalls = 0
  stopCalls = 0

  constructor(id: 'mock' | 'desktop' = 'mock') {
    this.id = id
  }

  async start(handler: (message: InboundMessage) => Promise<void>, _onRisk?: unknown): Promise<void> {
    this.handler = handler
    this.state = 'running'
    this.startCalls += 1
  }

  async stop(): Promise<void> {
    this.state = 'stopped'
    this.stopCalls += 1
  }

  async send(contactId: string, part: unknown): Promise<SendResult> {
    this.sent.push({ contactId, part })
    return { ok: true, delivery: 'sent' }
  }

  status(): ChannelStatus {
    const snapshot: ChannelStatus & { ocr?: unknown } = { id: this.id, state: this.state, since: 0 }
    return snapshot
  }
}

class BetaLlm implements LlmLike {
  readonly calls: LlmRequest[] = []
  async complete(request: LlmRequest): Promise<LlmResult> {
    this.calls.push(request)
    return {
      text: '哈哈，刚在追剧，你呢？',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      finishReason: 'stop',
      provider: 'fake',
      model: 'fake-model',
      durationMs: 1,
    }
  }
}

class BetaAudit implements AuditLogLike {
  readonly events: AuditEvent[] = []
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event)
  }
  async recent(n: number): Promise<AuditEvent[]> {
    return this.events.slice(-n)
  }
  async summary(): Promise<AuditSummary> {
    const count = (type: AuditEventType) => this.events.filter((event) => event.type === type).length
    return {
      dayKey: '2026-11-01',
      llmCalls: count('llm'),
      llmTokens: 0,
      cacheReadTokens: 0,
      searches: count('search'),
      sends: count('send'),
      drafts: count('draft'),
      skips: {},
    }
  }
  async clear(): Promise<void> {
    this.events.length = 0
  }
  reasons(type: AuditEventType): string[] {
    return this.events.filter((event) => event.type === type).map((event) => event.reason ?? '')
  }
}

class BetaStickers implements StickerCatalogLike {
  categories(): never[] {
    return []
  }
  count(): number {
    return 0
  }
  pick(): null {
    return null
  }
  pickAny(): null {
    return null
  }
}

class BetaNotifier implements Notifier {
  async notify(): Promise<void> {
    /* noop */
  }
}

interface BetaHarness {
  engine: PersonaEngine
  config: WechatPersonaConfig
  channel: BetaChannel
  llm: BetaLlm
  audit: BetaAudit
  store: MemoryFileStore
  clock: InstantClock
}

function makeEngineHarness(config: WechatPersonaConfig, channelId: 'mock' | 'desktop'): BetaHarness {
  const clock = new InstantClock(NOW)
  const logger = new TestLogger() as unknown as Logger
  const store = new MemoryFileStore()
  const channel = new BetaChannel(channelId)
  const llm = new BetaLlm()
  const audit = new BetaAudit()
  const state = createInitialState(NOW)
  const memory = new MemoryStore({ store, config, clock, logger })
  const engine = new PersonaEngine({
    config,
    logger,
    clock,
    random: { next: () => 0.1 },
    store,
    channel,
    llm,
    search: null,
    notifier: new BetaNotifier(),
    state,
    audit,
    memory,
    stickers: new BetaStickers(),
    persona: { name: '测试', systemPrompt: '你是测试人格。', examples: [], sourceDir: '' },
    saveState: async () => {},
  })
  return { engine, config, channel, llm, audit, store, clock }
}

function makeRunRecorder(): {
  calls: Array<{ script: DesktopScriptName; args: string[] }>
  runner: (script: DesktopScriptName, args: string[]) => Promise<DesktopScriptResult>
} {
  const calls: Array<{ script: DesktopScriptName; args: string[] }> = []
  return {
    calls,
    runner: async (script, args) => {
      calls.push({ script, args })
      return { code: 0, stdout: '{"ok":true}', stderr: '' }
    },
  }
}

describe('v3.0.0-beta.1 安全闸门：默认值与旧配置迁移', () => {
  it('defaultConfig().betaSafeMode 为 true（全新安装默认禁止真实发送）', () => {
    expect(defaultConfig().betaSafeMode).toBe(true)
  })

  it('旧配置缺少 betaSafeMode：迁移补 true（绝不默默提升旧用户权限）', () => {
    const legacy = { schedule: { onlineStart: '09:00', onlineEnd: '22:00' }, market: { indexUrl: '' } }
    const result = migrateConfig(legacy)
    expect(result.config.betaSafeMode).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.notes.join('\n')).toContain('betaSafeMode')
  })

  it('完整默认配置再次迁移不产生 betaSafeMode 相关改动', () => {
    const result = migrateConfig(defaultConfig())
    expect(result.config.betaSafeMode).toBe(true)
    expect(result.changed).toBe(false)
    expect(result.notes.join('\n')).not.toContain('betaSafeMode')
  })

  it('显式 betaSafeMode=false 在迁移中原样保留（高级用户知情关闭）', () => {
    const result = migrateConfig({ betaSafeMode: false, market: { indexUrl: '' } })
    expect(result.config.betaSafeMode).toBe(false)
  })
})

describe('v3.0.0-beta.1 安全闸门：引擎层', () => {
  it('mock 通道不受影响：默认 betaSafeMode 下仍可生成并发送', async () => {
    const harness = makeEngineHarness(baseConfig(), 'mock')
    await harness.engine.start()
    await harness.engine.handleInbound(inbound())
    expect(harness.llm.calls.length).toBe(1)
    expect(harness.channel.sent.length).toBeGreaterThanOrEqual(1)
  })

  it('真实通道：不调用云端 LLM/搜索/写记忆，发送 0 次，审计 reason beta-safe-mode', async () => {
    const harness = makeEngineHarness(baseConfig(), 'desktop')
    await harness.engine.start()
    expect(harness.channel.startCalls).toBe(1)

    await harness.engine.handleInbound(inbound())

    expect(harness.llm.calls).toHaveLength(0)
    expect(harness.channel.sent).toHaveLength(0)
    const skips = harness.audit.events.filter((event) => event.type === 'skip')
    expect(skips.some((event) => event.reason === 'beta-safe-mode')).toBe(true)
    expect(String(skips[0]?.detail ?? '')).toContain('预览版默认禁用真实发送')
    const status = await harness.engine.status()
    expect(status.betaSafeMode).toBe(true)
    // 早退发生在 validated 之后，状态机进入 cancelled（不是 confirmed）。
    expect(harness.engine.sendState).toBe('cancelled')
  })

  it('真实通道：sendTest 返回 not-sent 且 error 提示预览版', async () => {
    const harness = makeEngineHarness(baseConfig(), 'desktop')
    await harness.engine.start()
    const result = await harness.engine.sendTest('wxid_zhangsan', '测试消息')
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe('not-sent')
    expect(String(result.error ?? '')).toContain('预览版默认禁用真实发送')
    expect(harness.channel.sent).toHaveLength(0)
  })
})

describe('v3.0.0-beta.1 安全闸门：桌面通道层', () => {
  it('betaSafeMode=true：send 首行拒绝，runScript 完全未被调用', async () => {
    const recorder = makeRunRecorder()
    const config = baseConfig()
    expect(config.betaSafeMode).toBe(true)
    const channel = new DesktopChannel({
      config,
      deps: makeDeps(),
      runScript: recorder.runner,
    })
    const result = await channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe('not-sent')
    expect(String(result.error ?? '')).toContain('预览版默认禁用真实发送')
    expect(recorder.calls).toHaveLength(0)
  })

  it('betaSafeMode=true：发送脚本参数包含 -NoRealSend（脚本层第四道拒绝）', () => {
    const config = baseConfig()
    const channel = new DesktopChannel({ config, deps: makeDeps(), runScript: async () => ({ code: 0, stdout: '', stderr: '' }) })
    expect(channel.betaSafeScriptArgs()).toEqual(['-NoRealSend'])
  })

  it('betaSafeMode=false：不再追加 -NoRealSend（显式关闭闸门后才允许真实发送）', () => {
    const config = baseConfig((cfg) => {
      cfg.betaSafeMode = false
    })
    const channel = new DesktopChannel({ config, deps: makeDeps(), runScript: async () => ({ code: 0, stdout: '', stderr: '' }) })
    expect(channel.betaSafeScriptArgs()).toEqual([])
  })
})

describe('v3.0.0-beta.1 安全闸门：API 层', () => {
  const AUTH_HEADERS = { 'x-dsh-wechat-persona': '1' }

  interface ApiHarness {
    api: ReturnType<typeof createPersonaApi>
    config: WechatPersonaConfig
    engine: FakeApiEngine
  }

  interface FakeApiEngine extends PersonaEngineLike {
    sent: Array<{ contactId: string; text: string }>
    approved: string[]
  }

  function makeApiHarness(betaSafeMode: boolean): ApiHarness {
    const config = testConfigSafe(betaSafeMode)
    const engine = {
      sent: [] as Array<{ contactId: string; text: string }>,
      approved: [] as string[],
      async status() {
        return { betaSafeMode: config.betaSafeMode, paused: false, channelId: 'mock' }
      },
      async pause() {},
      async resume() {},
      async sendTest(contactId: string, text: string) {
        engine.sent.push({ contactId, text })
        return { ok: true, delivery: 'sent' as const }
      },
      async handleInbound() {},
      async clearMemory() {},
      async clearAudit() {},
      async listDrafts() {
        return []
      },
      async approveDraft(id: string) {
        engine.approved.push(id)
        return { ok: true, delivery: 'sent' as const }
      },
      async rejectDraft(id: string) {
        engine.approved.push(id)
        return { ok: true }
      },
    }
    const deps = {
      version: 'test-beta',
      getConfig: () => config,
      saveConfig: async () => ({ ok: true }),
      persist: () => ({ editable: true, lastSavedAt: NOW }),
      getEngine: () => engine as unknown as PersonaEngineLike,
      personas: {
        list: () => [],
        get: () => null,
        install: async () => ({}),
        importJson: async () => ({}),
        uninstall: async () => true,
        exportPack: async () => null,
        resolveDir: () => '',
      },
      market: { fetchIndex: async () => ({ source: 'builtin', entries: [] }), install: async () => ({}) },
      stickers: { list: async () => [], reload: async () => {} },
      memory: { clear: async () => {} },
      audit: { recent: async () => [], summary: async () => ({}), clear: async () => {} },
      state: () => createInitialState(NOW),
      clock: { now: () => NOW, sleep: async () => {} },
      logger: new TestLogger(),
      asset: () => '',
      dataDir: () => 'C:/tmp/beta-safe-test',
    } as unknown as PersonaApiDeps
    return { api: createPersonaApi(deps), config, engine: engine as unknown as FakeApiEngine }
  }

  it('betaSafeMode=true：/test/send 409 且引擎 sendTest 未被调用', async () => {
    const harness = makeApiHarness(true)
    const response = await harness.api.handle('POST', '/test/send', new URLSearchParams(), { contactId: 'wxid_zhangsan', text: 'hi' }, AUTH_HEADERS, '127.0.0.1')
    expect(response.status).toBe(409)
    expect(String((response.json as { error?: string }).error ?? '')).toContain('预览版')
    expect(harness.engine.sent).toHaveLength(0)
  })

  it('betaSafeMode=true：/drafts/approve 409 且引擎 approveDraft 未被调用', async () => {
    const harness = makeApiHarness(true)
    const response = await harness.api.handle('POST', '/drafts/approve', new URLSearchParams(), { id: 'draft-1' }, AUTH_HEADERS, '127.0.0.1')
    expect(response.status).toBe(409)
    expect(harness.engine.approved).toHaveLength(0)
  })

  it('betaSafeMode=true：/status 暴露 betaSafeMode=true', async () => {
    const harness = makeApiHarness(true)
    const response = await harness.api.handle('GET', '/status', new URLSearchParams(), undefined, AUTH_HEADERS, '127.0.0.1')
    expect(response.status).toBe(200)
    const body = response.json as { betaSafeMode?: boolean; security?: { betaSafeMode?: boolean } }
    expect(body.betaSafeMode).toBe(true)
    expect(body.security?.betaSafeMode).toBe(true)
  })

  it('betaSafeMode=false：/test/send 放行且引擎 sendTest 被调用（显式关闭后才允许）', async () => {
    const harness = makeApiHarness(false)
    const response = await harness.api.handle('POST', '/test/send', new URLSearchParams(), { contactId: 'wxid_zhangsan', text: 'hi' }, AUTH_HEADERS, '127.0.0.1')
    expect(response.status).toBe(200)
    expect(harness.engine.sent).toEqual([{ contactId: 'wxid_zhangsan', text: 'hi' }])
  })

  function testConfigSafe(betaSafeMode: boolean): WechatPersonaConfig {
    return makeConfig((cfg) => {
      cfg.whitelist = [...WHITELIST]
      cfg.betaSafeMode = betaSafeMode
    })
  }
})

describe('v3.0.0-beta.1 安全闸门：PS1 脚本层（静态检查，不执行脚本）', () => {
  const scriptPath = new URL('../../scripts/pwsh/wechat-uia.ps1', import.meta.url)

  it('脚本声明 -NoRealSend switch，且 send 动作在找窗口/键鼠之前硬阻断', () => {
    const buffer = readFileSync(scriptPath)
    // UTF-8 BOM（AGENTS.md 硬性要求）
    expect([buffer[0], buffer[1], buffer[2]]).toEqual([0xef, 0xbb, 0xbf])
    const text = buffer.toString('utf8')
    expect(text).toContain('[switch]$NoRealSend')
    expect(text).toContain("if ($NoRealSend -and $Action -eq 'send')")
    expect(text).toContain('-NoRealSend，脚本层硬阻断')
    // 用行号比较位置（字符索引会被函数定义区干扰，不够稳）。
    const lines = text.split(/\r?\n/)
    const lineOf = (needle: string, from = 0): number => {
      for (let index = from; index < lines.length; index += 1) {
        if (lines[index]!.includes(needle)) return index + 1
      }
      return 0
    }
    const switchLine = lineOf('[switch]$NoRealSend')
    const gateLine = lineOf("if ($NoRealSend -and $Action -eq 'send')")
    expect(switchLine).toBeGreaterThan(0)
    expect(gateLine).toBeGreaterThan(switchLine)
    // 入口阻断必须位于后续「工作时段 / 键鼠空闲 / 找窗口 / 气泡校验」逻辑之前。
    for (const marker of ['可选的脚本级工作时段闸门', '键鼠空闲闸门', '当前不在 WXUIA_ACTIVE_HOURS', '用户正在使用电脑', '未找到微信窗口']) {
      const markerLine = lineOf(marker)
      expect(markerLine).toBeGreaterThan(gateLine)
    }
  })
})
