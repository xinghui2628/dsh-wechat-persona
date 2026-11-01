/**
 * Host HTTP API 纯逻辑层测试（src/server/api.ts）。
 *
 * 覆盖：
 * - 鉴权（回环地址 + x-dsh-wechat-persona 请求头）与路由归一化/404/405/503；
 * - 全部端点：health/status/config/personas/market/stickers/logs/test/pause 等；
 * - 配置校验（类型、枚举、时间格式、数值 clamp、默认值合并）；
 * - attachPersonaRoutes 的 HTTP 传输层：前缀路由、JSON body、413、二进制、500 兜底。
 *
 * 注意：
 * - 不启动真实外部网络；attach 测试只在 127.0.0.1:0 上起临时 node:http 服务器；
 * - 表情包上传使用包内临时目录（工作区内 mkdtemp），afterAll 统一清理；
 * - 不使用 TS 参数属性（沙箱 esbuild stub 只做类型擦除）。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FakeLogger, SeqRandom, testConfig } from '../core/fakes.ts'
import type { WechatPersonaConfig } from '../../src/config.ts'
import { createInitialState } from '../../src/core/state.ts'
import { StickerCatalog } from '../../src/core/stickers.ts'
import {
  API_PREFIX,
  MAX_API_BODY_BYTES,
  attachPersonaRoutes,
  createPersonaApi,
  normalizeOcrDiagnostics,
} from '../../src/server/api.ts'
import type {
  ApiResponse,
  PersonaApi,
  PersonaApiDeps,
  PersonaRoute,
  PersonaWebServerLike,
} from '../../src/server/api.ts'
import type {
  AuditEvent,
  AuditLogLike,
  AuditSummary,
  DraftDecisionResult,
  EngineStatus,
  InboundMessage,
  MemoryStoreLike,
  PersonaEngineLike,
  PersonaLibraryLike,
  PersonaMarketLike,
  PersonaPackV2,
  PersonaSummary,
  SendDraft,
  SendResult,
  StickerCatalogApi,
} from '../../src/types.ts'

/* ────────────────────────────── 共享固定数据 ────────────────────────────── */

const FIXED_NOW = new Date(2026, 9, 30, 20, 0, 0, 0).getTime()
const AUTH_HEADERS: Record<string, string> = { 'x-dsh-wechat-persona': '1' }
/** 合法 PNG 魔数 + 最小内容（只验证魔数与扩展名，不依赖真实可解码图像）。 */
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082',
  'hex',
)

let tmpRoot = ''
let packageStickerDir = ''
let secretPngPath = ''

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(process.cwd(), '.vitest-api-'))
  // 模拟插件包内 stickers/：package 来源 id 无前缀（happy/001.png）。
  packageStickerDir = join(tmpRoot, 'package', 'stickers')
  await mkdir(join(packageStickerDir, 'happy'), { recursive: true })
  await writeFile(join(packageStickerDir, 'happy', '001.png'), PNG_BYTES)
  // 用于验证 sticker-file 路径穿越防护：不在 stickers/<分类>/ 结构内。
  const secretDir = join(tmpRoot, 'secret')
  await mkdir(secretDir, { recursive: true })
  secretPngPath = join(secretDir, 'secret.png')
  await writeFile(secretPngPath, PNG_BYTES)
})

afterAll(async () => {
  if (tmpRoot !== '') await rm(tmpRoot, { recursive: true, force: true })
})

/* ────────────────────────────── 测试替身 ────────────────────────────── */

function toSummary(pack: PersonaPackV2, activeId: string): PersonaSummary {
  const source: PersonaSummary['source'] = pack.id === 'builtin-small' ? 'builtin' : 'local'
  return {
    id: pack.id,
    name: pack.name,
    avatar: pack.avatar,
    style: pack.style,
    description: pack.description,
    tags: [...pack.tags],
    author: pack.author,
    packVersion: pack.packVersion,
    source,
    active: pack.id === activeId,
  }
}

function makePack(id: string, name = id): PersonaPackV2 {
  return {
    version: 2,
    id,
    name,
    avatar: '',
    style: '',
    catchphrases: [],
    systemPrompt: `你是${name}`,
    examples: [],
    taboo: [],
    stickers: [],
    author: '测试',
    description: '',
    tags: [],
    packVersion: '1.0.0',
  }
}

function makeMarketEntry(id: string, installed = false): {
  id: string
  name: string
  description: string
  author: string
  avatar: string
  tags: string[]
  version: string
  downloads: number
  url: string
  installed: boolean
} {
  return {
    id,
    name: `市场人格 ${id}`,
    description: '',
    author: '测试',
    avatar: '',
    tags: [],
    version: '1.0.0',
    downloads: 0,
    url: `https://example.com/${id}.json`,
    installed,
  }
}

function makeAuditSummary(overrides: Partial<AuditSummary> = {}): AuditSummary {
  return {
    dayKey: '2026-10-30',
    llmCalls: 2,
    llmTokens: 120,
    cacheReadTokens: 0,
    searches: 0,
    sends: 1,
    drafts: 0,
    skips: { duplicate: 1 },
    lastEventAt: FIXED_NOW,
    ...overrides,
  }
}

function makeEngineStatus(overrides: Partial<EngineStatus> = {}): EngineStatus {
  const base = {
    personaName: '小号',
    channelId: 'mock',
    channelState: 'running',
    channelDetail: 'mock 通道',
    paused: false,
    breaker: {},
    budget: {},
    budgetPhase: 'ok',
    stats: {},
    today: makeAuditSummary(),
    contacts: 1,
    online: true,
    lowActivityDay: false,
    nextOnlineAt: null,
    startedAt: FIXED_NOW - 60_000,
    lastActivityAt: FIXED_NOW,
    safeMode: false,
    sendMode: 'auto',
    pendingDrafts: 0,
    sendState: 'received',
  }
  return { ...(base as unknown as EngineStatus), ...overrides }
}

function makeAuditEvent(kind: string): AuditEvent {
  return { type: kind, ts: FIXED_NOW } as unknown as AuditEvent
}

class FakeEngine implements PersonaEngineLike {
  paused = false
  pauseReason: string | undefined = undefined
  statusValue: EngineStatus = makeEngineStatus()
  statusError: Error | null = null
  sendResult: SendResult = { ok: true }
  readonly handled: InboundMessage[] = []
  readonly sent: Array<{ contactId: string; text: string }> = []
  readonly clearedContactIds: Array<string | undefined> = []
  auditCleared = 0
  /** Phase F：GET /diagnostics/ocr 的原始返回（引擎 duck-typing 方法）。 */
  ocrDiagnosticsResult: unknown = null
  ocrDiagnosticsError: Error | null = null

  async ocrDiagnostics(): Promise<unknown> {
    if (this.ocrDiagnosticsError !== null) throw this.ocrDiagnosticsError
    return this.ocrDiagnosticsResult
  }

  /** task-12：草稿队列与人工确认（/drafts 端点）。 */
  drafts: SendDraft[] = []
  draftDecision: DraftDecisionResult = { ok: true }
  draftDecisionError: Error | null = null
  readonly approveDraftCalls: string[] = []
  readonly rejectDraftCalls: string[] = []

  async listDrafts(): Promise<SendDraft[]> {
    return this.drafts
  }

  async approveDraft(id: string): Promise<DraftDecisionResult> {
    this.approveDraftCalls.push(id)
    if (this.draftDecisionError !== null) throw this.draftDecisionError
    return this.draftDecision
  }

  async rejectDraft(id: string): Promise<DraftDecisionResult> {
    this.rejectDraftCalls.push(id)
    if (this.draftDecisionError !== null) throw this.draftDecisionError
    return this.draftDecision
  }

  async status(): Promise<EngineStatus> {
    if (this.statusError !== null) throw this.statusError
    return this.statusValue
  }

  async pause(reason: string): Promise<void> {
    this.paused = true
    this.pauseReason = reason
  }

  async resume(): Promise<void> {
    this.paused = false
    this.pauseReason = undefined
  }

  async sendTest(contactId: string, text: string): Promise<SendResult> {
    this.sent.push({ contactId, text })
    return this.sendResult
  }

  async handleInbound(message: InboundMessage): Promise<void> {
    this.handled.push(message)
  }

  async clearMemory(contactId?: string): Promise<void> {
    this.clearedContactIds.push(contactId)
  }

  async clearAudit(): Promise<void> {
    this.auditCleared += 1
  }
}

class FakePersonas implements PersonaLibraryLike {
  readonly packs = new Map<string, PersonaPackV2>()
  readonly readonlyIds = new Set<string>()
  readonly installCalls: Array<{ id: string; source: 'market' | 'local' }> = []
  readonly importCalls: unknown[] = []
  failList: Error | null = null

  async list(activeId: string): Promise<PersonaSummary[]> {
    if (this.failList !== null) throw this.failList
    return [...this.packs.values()].map((pack) => toSummary(pack, activeId))
  }

  async get(id: string): Promise<PersonaPackV2 | null> {
    return this.packs.get(id) ?? null
  }

  async install(pack: PersonaPackV2, source: 'market' | 'local'): Promise<PersonaSummary> {
    this.packs.set(pack.id, pack)
    this.installCalls.push({ id: pack.id, source })
    return toSummary(pack, '')
  }

  async importJson(input: unknown): Promise<PersonaSummary> {
    this.importCalls.push(input)
    const pack = makePack('imported-st', '导入人格')
    this.packs.set(pack.id, pack)
    return toSummary(pack, '')
  }

  async uninstall(id: string): Promise<boolean> {
    if (this.readonlyIds.has(id)) return false
    return this.packs.delete(id)
  }

  async exportPack(id: string): Promise<PersonaPackV2 | null> {
    return this.packs.get(id) ?? null
  }
}

class FakeMarket implements PersonaMarketLike {
  entries: ReturnType<typeof makeMarketEntry>[] = []
  fetchError: Error | null = null
  installError: Error | null = null
  readonly installCalls: string[] = []

  async fetchIndex(): Promise<{ source: 'remote' | 'builtin'; entries: ReturnType<typeof makeMarketEntry>[] }> {
    if (this.fetchError !== null) throw this.fetchError
    return { source: 'remote', entries: [...this.entries] }
  }

  async install(id: string): Promise<{ persona: PersonaSummary; updated: boolean }> {
    if (this.installError !== null) throw this.installError
    this.installCalls.push(id)
    return { persona: toSummary(makePack(id, `市场人格 ${id}`), ''), updated: false }
  }
}

class FakeAudit implements AuditLogLike {
  events: AuditEvent[] = []
  summaryValue: AuditSummary = makeAuditSummary()
  readonly recentLimits: number[] = []

  async record(_event: AuditEvent): Promise<void> {
    return undefined
  }

  async recent(limit: number): Promise<AuditEvent[]> {
    this.recentLimits.push(limit)
    return this.events.slice(-limit)
  }

  async summary(): Promise<AuditSummary> {
    return this.summaryValue
  }

  async clear(): Promise<void> {
    this.events = []
  }
}

/** 只为让 deps 结构完整的最小 MemoryStoreLike 替身（API 层当前不直接调用 memory）。 */
function createMemoryStub(): MemoryStoreLike {
  const record = {
    version: 1,
    contactId: '',
    contactName: '',
    recent: [],
    summary: '',
    totalTurns: 0,
    recentStickerIds: [],
    updatedAt: FIXED_NOW,
  }
  return {
    get: async () => record,
    recent: async () => [],
    summaryOf: async () => '',
    append: async () => undefined,
    setSummary: async () => undefined,
    lastStickerIds: async () => [],
    rememberSticker: async () => undefined,
    shouldSummarize: async () => false,
    clear: async () => undefined,
    listContacts: async () => [],
    flush: async () => undefined,
  } as unknown as MemoryStoreLike
}

/* ────────────────────────────── 测试环境工厂 ────────────────────────────── */

interface EnvOptions {
  engine?: FakeEngine | null
  assets?: Record<string, string>
  persistError?: string
  /** 强制生效的 API 共享 token（模拟 config.apiToken 显式配置）。 */
  apiToken?: string
}

interface TestEnv {
  dir: string
  uploadRoot: string
  deps: PersonaApiDeps
  api: PersonaApi
  engine: FakeEngine | null
  personas: FakePersonas
  market: FakeMarket
  audit: FakeAudit
  catalog: StickerCatalog
  logger: FakeLogger
  config: WechatPersonaConfig
  savedConfigs: WechatPersonaConfig[]
  saveError: { message: string | null }
}

async function makeEnv(options: EnvOptions = {}): Promise<TestEnv> {
  const dir = await mkdtemp(join(tmpRoot, 'env-'))
  const uploadRoot = join(dir, 'stickers')
  const logger = new FakeLogger()
  const catalog = new StickerCatalog({
    dirs: [
      { dir: packageStickerDir, origin: 'package' },
      { dir: uploadRoot, origin: 'uploaded' },
    ],
    random: new SeqRandom([], 0.5),
    logger,
  })
  await catalog.reload()

  const assets = options.assets ?? {}
  const engine = options.engine === undefined ? new FakeEngine() : options.engine
  const personas = new FakePersonas()
  const market = new FakeMarket()
  const audit = new FakeAudit()
  const config = testConfig()
  const savedConfigs: WechatPersonaConfig[] = []
  const saveError: { message: string | null } = { message: null }

  const deps: PersonaApiDeps = {
    version: '0.2.0-test',
    getConfig: () => config,
    saveConfig: async (next: WechatPersonaConfig) => {
      if (saveError.message !== null) return { ok: false, error: saveError.message }
      savedConfigs.push(next)
      Object.assign(config, next)
      return { ok: true }
    },
    persist: () => {
      if (options.persistError !== undefined) throw new Error(options.persistError)
      return { editable: true, lastSavedAt: FIXED_NOW - 5000 }
    },
    getEngine: () => engine,
    personas,
    market,
    stickers: catalog,
    memory: createMemoryStub(),
    audit,
    state: () => createInitialState(FIXED_NOW),
    clock: { now: () => FIXED_NOW, sleep: async () => undefined },
    logger,
    asset: async (rel: string) => assets[rel] ?? null,
    dataDir: () => dir,
    apiToken: () => options.apiToken ?? '',
  }
  const api = createPersonaApi(deps)
  return {
    dir,
    uploadRoot,
    deps,
    api,
    engine,
    personas,
    market,
    audit,
    catalog,
    logger,
    config,
    savedConfigs,
    saveError,
  }
}

/* ────────────────────────────── 调用与断言小工具 ────────────────────────────── */

function call(
  env: TestEnv,
  method: string,
  path: string,
  body?: unknown,
  query = '',
  headers: Record<string, string | string[] | undefined> = AUTH_HEADERS,
  remoteAddress?: string,
): Promise<ApiResponse> {
  return env.api.handle(method, path, new URLSearchParams(query), body, headers, remoteAddress)
}

function expectOk(response: ApiResponse, expectedStatus = 200): Record<string, unknown> {
  expect(response.status).toBe(expectedStatus)
  expect(response.json).toBeDefined()
  const json = response.json as Record<string, unknown>
  expect(json.ok).toBe(true)
  return json
}

function expectFail(response: ApiResponse, expectedStatus: number, pattern?: RegExp): Record<string, unknown> {
  expect(response.status).toBe(expectedStatus)
  const json = (response.json ?? {}) as Record<string, unknown>
  expect(json.ok).toBe(false)
  const error = json.error
  expect(typeof error).toBe('string')
  if (pattern) expect(error as string).toMatch(pattern)
  return json
}

/** 覆盖 deps.stickers，模拟 fileOf 返回任意文件（用于路径穿越/ENOENT 测试）。 */
function overrideStickerFile(env: TestEnv, file: string | null, id = 'uploaded:happy/fake.png'): void {
  const base = env.catalog
  const fake: StickerCatalogApi = {
    categories: () => base.categories(),
    count: () => base.count(),
    pick: () => null,
    pickAny: () => null,
    reload: async () => undefined,
    list: () => [
      { id, category: 'happy', name: 'happy/fake.png', origin: 'uploaded', url: '' },
    ],
    fileOf: () => file,
  }
  env.deps.stickers = fake
}

/* ══════════════════════════════ 测试 ══════════════════════════════ */

describe('Host HTTP API：鉴权与路由', () => {
  it('缺少鉴权请求头时返回 403', async () => {
    const env = await makeEnv()
    const response = await call(env, 'GET', '/health', undefined, '', {})
    expectFail(response, 403, /x-dsh-wechat-persona/)
  })

  it('鉴权请求头值不是 1 时返回 403', async () => {
    const env = await makeEnv()
    const response = await call(env, 'GET', '/health', undefined, '', { 'x-dsh-wechat-persona': '0' })
    expectFail(response, 403, /x-dsh-wechat-persona/)
  })

  it('非回环来源即使带鉴权头也拒绝', async () => {
    const env = await makeEnv()
    const response = await call(env, 'GET', '/health', undefined, '', AUTH_HEADERS, '192.168.1.9')
    expectFail(response, 403, /回环/)
  })

  it('接受回环 IPv6 映射地址', async () => {
    const env = await makeEnv()
    const response = await call(env, 'GET', '/health', undefined, '', AUTH_HEADERS, '::ffff:127.0.0.1')
    expectOk(response)
  })

  it('支持数组形式的请求头值', async () => {
    const env = await makeEnv()
    const response = await call(env, 'GET', '/health', undefined, '', {
      'x-dsh-wechat-persona': ['1'],
    })
    expectOk(response)
  })

  it('兼容完整前缀、裸路径与末尾斜杠', async () => {
    const env = await makeEnv()
    for (const path of [
      '/dsh-wechat-persona/api/health',
      '/health',
      '/dsh-wechat-persona/api/health/',
      '/dsh-wechat-persona/api/health?x=1',
    ]) {
      const response = await call(env, 'GET', path)
      expectOk(response)
    }
  })

  it('未知接口返回 404', async () => {
    const env = await makeEnv()
    const response = await call(env, 'GET', '/nope')
    expectFail(response, 404, /接口不存在/)
  })

  it('方法不允许时返回 405 与 Allow 头', async () => {
    const env = await makeEnv()
    const response = await call(env, 'POST', '/health')
    expectFail(response, 405, /方法不允许/)
    expect(response.headers?.Allow).toBe('GET')
  })

  it('dispose 之后所有请求返回 503', async () => {
    const env = await makeEnv()
    env.api.dispose()
    const response = await call(env, 'GET', '/health')
    expectFail(response, 503, /已卸载/)
  })
})

describe('Host HTTP API：鉴权加固（token / Host / Origin / 限速）', () => {
  const TOKEN = 'test-token-0123456789abcdef'
  const tokenHeaders = (token: string = TOKEN): Record<string, string> => ({
    ...AUTH_HEADERS,
    authorization: `Bearer ${token}`,
  })

  it('配置 apiToken 后缺少 Authorization 返回 401', async () => {
    const env = await makeEnv({ apiToken: TOKEN })
    const response = await call(env, 'GET', '/health')
    expectFail(response, 401, /token/)
  })

  it('配置 apiToken 后错误 token 返回 401', async () => {
    const env = await makeEnv({ apiToken: TOKEN })
    const response = await call(env, 'GET', '/health', undefined, '', tokenHeaders('wrong-token'))
    expectFail(response, 401, /token/)
  })

  it('配置 apiToken 后正确 Bearer token 放行', async () => {
    const env = await makeEnv({ apiToken: TOKEN })
    expectOk(await call(env, 'GET', '/health', undefined, '', tokenHeaders()))
  })

  it('支持 x-dsh-persona-token 备选请求头', async () => {
    const env = await makeEnv({ apiToken: TOKEN })
    expectOk(
      await call(env, 'GET', '/health', undefined, '', { ...AUTH_HEADERS, 'x-dsh-persona-token': TOKEN }),
    )
  })

  it('未配置 token 时按兼容模式放行，并只告警一次', async () => {
    const env = await makeEnv()
    expectOk(await call(env, 'GET', '/health'))
    expectOk(await call(env, 'GET', '/health'))
    expect(env.logger.warnings().filter((message) => message.includes('共享 token'))).toHaveLength(1)
  })

  it('Host 不是回环地址时拒绝（防 DNS rebinding）', async () => {
    const env = await makeEnv()
    const response = await call(env, 'GET', '/health', undefined, '', {
      ...AUTH_HEADERS,
      host: 'evil.example.com:57124',
    })
    expectFail(response, 403, /Host/)
  })

  it('Host 为回环地址时放行', async () => {
    const env = await makeEnv()
    for (const host of ['127.0.0.1:57124', 'localhost:57124', '[::1]:57124']) {
      expectOk(await call(env, 'GET', '/health', undefined, '', { ...AUTH_HEADERS, host }))
    }
  })

  it('Origin 不是回环来源时拒绝（防 CSRF）', async () => {
    const env = await makeEnv()
    for (const origin of ['http://evil.example.com', 'null', 'https://evil.example.com:443']) {
      expectFail(
        await call(env, 'GET', '/health', undefined, '', { ...AUTH_HEADERS, origin }),
        403,
        /Origin/,
      )
    }
  })

  it('Origin 为回环来源时放行', async () => {
    const env = await makeEnv()
    expectOk(
      await call(env, 'GET', '/health', undefined, '', {
        ...AUTH_HEADERS,
        origin: 'http://127.0.0.1:57124',
      }),
    )
  })

  it('Sec-Fetch-Site: cross-site 时拒绝', async () => {
    const env = await makeEnv()
    const response = await call(env, 'GET', '/health', undefined, '', {
      ...AUTH_HEADERS,
      'sec-fetch-site': 'cross-site',
    })
    expectFail(response, 403, /跨站/)
  })

  it('进程内限速：超过阈值后返回 429', async () => {
    const env = await makeEnv()
    const statuses: number[] = []
    for (let index = 0; index < 241; index += 1) {
      statuses.push((await call(env, 'GET', '/health')).status)
    }
    expect(statuses.slice(0, 240).every((status) => status === 200)).toBe(true)
    expect(statuses[240]).toBe(429)
  })

  it('GET /config 不回显 token 明文，POST /config 空 token 保持原值', async () => {
    const env = await makeEnv({ apiToken: TOKEN })
    env.config.apiToken = TOKEN
    const configJson = expectOk(await call(env, 'GET', '/config', undefined, '', tokenHeaders()))
    expect((configJson.config as WechatPersonaConfig).apiToken).toBe('')
    expect(configJson.apiTokenConfigured).toBe(true)
    const input = structuredClone(env.config)
    input.apiToken = ''
    expectOk(await call(env, 'POST', '/config', { config: input }, '', tokenHeaders()), 202)
    expect(env.savedConfigs[0]!.apiToken).toBe(TOKEN)
  })
})

describe('Host HTTP API：健康检查与运行状态', () => {
  it('GET /health 返回版本、进程号与运行时长', async () => {
    const env = await makeEnv()
    const json = expectOk(await call(env, 'GET', '/health'))
    expect(json.version).toBe('0.2.0-test')
    expect(json.pid).toBe(process.pid)
    expect(typeof json.uptime).toBe('number')
  })

  it('GET /status 返回引擎状态、通道与配置摘要', async () => {
    const env = await makeEnv()
    const json = expectOk(await call(env, 'GET', '/status'))
    const status = json.status as EngineStatus
    expect(status.personaName).toBe('小号')
    expect(json.channel).toMatchObject({ id: 'mock', state: 'running' })
    expect(json.configSummary).toMatchObject({ whitelistCount: 1, online: true, activeChannel: 'mock' })
    // task-12 / 13.4：发送模式与草稿队列状态对外可见
    expect(json.sendMode).toBe('auto')
    expect(json.pendingDrafts).toBe(0)
    expect(json.sendState).toBe('received')
  })

  it('GET /status 暴露 safeMode（Phase F）', async () => {
    const env = await makeEnv()
    const disabled = expectOk(await call(env, 'GET', '/status'))
    expect(disabled.safeMode).toBe(false)
    env.config.safeMode = true
    const enabled = expectOk(await call(env, 'GET', '/status'))
    expect(enabled.safeMode).toBe(true)
  })

  it('引擎状态读取失败时降级为 status=null 并记录 warn', async () => {
    const env = await makeEnv()
    env.engine!.statusError = new Error('状态读取崩溃')
    const json = expectOk(await call(env, 'GET', '/status'))
    expect(json.status).toBeNull()
    expect(env.logger.warnings().some((message) => message.includes('读取引擎状态失败'))).toBe(true)
  })

  it('没有引擎时 /status 报告引擎尚未启动', async () => {
    const env = await makeEnv({ engine: null })
    const json = expectOk(await call(env, 'GET', '/status'))
    expect(json.status).toBeNull()
    expect(json.channel).toMatchObject({ state: 'starting', detail: '引擎尚未启动' })
  })
})

describe('Host HTTP API：配置读写', () => {
  it('GET /config 返回当前配置与持久化信息', async () => {
    const env = await makeEnv()
    const json = expectOk(await call(env, 'GET', '/config'))
    const config = json.config as WechatPersonaConfig
    expect(config.reply.personaName).toBe('小号')
    expect(json.persist).toMatchObject({ editable: true })
  })

  it('GET /config 在 persist 抛错时降级', async () => {
    const env = await makeEnv({ persistError: '配置只读' })
    const json = expectOk(await call(env, 'GET', '/config'))
    expect(json.persist).toMatchObject({ editable: false })
    expect((json.persist as { reason?: string }).reason).toContain('配置只读')
  })

  it('POST /config 保存合法配置并返回 202', async () => {
    const env = await makeEnv()
    const response = await call(env, 'POST', '/config', { config: env.config })
    const json = expectOk(response, 202)
    expect(json.accepted).toBe(true)
    expect(env.savedConfigs).toHaveLength(1)
  })

  it('POST /config 对超出范围的数值做 clamp', async () => {
    const env = await makeEnv()
    const input = structuredClone(env.config)
    input.reply.maxChars = 99999
    input.reply.maxTokens = 0
    input.memory.recentKeep = 9999
    expectOk(await call(env, 'POST', '/config', { config: input }), 202)
    const saved = env.savedConfigs[0]!
    expect(saved.reply.maxChars).toBe(2000)
    expect(saved.reply.maxTokens).toBe(1)
    expect(saved.memory.recentKeep).toBe(500)
  })

  it('POST /config 补齐缺失字段的默认值并丢弃未知字段', async () => {
    const env = await makeEnv()
    const input = { enabled: true, reply: { maxChars: 100 }, __unknown: 'x' }
    expectOk(await call(env, 'POST', '/config', { config: input }), 202)
    const saved = env.savedConfigs[0]!
    expect(saved.reply.maxChars).toBe(100)
    expect(saved.persona.activeId).toBe('builtin-small')
    expect(saved.reply.personaName).toBe('小号')
    expect('__unknown' in (saved as unknown as Record<string, unknown>)).toBe(false)
  })

  it('POST /config 在 typingMinMs 大于 typingMaxMs 时交换', async () => {
    const env = await makeEnv()
    const input = structuredClone(env.config)
    input.reply.typingMinMs = 5000
    input.reply.typingMaxMs = 800
    expectOk(await call(env, 'POST', '/config', { config: input }), 202)
    const saved = env.savedConfigs[0]!
    expect(saved.reply.typingMinMs).toBe(800)
    expect(saved.reply.typingMaxMs).toBe(5000)
  })

  it('POST /config 拒绝非法枚举并给出中文错误', async () => {
    const env = await makeEnv()
    const input = structuredClone(env.config) as unknown as Record<string, unknown>
    input.activeChannel = 'wechat'
    const json = expectFail(await call(env, 'POST', '/config', { config: input }), 400, /配置校验失败/)
    expect(json.detail).toContain('activeChannel')
    expect(env.savedConfigs).toHaveLength(0)
  })

  it('POST /config 拒绝非法时间格式与空 id 白名单', async () => {
    const env = await makeEnv()
    const input = structuredClone(env.config)
    input.schedule.onlineStart = '25:00'
    expectFail(await call(env, 'POST', '/config', { config: input }), 400, /配置校验失败/)
    const input2 = structuredClone(env.config) as unknown as Record<string, unknown>
    input2.whitelist = [{ name: '没有 id' }]
    expectFail(await call(env, 'POST', '/config', { config: input2 }), 400, /配置校验失败/)
  })

  it('POST /config 缺少 config 字段时返回 400', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'POST', '/config', {}), 400, /缺少 config/)
  })

  it('POST /config 请求体不是对象时返回 400', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'POST', '/config', 'not-object'), 400, /JSON 对象/)
  })

  it('POST /config 保存失败时返回 500', async () => {
    const env = await makeEnv()
    env.saveError.message = '磁盘只读'
    const json = expectFail(await call(env, 'POST', '/config', { config: env.config }), 500, /保存配置失败/)
    expect(json.error as string).toContain('磁盘只读')
  })
})

describe('Host HTTP API：人格库', () => {
  async function envWithPersonas(): Promise<TestEnv> {
    const env = await makeEnv()
    await env.personas.install(makePack('builtin-small', '内置小'), 'local')
    await env.personas.install(makePack('custom', '自定义'), 'local')
    env.personas.readonlyIds.add('builtin-small')
    return env
  }

  it('GET /personas 返回列表与当前激活 id', async () => {
    const env = await envWithPersonas()
    const json = expectOk(await call(env, 'GET', '/personas'))
    expect(json.activeId).toBe('builtin-small')
    const personas = json.personas as PersonaSummary[]
    expect(personas).toHaveLength(2)
    expect(personas.find((persona) => persona.id === 'builtin-small')?.active).toBe(true)
  })

  it('POST /personas/install 安装人格包并标记是否覆盖安装', async () => {
    const env = await envWithPersonas()
    const first = expectOk(await call(env, 'POST', '/personas/install', { pack: makePack('new-pack', '新人格') }))
    expect((first.persona as PersonaSummary).id).toBe('new-pack')
    expect(first.updated).toBe(false)
    const second = expectOk(await call(env, 'POST', '/personas/install', { pack: makePack('new-pack', '新人格') }))
    expect(second.updated).toBe(true)
    expect(env.personas.installCalls[0]?.source).toBe('local')
  })

  it('POST /personas/install 既无 pack 也无 url 时返回 400', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'POST', '/personas/install', {}), 400, /pack/)
  })

  it('POST /personas/install 的 url 分支拒绝非 http 协议', async () => {
    const env = await makeEnv()
    const json = expectFail(
      await call(env, 'POST', '/personas/install', { url: 'ftp://example.com/p.json' }),
      400,
      /http/,
    )
    expect(json.error as string).toContain('只支持 http/https')
  })

  it('POST /personas/import 导入外部 JSON', async () => {
    const env = await makeEnv()
    const json = expectOk(await call(env, 'POST', '/personas/import', { json: { id: 'st-card' } }))
    expect((json.persona as PersonaSummary).id).toBe('imported-st')
    expect(env.personas.importCalls).toHaveLength(1)
  })

  it('POST /personas/import 缺少 json 字段时返回 400', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'POST', '/personas/import', {}), 400, /json/)
  })

  it('POST /personas/activate 切换人格并保存配置', async () => {
    const env = await envWithPersonas()
    const json = expectOk(await call(env, 'POST', '/personas/activate', { id: 'custom' }), 202)
    expect(json.accepted).toBe(true)
    expect(env.config.persona.activeId).toBe('custom')
    expect(env.savedConfigs).toHaveLength(1)
  })

  it('POST /personas/activate 对不存在的人格返回 404', async () => {
    const env = await envWithPersonas()
    expectFail(await call(env, 'POST', '/personas/activate', { id: 'missing' }), 404, /人格不存在/)
    expect(env.savedConfigs).toHaveLength(0)
  })

  it('POST /personas/activate 传空串表示关闭人格', async () => {
    const env = await envWithPersonas()
    expectOk(await call(env, 'POST', '/personas/activate', { id: '' }), 202)
    expect(env.config.persona.activeId).toBe('')
  })

  it('GET /personas/export 导出人格包', async () => {
    const env = await envWithPersonas()
    const json = expectOk(await call(env, 'GET', '/personas/export', undefined, 'id=builtin-small'))
    expect((json.pack as PersonaPackV2).id).toBe('builtin-small')
  })

  it('GET /personas/export 缺少 id 返回 400', async () => {
    const env = await envWithPersonas()
    expectFail(await call(env, 'GET', '/personas/export'), 400, /id/)
  })

  it('DELETE 内置人格被拒绝', async () => {
    const env = await envWithPersonas()
    const response = await call(env, 'DELETE', '/personas/builtin-small')
    expectFail(response, 400, /只读/)
  })

  it('DELETE 已安装人格成功', async () => {
    const env = await envWithPersonas()
    expectOk(await call(env, 'DELETE', '/personas/custom'))
    expect(await env.personas.get('custom')).toBeNull()
  })

  it('DELETE 不存在的人格返回 404', async () => {
    const env = await envWithPersonas()
    expectFail(await call(env, 'DELETE', '/personas/missing'), 404, /人格不存在/)
  })

  it('GET /personas 在库读取失败时返回 500', async () => {
    const env = await envWithPersonas()
    env.personas.failList = new Error('目录不可读')
    expectFail(await call(env, 'GET', '/personas'), 500, /读取人格列表失败/)
  })
})

describe('Host HTTP API：人格包导入安全（校验 / 消毒 / dry-run）', () => {
  it('非法 JSON 字符串被拒绝且不回显内容', async () => {
    const env = await makeEnv()
    const json = expectFail(
      await call(env, 'POST', '/personas/import', { json: '{not-json' }),
      400,
      /人格包校验失败/,
    )
    expect(String(json.detail)).toContain('JSON')
    expect(env.personas.importCalls).toHaveLength(0)
  })

  it('超过 2MB 的 JSON 字符串被拒绝', async () => {
    const env = await makeEnv()
    const oversized = 'x'.repeat(2 * 1024 * 1024 + 1)
    expectFail(await call(env, 'POST', '/personas/import', { json: oversized }), 400, /上限/)
    expect(env.personas.importCalls).toHaveLength(0)
  })

  it('非对象 JSON 被拒绝', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'POST', '/personas/import', { json: [1, 2, 3] }), 400, /JSON 对象/)
  })

  it('拒绝 __proto__ 等危险键（防原型污染）', async () => {
    const env = await makeEnv()
    const json = '{"id":"safe-card","__proto__":{"polluted":true}}'
    const response = await call(env, 'POST', '/personas/import', { json })
    expectFail(response, 400, /非法键名|非法字段/)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    expect(env.personas.importCalls).toHaveLength(0)
  })

  it('拒绝路径穿越的表情包文件名', async () => {
    const env = await makeEnv()
    const payload = {
      id: 'safe-card',
      systemPrompt: '正常人格',
      stickers: [{ emotion: 'happy', name: '../../evil.png' }],
    }
    expectFail(await call(env, 'POST', '/personas/import', { json: payload }), 400, /非法字符/)
    expect(env.personas.importCalls).toHaveLength(0)
  })

  it('拒绝 avatar 中的可执行 URL（javascript:）', async () => {
    const env = await makeEnv()
    const payload = { id: 'safe-card', systemPrompt: '正常人格', avatar: 'javascript:alert(1)' }
    expectFail(await call(env, 'POST', '/personas/import', { json: payload }), 400, /URL/)
  })

  it('允许 http/https 与 data:image 头像', async () => {
    const env = await makeEnv()
    for (const avatar of ['https://example.com/a.png', 'data:image/png;base64,AAAA']) {
      expectOk(
        await call(env, 'POST', '/personas/import', {
          json: { id: 'safe-card', systemPrompt: '正常人格', avatar },
        }),
      )
    }
  })

  it('拒绝嵌套过深的结构（防 JSON 深度炸弹）', async () => {
    const env = await makeEnv()
    const nested = { id: 'safe-card', systemPrompt: '正常人格' } as Record<string, unknown>
    let cursor = nested
    for (let depth = 0; depth < 8; depth += 1) {
      const child: Record<string, unknown> = {}
      cursor.child = child
      cursor = child
    }
    expectFail(await call(env, 'POST', '/personas/import', { json: nested }), 400, /嵌套过深/)
  })

  it('拒绝超长字段', async () => {
    const env = await makeEnv()
    const payload = { id: 'safe-card', systemPrompt: 'x'.repeat(20_001) }
    expectFail(await call(env, 'POST', '/personas/import', { json: payload }), 400, /长度上限/)
  })

  it('缺少可识别字段时拒绝', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'POST', '/personas/import', { json: { evil: 'x' } }), 400, /可识别字段/)
  })

  it('未知顶层字段被丢弃，合法字段仍导入', async () => {
    const env = await makeEnv()
    expectOk(
      await call(env, 'POST', '/personas/import', {
        json: { id: 'safe-card', name: '安全卡', evil: 'x' },
      }),
    )
    const input = env.personas.importCalls[0] as Record<string, unknown>
    expect(input.id).toBe('safe-card')
    expect('evil' in input).toBe(false)
  })

  it('安装人格包同样经过校验：恶意样本被拒、未知字段被丢弃', async () => {
    const env = await makeEnv()
    const bad = { ...makePack('bad-pack', '坏人格'), stickers: [{ emotion: 'happy', name: '../evil.png' }] }
    expectFail(await call(env, 'POST', '/personas/install', { pack: bad }), 400, /非法字符/)
    expect(env.personas.installCalls).toHaveLength(0)
    const good = { ...makePack('good-pack', '好人格'), evil: 'x' }
    expectOk(await call(env, 'POST', '/personas/install', { pack: good }))
    expect('evil' in (env.personas.packs.get('good-pack') as unknown as Record<string, unknown>)).toBe(false)
  })

  it('人格 id 含路径穿越时拒绝激活/导出/删除', async () => {
    const env = await makeEnv()
    const evilId = '..%2F..%2Fetc%2Fpasswd'
    expectFail(await call(env, 'POST', '/personas/activate', { id: evilId }), 400, /非法字符/)
    expectFail(await call(env, 'GET', '/personas/export', undefined, `id=${evilId}`), 400, /非法字符/)
    expectFail(await call(env, 'DELETE', `/personas/${evilId}`), 400, /非法字符/)
  })

  it('人格市场 id 含路径穿越时拒绝', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'POST', '/market/install', { id: '../../etc/passwd' }), 400, /非法字符/)
    expect(env.market.installCalls).toHaveLength(0)
  })
})

describe('Host HTTP API：人格市场', () => {
  it('GET /market 返回市场条目并补 installed 标记', async () => {
    const env = await makeEnv()
    await env.personas.install(makePack('market:a'), 'local')
    env.market.entries = [makeMarketEntry('market:a'), makeMarketEntry('market:b')]
    const json = expectOk(await call(env, 'GET', '/market'))
    expect(json.source).toBe('remote')
    const entries = json.entries as Array<{ id: string; installed: boolean }>
    expect(entries.find((entry) => entry.id === 'market:a')?.installed).toBe(true)
    expect(entries.find((entry) => entry.id === 'market:b')?.installed).toBe(false)
  })

  it('GET /market 拉取失败时降级为内置空列表并给出 warning', async () => {
    const env = await makeEnv()
    env.market.fetchError = new Error('网络不可用')
    const json = expectOk(await call(env, 'GET', '/market'))
    expect(json.source).toBe('builtin')
    expect(json.entries).toEqual([])
    expect(json.warning as string).toContain('人格市场不可用')
  })

  it('POST /market/install 安装市场人格', async () => {
    const env = await makeEnv()
    const json = expectOk(await call(env, 'POST', '/market/install', { id: 'market:cool' }))
    expect((json.persona as PersonaSummary).id).toBe('market:cool')
    expect(env.market.installCalls).toEqual(['market:cool'])
  })

  it('POST /market/install 缺少 id 返回 400', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'POST', '/market/install', {}), 400, /id/)
  })
})

describe('Host HTTP API：表情包', () => {
  it('GET /stickers 列出包内表情并补预览地址', async () => {
    const env = await makeEnv()
    const json = expectOk(await call(env, 'GET', '/stickers'))
    const items = json.items as Array<{ id: string; url: string; origin: string }>
    const item = items.find((entry) => entry.id === 'happy/001.png')
    expect(item).toBeDefined()
    expect(item!.origin).toBe('package')
    expect(item!.url).toContain('sticker-file?id=')
    expect(item!.url).toContain(API_PREFIX.replace(/^\//, ''))
  })

  it('GET /sticker-file 返回二进制图片', async () => {
    const env = await makeEnv()
    const response = await call(env, 'GET', '/sticker-file', undefined, 'id=happy%2F001.png')
    expect(response.status).toBe(200)
    expect(response.binary?.contentType).toBe('image/png')
    expect(response.binary?.data.equals(PNG_BYTES)).toBe(true)
    expect(response.headers?.['x-content-type-options']).toBe('nosniff')
  })

  it('GET /sticker-file 缺少 id 返回 400', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'GET', '/sticker-file'), 400, /id/)
  })

  it('GET /sticker-file 找不到文件返回 404', async () => {
    const env = await makeEnv()
    overrideStickerFile(env, join(packageStickerDir, 'happy', 'missing.png'))
    expectFail(
      await call(env, 'GET', '/sticker-file', undefined, 'id=uploaded%3Ahappy%2Ffake.png'),
      404,
      /不存在/,
    )
  })

  it('GET /sticker-file 拒绝 stickers 结构之外的文件（路径穿越防护）', async () => {
    const env = await makeEnv()
    overrideStickerFile(env, secretPngPath)
    expectFail(
      await call(env, 'GET', '/sticker-file', undefined, 'id=uploaded%3Ahappy%2Ffake.png'),
      403,
      /不允许访问/,
    )
  })

  it('POST /stickers/upload 保存图片并返回可访问的条目', async () => {
    const env = await makeEnv()
    const json = expectOk(
      await call(env, 'POST', '/stickers/upload', {
        emotion: 'happy',
        filename: 'upload-test.png',
        dataBase64: PNG_BYTES.toString('base64'),
      }),
    )
    const item = json.item as { id: string; category: string; origin: string; url: string }
    expect(item.id).toBe('uploaded:happy/upload-test.png')
    expect(item.category).toBe('happy')
    expect(item.origin).toBe('uploaded')
    expect(item.url).toContain('sticker-file?id=')
    // 上传后目录已重载，可以直接通过预览接口读取。
    const fileResponse = await call(
      env,
      'GET',
      '/sticker-file',
      undefined,
      `id=${encodeURIComponent(item.id)}`,
    )
    expect(fileResponse.status).toBe(200)
    expect(fileResponse.binary?.data.equals(PNG_BYTES)).toBe(true)
  })

  it('POST /stickers/upload 支持 data URL 前缀', async () => {
    const env = await makeEnv()
    const json = expectOk(
      await call(env, 'POST', '/stickers/upload', {
        emotion: 'shy',
        filename: 'data-url.png',
        dataBase64: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
      }),
    )
    expect((json.item as { id: string }).id).toBe('uploaded:shy/data-url.png')
  })

  it('POST /stickers/upload 同名文件自动改名而不覆盖', async () => {
    const env = await makeEnv()
    const body = {
      emotion: 'happy',
      filename: 'same.png',
      dataBase64: PNG_BYTES.toString('base64'),
    }
    const first = expectOk(await call(env, 'POST', '/stickers/upload', body))
    const second = expectOk(await call(env, 'POST', '/stickers/upload', body))
    const firstId = (first.item as { id: string }).id
    const secondId = (second.item as { id: string }).id
    expect(secondId).not.toBe(firstId)
    expect(secondId.startsWith('uploaded:happy/same-')).toBe(true)
  })

  it('POST /stickers/upload 拒绝非法 emotion', async () => {
    const env = await makeEnv()
    expectFail(
      await call(env, 'POST', '/stickers/upload', {
        emotion: 'angry',
        filename: 'x.png',
        dataBase64: PNG_BYTES.toString('base64'),
      }),
      400,
      /emotion/,
    )
  })

  it('POST /stickers/upload 拒绝扩展名与内容不一致', async () => {
    const env = await makeEnv()
    expectFail(
      await call(env, 'POST', '/stickers/upload', {
        emotion: 'happy',
        filename: 'fake.gif',
        dataBase64: PNG_BYTES.toString('base64'),
      }),
      400,
      /不一致/,
    )
  })

  it('POST /stickers/upload 拒绝非图片内容', async () => {
    const env = await makeEnv()
    expectFail(
      await call(env, 'POST', '/stickers/upload', {
        emotion: 'happy',
        filename: 'fake.png',
        dataBase64: Buffer.from('hello world').toString('base64'),
      }),
      400,
      /不是有效的/,
    )
  })

  it('POST /stickers/upload 拒绝超过 2MB 的图片', async () => {
    const env = await makeEnv()
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x89)
    expectFail(
      await call(env, 'POST', '/stickers/upload', {
        emotion: 'happy',
        filename: 'big.png',
        dataBase64: big.toString('base64'),
      }),
      400,
      /2MB/,
    )
  })

  it('DELETE 包内表情被拒绝（只读）', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'DELETE', '/stickers', { id: 'happy/001.png' }), 400, /只读/)
  })

  it('DELETE 上传的表情成功并移除文件', async () => {
    const env = await makeEnv()
    const uploaded = expectOk(
      await call(env, 'POST', '/stickers/upload', {
        emotion: 'happy',
        filename: 'to-delete.png',
        dataBase64: PNG_BYTES.toString('base64'),
      }),
    )
    const id = (uploaded.item as { id: string }).id
    expect(env.catalog.fileOf(id)).not.toBeNull()
    expectOk(await call(env, 'DELETE', '/stickers', { id }))
    expect(env.catalog.fileOf(id)).toBeNull()
  })

  it('DELETE 不存在的表情返回 404', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'DELETE', '/stickers', { id: 'uploaded:happy/none.png' }), 404, /不存在/)
  })

  it('DELETE 缺少 id 返回 400', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'DELETE', '/stickers', {}), 400, /id/)
  })
})

describe('Host HTTP API：日志与帮助', () => {
  it('GET /logs 使用配置里的默认条数', async () => {
    const env = await makeEnv()
    env.audit.events = [makeAuditEvent('send'), makeAuditEvent('draft'), makeAuditEvent('skip')]
    const json = expectOk(await call(env, 'GET', '/logs'))
    expect(json.events).toHaveLength(3)
    expect(env.audit.recentLimits).toEqual([50])
    expect(json.summary).toMatchObject({ sends: 1 })
  })

  it('GET /logs?limit 透传并截断结果', async () => {
    const env = await makeEnv()
    env.audit.events = [makeAuditEvent('a'), makeAuditEvent('b'), makeAuditEvent('c')]
    const json = expectOk(await call(env, 'GET', '/logs', undefined, 'limit=2'))
    expect(json.events).toHaveLength(2)
    expect(env.audit.recentLimits).toEqual([2])
  })

  it('GET /logs?limit 超过上限时 clamp 到 200', async () => {
    const env = await makeEnv()
    expectOk(await call(env, 'GET', '/logs', undefined, 'limit=999'))
    expect(env.audit.recentLimits).toEqual([200])
  })

  it('GET /logs 读取失败返回 500', async () => {
    const env = await makeEnv()
    env.audit.recent = async () => {
      throw new Error('日志损坏')
    }
    expectFail(await call(env, 'GET', '/logs'), 500, /读取日志失败/)
  })

  it('GET /help 返回使用说明与版本记录', async () => {
    const env = await makeEnv({
      assets: { 'docs/使用说明.md': '# 使用说明内容', 'CHANGELOG.md': '# 变更记录内容' },
    })
    const json = expectOk(await call(env, 'GET', '/help'))
    expect(json.usage).toBe('# 使用说明内容')
    expect(json.changelog).toBe('# 变更记录内容')
    expect(json.warning).toBeUndefined()
  })

  it('GET /help 在文档缺失时返回空串与 warning', async () => {
    const env = await makeEnv()
    const json = expectOk(await call(env, 'GET', '/help'))
    expect(json.usage).toBe('')
    expect(json.changelog).toBe('')
    expect(json.warning as string).toContain('docs/使用说明.md')
  })
})

describe('Host HTTP API：测试与运行时操作', () => {
  it('POST /test/inbound 默认使用白名单第一个联系人', async () => {
    const env = await makeEnv()
    const json = expectOk(await call(env, 'POST', '/test/inbound', { text: '在吗' }), 202)
    expect(json.accepted).toBe(true)
    const message = env.engine!.handled[0]!
    expect(message.contactId).toBe('wxid_alice')
    expect(message.contactName).toBe('测试')
    expect(message.chatType).toBe('single')
    expect(message.kind).toBe('text')
    expect(message.text).toBe('在吗')
    expect(message.receivedAt).toBe(FIXED_NOW)
    expect(message.id.startsWith('test-')).toBe(true)
  })

  it('POST /test/inbound 支持指定 contactId', async () => {
    const env = await makeEnv()
    expectOk(await call(env, 'POST', '/test/inbound', { text: '你好', contactId: 'wxid_bob' }), 202)
    expect(env.engine!.handled[0]!.contactId).toBe('wxid_bob')
  })

  it('POST /test/inbound 文本为空返回 400', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'POST', '/test/inbound', { text: '   ' }), 400, /text/)
  })

  it('POST /test/send 返回发送结果', async () => {
    const env = await makeEnv()
    env.engine!.sendResult = { ok: false, error: '风控拦截' }
    const json = expectOk(await call(env, 'POST', '/test/send', { contactId: 'wxid_alice', text: '测试' }))
    expect(json.result).toEqual({ ok: false, error: '风控拦截' })
    expect(env.engine!.sent).toEqual([{ contactId: 'wxid_alice', text: '测试' }])
  })

  it('POST /test/send 暂停时返回 409 且不调用引擎发送（P1-5）', async () => {
    const env = await makeEnv()
    env.engine!.statusValue = makeEngineStatus({ paused: true, pauseReason: 'manual' })
    expectFail(await call(env, 'POST', '/test/send', { contactId: 'wxid_alice', text: '测试' }), 409, /暂停/)
    expect(env.engine!.sent).toEqual([])
  })

  it('POST /test/send 透传投递三态拒绝结果（P0-2/P1-5）', async () => {
    const env = await makeEnv()
    env.engine!.sendResult = { ok: false, error: '已拒绝发送：今日 token 预算已用尽', delivery: 'not-sent' }
    const json = expectOk(await call(env, 'POST', '/test/send', { contactId: 'wxid_alice', text: '测试' }))
    expect(json.result).toMatchObject({ ok: false, delivery: 'not-sent' })
    expect(env.engine!.sent).toEqual([{ contactId: 'wxid_alice', text: '测试' }])
  })

  it('POST /test/send 的 mockOnly 在非 mock 通道被 409 拒绝且不调用引擎（Phase F）', async () => {
    const env = await makeEnv()
    env.engine!.statusValue = makeEngineStatus({ channelId: 'desktop' })
    expectFail(
      await call(env, 'POST', '/test/send', { contactId: 'wxid_alice', text: '测试', mockOnly: true }),
      409,
      /mock/,
    )
    expect(env.engine!.sent).toEqual([])
  })

  it('POST /test/send 的 mockOnly 在 mock 通道正常放行（Phase F）', async () => {
    const env = await makeEnv()
    const json = expectOk(
      await call(env, 'POST', '/test/send', { contactId: 'wxid_alice', text: '测试', mockOnly: true }),
    )
    expect(json.result).toMatchObject({ ok: true })
    expect(env.engine!.sent).toEqual([{ contactId: 'wxid_alice', text: '测试' }])
  })

  it('POST /pause 与 POST /resume 切换暂停状态', async () => {
    const env = await makeEnv()
    const paused = expectOk(await call(env, 'POST', '/pause', { reason: '手动暂停' }))
    expect(paused).toMatchObject({ paused: true, reason: '手动暂停' })
    expect(env.engine!.paused).toBe(true)
    expect(env.engine!.pauseReason).toBe('手动暂停')
    expectOk(await call(env, 'POST', '/resume'))
    expect(env.engine!.paused).toBe(false)
  })

  it('POST /pause 不传 reason 时使用默认值', async () => {
    const env = await makeEnv()
    const json = expectOk(await call(env, 'POST', '/pause'))
    expect(json.reason).toBe('manual')
  })

  it('POST /memory/clear 透传 contactId', async () => {
    const env = await makeEnv()
    expectOk(await call(env, 'POST', '/memory/clear', { contactId: 'wxid_alice' }))
    expectOk(await call(env, 'POST', '/memory/clear'))
    expect(env.engine!.clearedContactIds).toEqual(['wxid_alice', undefined])
  })

  it('POST /audit/clear 清空审计日志', async () => {
    const env = await makeEnv()
    expectOk(await call(env, 'POST', '/audit/clear'))
    expect(env.engine!.auditCleared).toBe(1)
  })

  it('无引擎时测试与运行时端点返回 409', async () => {
    const env = await makeEnv({ engine: null })
    const cases: Array<[string, string, unknown]> = [
      ['POST', '/test/inbound', { text: '在吗' }],
      ['POST', '/test/send', { contactId: 'wxid_alice', text: '在吗' }],
      ['POST', '/pause', {}],
      ['POST', '/resume', {}],
      ['POST', '/memory/clear', {}],
      ['POST', '/audit/clear', {}],
    ]
    for (const [method, path, body] of cases) {
      const response = await call(env, method, path, body)
      expectFail(response, 409)
    }
  })
})

/* ═══════════════ Phase F：OCR / 读屏诊断（只读降级） ═══════════════ */

describe('Host HTTP API：待发送草稿（task-12 / 13.4）', () => {
  const draftSample: SendDraft = {
    id: 'draft-1',
    opId: 'op-1',
    contactId: 'wxid_alice',
    contactName: '小爱',
    text: '批准才会发送',
    createdAt: FIXED_NOW - 1000,
    expiresAt: FIXED_NOW + 3600_000,
    status: 'pending',
    reason: 'draft-mode',
  }

  it('GET /drafts 返回引擎草稿队列', async () => {
    const env = await makeEnv()
    env.engine!.drafts = [draftSample]
    const json = expectOk(await call(env, 'GET', '/drafts'))
    expect(Array.isArray(json.drafts)).toBe(true)
    expect(json.drafts).toHaveLength(1)
    expect((json.drafts as SendDraft[])[0]).toMatchObject({ id: 'draft-1', status: 'pending', reason: 'draft-mode' })
  })

  it('POST /drafts/approve 成功时调用引擎并透传结果', async () => {
    const env = await makeEnv()
    env.engine!.draftDecision = { ok: true, delivery: 'sent', draft: { ...draftSample, status: 'approved' } }
    const json = expectOk(await call(env, 'POST', '/drafts/approve', { id: 'draft-1' }))
    expect(env.engine!.approveDraftCalls).toEqual(['draft-1'])
    expect(json.ok).toBe(true)
    expect((json.result as DraftDecisionResult).delivery).toBe('sent')
  })

  it('POST /drafts/approve 被门禁拒绝时返回 409 并透传原因', async () => {
    const env = await makeEnv()
    env.engine!.draftDecision = { ok: false, error: '已拒绝发送：引擎已暂停（manual）', detail: 'paused' }
    const response = await call(env, 'POST', '/drafts/approve', { id: 'draft-1' })
    expectFail(response, 409, /暂停/)
    expect(env.engine!.approveDraftCalls).toEqual(['draft-1'])
  })

  it('POST /drafts/approve 对已终结（unknown）的草稿返回 409，绝不重发', async () => {
    const env = await makeEnv()
    env.engine!.draftDecision = { ok: false, error: '该草稿对应的发送操作已终结（可能已发送或结果未知），为避免重复发送已拒绝', detail: 'duplicate' }
    expectFail(await call(env, 'POST', '/drafts/approve', { id: 'draft-1' }), 409, /已终结/)
  })

  it('POST /drafts/approve 草稿不存在时返回 404', async () => {
    const env = await makeEnv()
    env.engine!.draftDecision = { ok: false, error: '草稿不存在或已清理' }
    expectFail(await call(env, 'POST', '/drafts/approve', { id: 'draft-missing' }), 404, /不存在/)
  })

  it('POST /drafts/reject 调用引擎标记拒绝', async () => {
    const env = await makeEnv()
    env.engine!.draftDecision = { ok: true, draft: { ...draftSample, status: 'rejected' } }
    const json = expectOk(await call(env, 'POST', '/drafts/reject', { id: 'draft-1' }))
    expect(env.engine!.rejectDraftCalls).toEqual(['draft-1'])
    expect((json.result as DraftDecisionResult).draft?.status).toBe('rejected')
  })

  it('POST /drafts/approve 缺少 id 时返回 400', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'POST', '/drafts/approve', {}), 400, /id/)
    expect(env.engine!.approveDraftCalls).toEqual([])
  })

  it('GET /drafts/approve 方法不允许时返回 405', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'GET', '/drafts/approve'), 405)
  })

  it('没有引擎时 /drafts 返回 409', async () => {
    const env = await makeEnv({ engine: null })
    expectFail(await call(env, 'GET', '/drafts'), 409, /引擎/)
    expectFail(await call(env, 'POST', '/drafts/approve', { id: 'draft-1' }), 409, /引擎/)
  })

  it('引擎处理草稿抛异常时返回 500', async () => {
    const env = await makeEnv()
    env.engine!.draftDecisionError = new Error('写盘失败')
    expectFail(await call(env, 'POST', '/drafts/approve', { id: 'draft-1' }), 500, /失败/)
  })
})

describe('Host HTTP API：OCR 诊断（Phase F 只读）', () => {
  const sampleEnvelope = {
    channelId: 'desktop',
    channelState: 'running',
    capturedAt: FIXED_NOW,
    ocr: {
      captureId: 'cap-1',
      engines: ['winrt', 'tesseract'],
      lines: 12,
      uncertainCount: 2,
      rejectCount: 1,
      conflictCount: 3,
      durationMs: 345,
      lastReadAt: FIXED_NOW - 1000,
      lastError: 'none',
      dpi: 120,
      scale: 1.5,
      screenshotMode: 'printwindow',
      engineVersion: 'winrt-1.2.0',
      secondOcrUsed: true,
      qualityStatus: 'degraded',
      pipelineMode: 'v3',
    },
  }

  it('GET /diagnostics/ocr 返回通道提供的诊断且只透出白名单字段', async () => {
    const env = await makeEnv()
    env.engine!.ocrDiagnosticsResult = { ...sampleEnvelope, secret: 'should-not-leak' }
    const json = expectOk(await call(env, 'GET', '/diagnostics/ocr'))
    const diagnostics = json.diagnostics as Record<string, unknown>
    expect(diagnostics).toMatchObject({
      available: true,
      channelId: 'desktop',
      channelState: 'running',
      captureId: 'cap-1',
      lines: 12,
      uncertainCount: 2,
      rejectCount: 1,
      conflictCount: 3,
      durationMs: 345,
      dpi: 120,
      scale: 1.5,
      screenshotMode: 'printwindow',
      engineVersion: 'winrt-1.2.0',
      secondOcrUsed: true,
      qualityStatus: 'degraded',
      pipelineMode: 'v3',
      dualEngine: true,
    })
    expect(diagnostics.secret).toBeUndefined()
  })

  it('task-23：OCR 流水线模式只透出 legacy/v3，非法值不编造', async () => {
    const env = await makeEnv()
    env.engine!.ocrDiagnosticsResult = { ocr: { captureId: 'cap-9', pipelineMode: 'legacy' } }
    const legacyView = normalizeOcrDiagnostics(env.engine!.ocrDiagnosticsResult)
    expect(legacyView.available).toBe(true)
    expect(legacyView.pipelineMode).toBe('legacy')

    env.engine!.ocrDiagnosticsResult = { ocr: { captureId: 'cap-9', pipelineMode: 'weird' } }
    const weirdView = normalizeOcrDiagnostics(env.engine!.ocrDiagnosticsResult)
    expect(weirdView.available).toBe(true)
    expect(weirdView.pipelineMode).toBeUndefined()
  })

  it('task-12：诊断白名单补齐 pipeline-fixer 新增字段，缺失时安全忽略', async () => {
    // 只有新字段（无 captureId/lines/lastReadAt）也应判为 available
    const env = await makeEnv()
    env.engine!.ocrDiagnosticsResult = { ocr: { dpi: 144, qualityStatus: 'ok' } }
    const view = normalizeOcrDiagnostics(env.engine!.ocrDiagnosticsResult)
    expect(view.available).toBe(true)
    expect(view.dpi).toBe(144)
    expect(view.qualityStatus).toBe('ok')
    expect(view.scale).toBeUndefined()

    // 全部缺失时保持降级，不因新字段缺失而报错
    const empty = normalizeOcrDiagnostics({ ocr: {} })
    expect(empty.available).toBe(false)
    expect(empty.dpi).toBeUndefined()

    // 越界/超长时钳制
    const clamped = normalizeOcrDiagnostics({
      ocr: {
        dpi: 999_999,
        scale: 99,
        screenshotMode: 'x'.repeat(100),
        engineVersion: 'v'.repeat(100),
        qualityStatus: 'q'.repeat(100),
        conflictCount: 999_999_999,
        rejectCount: 999_999_999,
      },
    })
    expect(clamped.available).toBe(true)
    expect(clamped.dpi).toBeLessThanOrEqual(10_000)
    expect(clamped.scale).toBeLessThanOrEqual(16)
    expect((clamped.screenshotMode ?? '').length).toBeLessThanOrEqual(32)
    expect((clamped.engineVersion ?? '').length).toBeLessThanOrEqual(64)
    expect(clamped.conflictCount).toBeLessThanOrEqual(100_000)
    expect(clamped.rejectCount).toBeLessThanOrEqual(100_000)
  })

  it('通道未提供 ocr 数据时 available:false 并给出原因', async () => {
    const env = await makeEnv()
    env.engine!.ocrDiagnosticsResult = { channelId: 'desktop', channelState: 'running', capturedAt: FIXED_NOW, ocr: null }
    const json = expectOk(await call(env, 'GET', '/diagnostics/ocr'))
    const diagnostics = json.diagnostics as Record<string, unknown>
    expect(diagnostics.available).toBe(false)
    expect(diagnostics.dualEngine).toBe(false)
    expect(String(diagnostics.reason)).toContain('OCR')
  })

  it('引擎读取诊断抛异常时降级为 available:false 并记录 warn', async () => {
    const env = await makeEnv()
    env.engine!.ocrDiagnosticsError = new Error('管道读取崩溃')
    const json = expectOk(await call(env, 'GET', '/diagnostics/ocr'))
    expect((json.diagnostics as Record<string, unknown>).available).toBe(false)
    expect(env.logger.warnings().some((message) => message.includes('读取 OCR 诊断失败'))).toBe(true)
  })

  it('没有引擎时 /diagnostics/ocr 仍返回降级视图', async () => {
    const env = await makeEnv({ engine: null })
    const json = expectOk(await call(env, 'GET', '/diagnostics/ocr'))
    expect((json.diagnostics as Record<string, unknown>).available).toBe(false)
  })

  it('非 GET 方法返回 405', async () => {
    const env = await makeEnv()
    const response = await call(env, 'POST', '/diagnostics/ocr', {})
    expectFail(response, 405)
  })

  it('normalizeOcrDiagnostics 对不可识别输入与超长字段做防御', () => {
    expect(normalizeOcrDiagnostics(null)).toMatchObject({ available: false })
    expect(normalizeOcrDiagnostics('oops')).toMatchObject({ available: false })
    const view = normalizeOcrDiagnostics({
      ocr: {
        captureId: 'x'.repeat(300),
        engines: ['a', 'b', 'c', 'd', 'e'],
        lines: 999999999,
        lastError: 'e'.repeat(1000),
      },
    })
    expect(view.available).toBe(true)
    expect((view.captureId ?? '').length).toBeLessThanOrEqual(128)
    expect(view.engines.length).toBeLessThanOrEqual(3)
    expect(view.lines).toBeLessThanOrEqual(100_000)
    expect((view.lastError ?? '').length).toBeLessThanOrEqual(300)
  })
})

describe('Host HTTP API：attachPersonaRoutes 传输层', () => {
  let env: TestEnv
  let routes: PersonaRoute[] = []
  let disposedCount = 0
  let server: Server | null = null
  let baseUrl = ''
  let port = 0
  let disposeRoutes: () => void = () => undefined
  let envelope: { current: PersonaApi }

  beforeAll(async () => {
    env = await makeEnv()
    routes = []
    disposedCount = 0
    envelope = { current: env.api }
    const proxyApi: PersonaApi = {
      handle: (method, path, query, body, headers, remoteAddress) =>
        envelope.current.handle(method, path, query, body, headers, remoteAddress),
      dispose: () => envelope.current.dispose(),
    }
    const webServer: PersonaWebServerLike = {
      register(route: PersonaRoute) {
        routes.push(route)
        return () => {
          disposedCount += 1
        }
      },
    }
    disposeRoutes = attachPersonaRoutes(webServer, proxyApi, new FakeLogger())
    const route = routes[0]!
    server = createServer((req, res) => {
      const requestUrl = req.url ?? '/'
      if (!requestUrl.startsWith(`${API_PREFIX}/`)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      void Promise.resolve(route.handler(req, res))
    })
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address() as AddressInfo
    port = address.port
    baseUrl = `http://127.0.0.1:${port}${API_PREFIX}`
  })

  afterAll(async () => {
    if (server !== null) {
      const current = server
      server = null
      const closeAll = (current as unknown as { closeAllConnections?: () => void }).closeAllConnections
      if (typeof closeAll === 'function') closeAll.call(current)
      await new Promise<void>((resolve) => current.close(() => resolve()))
    }
  })

  it('注册前缀路由 /dsh-wechat-persona/api/', () => {
    expect(routes.length).toBeGreaterThan(0)
    expect(routes[0]!.kind).toBe('prefix')
    expect(routes[0]!.path).toBe(`${API_PREFIX}/`)
    expect(routes.filter((item) => item.kind === 'prefix')).toHaveLength(1)
  })

  it('经 HTTP 调用 /health 正常返回 JSON', async () => {
    const response = await fetch(`${baseUrl}/health`, { headers: AUTH_HEADERS })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const json = (await response.json()) as Record<string, unknown>
    expect(json.ok).toBe(true)
    expect(json.version).toBe('0.2.0-test')
  })

  it('经 HTTP 调用缺少鉴权头返回 403', async () => {
    const response = await fetch(`${baseUrl}/health`)
    expect(response.status).toBe(403)
    const json = (await response.json()) as Record<string, unknown>
    expect(json.ok).toBe(false)
  })

  it('经 HTTP 调用会解析 JSON 请求体', async () => {
    const response = await fetch(`${baseUrl}/pause`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'HTTP 测试' }),
    })
    expect(response.status).toBe(200)
    expect(env.engine!.pauseReason).toBe('HTTP 测试')
  })

  it('经 HTTP 调用遇到非法 JSON 返回 400', async () => {
    const response = await fetch(`${baseUrl}/pause`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(response.status).toBe(400)
    const json = (await response.json()) as Record<string, unknown>
    expect(json.error as string).toContain('JSON')
  })

  it('经 HTTP 调用可返回二进制图片', async () => {
    const response = await fetch(`${baseUrl}/sticker-file?id=happy%2F001.png`, {
      headers: AUTH_HEADERS,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    const buffer = Buffer.from(await response.arrayBuffer())
    expect(buffer.equals(PNG_BYTES)).toBe(true)
  })

  it('经 HTTP 调用 Content-Type 不是 JSON 时返回 415', async () => {
    const response = await fetch(`${baseUrl}/pause`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'text/plain' },
      body: 'reason=x',
    })
    expect(response.status).toBe(415)
    const json = (await response.json()) as Record<string, unknown>
    expect(json.error as string).toContain('Content-Type')
  })

  it('请求体超过 4MB 上限时返回 413', async () => {
    // 用原始 socket 只发头部（Content-Length 超限），服务器应在读取 body 之前拒绝。
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port })
      const chunks: string[] = []
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(chunks.join(''))
      }
      socket.setTimeout(5000, finish)
      socket.on('connect', () => {
        socket.write(
          `POST ${API_PREFIX}/test/inbound HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${MAX_API_BODY_BYTES + 1}\r\n` +
            'x-dsh-wechat-persona: 1\r\n' +
            'Connection: close\r\n\r\n',
        )
      })
      socket.on('data', (chunk) => {
        chunks.push(chunk.toString('latin1'))
        if (chunks.join('').includes('\r\n\r\n')) finish()
      })
      socket.on('end', finish)
      socket.on('error', reject)
    })
    expect(raw).toContain('413')
    expect(raw).toContain('4MB')
  })

  it('API 内部异常时返回 500 JSON 而不是断开连接', async () => {
    envelope.current = {
      handle: async () => {
        throw new Error('模拟内部崩溃')
      },
      dispose: () => undefined,
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { headers: AUTH_HEADERS })
      expect(response.status).toBe(500)
      const json = (await response.json()) as Record<string, unknown>
      expect(json.ok).toBe(false)
      expect(json.error).toBe('服务器内部错误')
    } finally {
      envelope.current = env.api
    }
  })

  it('disposer 会注销已注册的路由', () => {
    disposeRoutes()
    expect(disposedCount).toBe(routes.length)
  })
})

/* ══════════════════ 发布前安全复核 / 只读测试模式（task-17 只读追加） ══════════════════ */

describe('发布前安全复核：鉴权强度 / 凭据泄露 / 草稿权限', () => {
  const REVIEW_TOKEN = 'review-token-0123456789abcdef'
  const tokenHeaders = (token = REVIEW_TOKEN): Record<string, string> => ({
    ...AUTH_HEADERS,
    authorization: `Bearer ${token}`,
  })

  it('兼容模式下 Host/Origin/Sec-Fetch-Site 可被非浏览器客户端伪造 → 它们只防浏览器，不是调用方鉴权', async () => {
    const env = await makeEnv()
    const spoofed = {
      ...AUTH_HEADERS,
      host: '127.0.0.1:57124',
      origin: 'http://127.0.0.1:57124',
      'sec-fetch-site': 'same-origin',
    }
    expectOk(await call(env, 'GET', '/health', undefined, '', spoofed))
    expectOk(await call(env, 'POST', '/pause', { reason: 'review' }, '', spoofed))
  })

  it('非回环来源地址：即使伪造全部头也返回 403（L1 回环限制真实生效）', async () => {
    const env = await makeEnv()
    const response = await call(
      env,
      'GET',
      '/health',
      undefined,
      '',
      { ...AUTH_HEADERS, host: '127.0.0.1:57124' },
      '192.168.1.50',
    )
    expectFail(response, 403, /回环/)
  })

  it('启用 token 后：Host / Origin / Sec-Fetch-Site 校验先于 token，正确 token 也不能绕过', async () => {
    const env = await makeEnv({ apiToken: REVIEW_TOKEN })
    expectFail(
      await call(env, 'GET', '/health', undefined, '', { ...tokenHeaders(), host: 'evil.example.test' }),
      403,
      /Host/,
    )
    expectFail(
      await call(env, 'GET', '/health', undefined, '', { ...tokenHeaders(), origin: 'http://evil.example.test' }),
      403,
      /Origin/,
    )
    expectFail(
      await call(env, 'GET', '/health', undefined, '', { ...tokenHeaders(), 'sec-fetch-site': 'cross-site' }),
      403,
      /跨站/,
    )
    expectOk(
      await call(env, 'GET', '/health', undefined, '', {
        ...tokenHeaders(),
        host: '127.0.0.1:57124',
        origin: 'http://127.0.0.1:57124',
      }),
    )
  })

  it('GET /config 不回显 token 明文，只给出 apiTokenConfigured 布尔标记', async () => {
    const env = await makeEnv({ apiToken: REVIEW_TOKEN })
    env.config.apiToken = REVIEW_TOKEN
    const json = expectOk(await call(env, 'GET', '/config', undefined, '', tokenHeaders()))
    expect((json.config as WechatPersonaConfig).apiToken).toBe('')
    expect(json.apiTokenConfigured).toBe(true)
    expect(JSON.stringify(json)).not.toContain(REVIEW_TOKEN)
  })

  it('配置校验错误不回显提交值（token 不进入错误响应），且不会保存', async () => {
    const env = await makeEnv({ apiToken: REVIEW_TOKEN })
    const badConfig = { ...env.config, activeChannel: '__invalid_channel__', apiToken: REVIEW_TOKEN }
    const response = await call(env, 'POST', '/config', { config: badConfig }, '', tokenHeaders())
    expectFail(response, 400, /配置校验失败/)
    // 错误 detail 只回显字段路径与允许值，不回显提交的非法值 / token。
    expect(JSON.stringify(response.json)).not.toContain(REVIEW_TOKEN)
    expect(JSON.stringify(response.json)).not.toContain('__invalid_channel__')
    expect(env.savedConfigs).toHaveLength(0)
  })

  it('/drafts/approve 与其它写操作同一鉴权：缺 dsh 头 403，启用 token 后缺 token 401', async () => {
    const compatEnv = await makeEnv()
    expectFail(await call(compatEnv, 'POST', '/drafts/approve', { id: 'draft-1' }, '', {}), 403, /x-dsh-wechat-persona/)
    const tokenEnv = await makeEnv({ apiToken: REVIEW_TOKEN })
    expectFail(await call(tokenEnv, 'POST', '/drafts/approve', { id: 'draft-1' }, '', AUTH_HEADERS), 401, /token/)
    expectOk(await call(tokenEnv, 'POST', '/drafts/approve', { id: 'draft-1' }, '', tokenHeaders()))
    expect(tokenEnv.engine!.approveDraftCalls).toEqual(['draft-1'])
  })

  it('[task-22 修复] POST /personas/install {url} 与市场共用统一 SSRF 校验：内网地址在 fetch 前被拒', async () => {
    const env = await makeEnv()
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input))
      throw new Error('review-stub-blocked')
    }) as typeof fetch
    try {
      for (const url of [
        'http://127.0.0.1:9/internal/pack.json',
        'http://[::1]/internal/pack.json',
        'http://[::127.0.0.1]/internal/pack.json',
        'http://[64:ff9b::127.0.0.1]/internal/pack.json',
        'http://2130706433/internal/pack.json',
        'ftp://127.0.0.1/internal/pack.json',
      ]) {
        const response = await call(env, 'POST', '/personas/install', { url })
        expectFail(response, 400, /安装人格失败/)
      }
      // 统一校验在 fetch 之前完成：没有任何网络请求被发出（不探测真实内网）
      expect(calls).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('发布前验收：只读测试模式（真实发送从 API 层完全禁用）', () => {
  it('/test/send 直接 409 且不调用引擎 sendTest（真实发送函数未被触达）', async () => {
    const env = await makeEnv()
    env.config.readOnlyTestMode = true
    const json = expectFail(
      await call(env, 'POST', '/test/send', { contactId: 'wxid_alice', text: '只读' }),
      409,
      /只读测试模式/,
    )
    expect(json.detail).toBe('read-only-mode')
    expect(env.engine!.sent).toHaveLength(0)
  })

  it('/drafts/approve 直接 409 且不调用引擎 approveDraft；/drafts/reject 仍可用', async () => {
    const env = await makeEnv()
    env.config.readOnlyTestMode = true
    expectFail(await call(env, 'POST', '/drafts/approve', { id: 'draft-1' }), 409, /只读测试模式/)
    expect(env.engine!.approveDraftCalls).toHaveLength(0)
    const rejected = expectOk(await call(env, 'POST', '/drafts/reject', { id: 'draft-1' }))
    expect(rejected.ok).toBe(true)
    expect(env.engine!.rejectDraftCalls).toEqual(['draft-1'])
  })

  it('/status 暴露只读测试模式（security 与引擎状态），/config 返回 boolean 字段', async () => {
    const env = await makeEnv()
    env.config.readOnlyTestMode = true
    const json = expectOk(await call(env, 'GET', '/status'))
    expect(json.readOnlyTestMode).toBe(true)
    expect((json.security as Record<string, unknown>).readOnlyTestMode).toBe(true)
    expect((json.status as Record<string, unknown>).readOnlyTestMode).toBe(true)
    const configJson = expectOk(await call(env, 'GET', '/config'))
    expect((configJson.config as WechatPersonaConfig).readOnlyTestMode).toBe(true)
  })

  it('只读测试模式关闭时 /test/send 仍走引擎（回归：不是无条件 409）', async () => {
    const env = await makeEnv()
    expectOk(await call(env, 'POST', '/test/send', { contactId: 'wxid_alice', text: '正常' }))
    expect(env.engine!.sent).toHaveLength(1)
  })
})

/* ══════════════════ task-22：只读模式绕过路径与安装 URL 统一校验 ══════════════════ */

describe('task-22 只读模式绕过路径与安装 URL 统一校验', () => {
  it('/test/send 缺参 400：参数错误路径不会触达引擎发送', async () => {
    const env = await makeEnv()
    expectFail(await call(env, 'POST', '/test/send', { contactId: 'wxid_alice' }), 400, /text/)
    expectFail(await call(env, 'POST', '/test/send', { text: '在吗' }), 400, /contactId/)
    expect(env.engine!.sent).toHaveLength(0)
  })

  it('只读模式下 /test/inbound 仍转发引擎（由引擎层拒绝副作用），API 不触达发送', async () => {
    const env = await makeEnv()
    env.config.readOnlyTestMode = true
    const response = await call(env, 'POST', '/test/inbound', { contactId: 'wxid_alice', text: '只读入站' })
    expect(response.status).toBe(202)
    expect(env.engine!.handled).toHaveLength(1)
    expect(env.engine!.sent).toHaveLength(0)
  })

  it('POST /config 关闭只读模式会成功（管理员能力，非未授权绕过；引擎侧仍需重启/重新 apply 才生效）', async () => {
    const env = await makeEnv()
    env.config.readOnlyTestMode = true
    const next = { ...env.config, readOnlyTestMode: false }
    expectOk(await call(env, 'POST', '/config', { config: next }), 202)
    expect(env.savedConfigs).toHaveLength(1)
    expect(env.savedConfigs[0]?.readOnlyTestMode).toBe(false)
  })

  it('/test/send 只读 409 时先于引擎调用：engine.sendTest 未被调用（engine.sent 0）', async () => {
    const env = await makeEnv()
    env.config.readOnlyTestMode = true
    expectFail(await call(env, 'POST', '/test/send', { contactId: 'wxid_alice', text: '只读' }), 409, /只读测试模式/)
    expect(env.engine!.sent).toHaveLength(0)
  })

  it('/drafts/approve 只读 409 时 approveDraft 未被调用；reject 仍可用（不触达发送）', async () => {
    const env = await makeEnv()
    env.config.readOnlyTestMode = true
    expectFail(await call(env, 'POST', '/drafts/approve', { id: 'draft-1' }), 409, /只读测试模式/)
    expect(env.engine!.approveDraftCalls).toHaveLength(0)
    expectOk(await call(env, 'POST', '/drafts/reject', { id: 'draft-1' }))
    expect(env.engine!.rejectDraftCalls).toEqual(['draft-1'])
  })
})
