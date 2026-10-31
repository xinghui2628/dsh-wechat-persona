/**
 * PersonaMarket 单元测试：
 * - fetchIndex 的内置回退（未配置 URL / builtinOnly / 从人格库推导）；
 * - 远程索引成功归一化 + 已安装标记；
 * - 各类失败（网络/HTTP/非 JSON/格式错误/超时）回退内置且不抛；
 * - install 下载→解析→落库、索引 id 优先、updated 语义与各类错误文案；
 * - 与真实 PersonaLibrary 的集成（下载后落盘、可列出、可转引擎包）。
 *
 * fetch 全部注入替身，不碰真实网络；磁盘临时目录测试后清理。
 */

import { describe, expect, it, afterAll } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WechatPersonaConfig } from '../../src/config.ts'
import type {
  MarketEntry,
  PersonaLibraryLike,
  PersonaPackV2,
  PersonaSummary,
} from '../../src/types.ts'
import { PersonaMarket } from '../../src/core/persona-market.ts'
import type { FetchLike } from '../../src/core/persona-market.ts'
import { parsePersonaPack, PersonaLibrary } from '../../src/core/persona-library.ts'
import { FakeLogger, testConfig } from './fakes.ts'

/* ────────────────────────────── 测试基础设施 ────────────────────────────── */

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const INDEX_URL = 'https://example.com/personas/index.json'
const PACK_URL = 'https://cdn.example.com/personas/persona-a.json'

let tempRoots: string[] = []

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(PROJECT_ROOT, `.tmp-persona-${prefix}-`))
  tempRoots.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true })
  tempRoots = []
})

/** 构造一个合法 PersonaPackV2。 */
function makePack(overrides: Partial<PersonaPackV2> = {}): PersonaPackV2 {
  return {
    version: 2,
    id: 'test-pack',
    name: '测试人格',
    avatar: '🙂',
    style: '短句口语',
    catchphrases: ['确实', '行吧'],
    systemPrompt: '你是测试人格，短句口语聊天。不自称 AI，不客服腔。',
    examples: [{ user: '在吗', reply: '在，咋了' }],
    taboo: ['转账', '验证码'],
    stickers: [],
    author: '测试作者',
    description: '测试用',
    tags: ['测试'],
    packVersion: '1.0.0',
    source: 'local',
    ...overrides,
  }
}

/** 构造一条市场索引条目。 */
function makeEntry(overrides: Partial<MarketEntry> = {}): MarketEntry {
  return {
    id: 'persona-a',
    name: '人格 A',
    description: '描述 A',
    author: '作者 A',
    avatar: 'a.png',
    tags: ['标签'],
    version: '1.0.0',
    downloads: 0,
    url: PACK_URL,
    installed: false,
    ...overrides,
  }
}

/** 构造 fetch 的假 Response。 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

interface FakeFetchCall {
  url: string
  init?: RequestInit
}

type Route = () => Response | Promise<Response>

/** 按 URL 路由的 fetch 替身；未注册的 URL 直接抛错（防止意外联网/漏配路由）。 */
function fakeFetch(routes: Record<string, Route>, calls: FakeFetchCall[] = []): FetchLike {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    const route = routes[url]
    if (!route) throw new Error(`测试未注册的 URL：${url}`)
    return route()
  }
}

/** 内存版人格库（PersonaLibraryLike），记录调用参数用于断言。 */
class FakeLibrary implements PersonaLibraryLike {
  readonly packs = new Map<string, PersonaPackV2>()
  readonly installs: Array<{ pack: PersonaPackV2; source: 'market' | 'local' }> = []
  readonly listCalls: string[] = []
  readonly getCalls: string[] = []

  constructor(packs: PersonaPackV2[] = []) {
    for (const pack of packs) this.packs.set(pack.id, structuredClone(pack))
  }

  async list(activeId: string): Promise<PersonaSummary[]> {
    this.listCalls.push(activeId)
    return [...this.packs.values()].map((pack) => this.summarize(pack, pack.id === activeId))
  }

  async get(id: string): Promise<PersonaPackV2 | null> {
    this.getCalls.push(id)
    const pack = this.packs.get(id)
    return pack ? structuredClone(pack) : null
  }

  async install(pack: PersonaPackV2, source: 'market' | 'local'): Promise<PersonaSummary> {
    const installed: PersonaPackV2 = { ...structuredClone(pack), source, installedAt: 999 }
    this.installs.push({ pack: structuredClone(pack), source })
    this.packs.set(installed.id, installed)
    return this.summarize(installed, false)
  }

  async importJson(input: unknown): Promise<PersonaSummary> {
    return this.install(parsePersonaPack(input), 'local')
  }

  async uninstall(id: string): Promise<boolean> {
    return this.packs.delete(id)
  }

  async exportPack(id: string): Promise<PersonaPackV2 | null> {
    return this.get(id)
  }

  private summarize(pack: PersonaPackV2, active: boolean): PersonaSummary {
    return {
      id: pack.id,
      name: pack.name,
      avatar: pack.avatar,
      style: pack.style,
      description: pack.description,
      tags: [...pack.tags],
      author: pack.author,
      packVersion: pack.packVersion,
      source: pack.source ?? 'local',
      active,
      installedAt: pack.installedAt,
    }
  }
}

/** 配置：远程索引 URL + 可选覆盖。 */
function marketConfig(mutate: (config: WechatPersonaConfig) => void = () => {}, indexUrl = INDEX_URL): WechatPersonaConfig {
  return testConfig((config) => {
    config.market.indexUrl = indexUrl
    mutate(config)
  })
}

/* ────────────────────────────── 内置索引 ────────────────────────────── */

describe('fetchIndex 内置人格', () => {
  it('未配置 indexUrl：返回内置索引、无 warning、不访问网络', async () => {
    const calls: FakeFetchCall[] = []
    const market = new PersonaMarket({
      config: testConfig(),
      library: new FakeLibrary(),
      personas: [makeEntry({ id: 'builtin-small', name: '小号', url: '' }), makeEntry({ id: 'builtin-geek', name: '阿码', url: '' })],
      logger: new FakeLogger(),
      fetchImpl: fakeFetch({}, calls),
    })
    const result = await market.fetchIndex()
    expect(result.source).toBe('builtin')
    expect(result.warning).toBeUndefined()
    expect(result.entries.map((entry) => entry.id)).toEqual(['builtin-small', 'builtin-geek'])
    // 内置人格天然可用，installed 固定 true
    expect(result.entries.every((entry) => entry.installed)).toBe(true)
    expect(calls).toEqual([])
  })

  it('builtinOnly=true：即使配置了 indexUrl 也不联网', async () => {
    const calls: FakeFetchCall[] = []
    const market = new PersonaMarket({
      config: marketConfig((config) => {
        config.market.builtinOnly = true
      }),
      library: new FakeLibrary([makePack({ id: 'builtin-small', source: 'builtin' })]),
      personas: [makeEntry({ id: 'builtin-small', name: '小号', url: '' })],
      logger: new FakeLogger(),
      fetchImpl: fakeFetch({}, calls),
    })
    const result = await market.fetchIndex()
    expect(result.source).toBe('builtin')
    expect(calls).toEqual([])
  })

  it('未注入 personas 时从人格库推导内置人格（排除已安装条目）', async () => {
    const library = new FakeLibrary([
      makePack({ id: 'builtin-small', name: '小号', source: 'builtin' }),
      makePack({ id: 'installed-x', name: '已装', source: 'market' }),
    ])
    const market = new PersonaMarket({ config: testConfig(), library, logger: new FakeLogger() })
    const result = await market.fetchIndex()
    expect(result.entries.map((entry) => entry.id)).toEqual(['builtin-small'])
    expect(result.entries[0]).toMatchObject({ url: '', installed: true, version: '1.0.0' })
  })
})

/* ────────────────────────────── 远程索引 ────────────────────────────── */

describe('fetchIndex 远程索引', () => {
  it('成功：归一化字段、消毒 id、去重并标记已安装', async () => {
    const library = new FakeLibrary([makePack({ id: 'installed-a', name: '已装人格', source: 'market' })])
    const index = {
      version: 1,
      personas: [
        {
          id: 'persona-a',
          name: '人格 A',
          description: '新人格',
          author: '作者甲',
          avatar: 'a.png',
          tags: ['治愈', '日常'],
          version: '2.0.0',
          downloads: 12.7,
          url: PACK_URL,
        },
        { id: 'installed-a', name: '已装人格', url: PACK_URL },
        { id: '', name: '非法 id' },
        { id: 'persona-a', name: '重复条目', url: PACK_URL },
        { id: '  Persona-B!! ', name: '需要消毒', url: PACK_URL },
      ],
    }
    const market = new PersonaMarket({
      config: marketConfig(),
      library,
      logger: new FakeLogger(),
      fetchImpl: fakeFetch({ [INDEX_URL]: () => jsonResponse(index) }),
    })
    const result = await market.fetchIndex()
    expect(result.source).toBe('remote')
    expect(result.entries.map((entry) => entry.id)).toEqual(['persona-a', 'installed-a', 'persona-b'])
    expect(result.entries[0]).toMatchObject({
      name: '人格 A',
      description: '新人格',
      author: '作者甲',
      avatar: 'a.png',
      tags: ['治愈', '日常'],
      version: '2.0.0',
      downloads: 12,
      url: PACK_URL,
      installed: false,
    })
    expect(result.entries[1]?.installed).toBe(true)
    expect(result.entries[2]?.installed).toBe(false)
  })

  it('索引也接受裸数组', async () => {
    const market = new PersonaMarket({
      config: marketConfig(),
      library: new FakeLibrary(),
      logger: new FakeLogger(),
      fetchImpl: fakeFetch({ [INDEX_URL]: () => jsonResponse([makeEntry({ id: 'solo' })]) }),
    })
    const result = await market.fetchIndex()
    expect(result.source).toBe('remote')
    expect(result.entries.map((entry) => entry.id)).toEqual(['solo'])
  })

  it('请求使用 GET + JSON Accept + AbortSignal 超时信号', async () => {
    const calls: FakeFetchCall[] = []
    const market = new PersonaMarket({
      config: marketConfig((config) => {
        config.market.timeoutMs = 4321
      }),
      library: new FakeLibrary(),
      logger: new FakeLogger(),
      fetchImpl: fakeFetch({ [INDEX_URL]: () => jsonResponse({ personas: [makeEntry({ id: 'persona-a' })] }) }, calls),
    })
    await market.fetchIndex()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(INDEX_URL)
    expect(calls[0]?.init?.method).toBe('GET')
    expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.accept).toBe('application/json')
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })
})

/* ────────────────────────────── 远程失败回退 ────────────────────────────── */

describe('fetchIndex 失败回退内置（绝不抛）', () => {
  const builtinPersonas = [makeEntry({ id: 'builtin-small', name: '小号', url: '' })]

  function fallbackMarket(route: Route, logger: FakeLogger): PersonaMarket {
    return new PersonaMarket({
      config: marketConfig(),
      library: new FakeLibrary(),
      personas: builtinPersonas,
      logger,
      fetchImpl: fakeFetch({ [INDEX_URL]: route }),
    })
  }

  it('网络错误：回退内置，warning 含原因并写 warn 日志', async () => {
    const logger = new FakeLogger()
    const market = fallbackMarket(() => {
      throw new Error('ECONNREFUSED')
    }, logger)
    const result = await market.fetchIndex()
    expect(result.source).toBe('builtin')
    expect(result.warning).toContain('远程人格索引不可用')
    expect(result.warning).toContain('ECONNREFUSED')
    expect(result.entries.map((entry) => entry.id)).toEqual(['builtin-small'])
    expect(logger.warnings().some((message) => message.includes('远程人格索引不可用'))).toBe(true)
  })

  it('HTTP 非 2xx：回退内置，warning 含状态码', async () => {
    const market = fallbackMarket(() => jsonResponse({}, 500), new FakeLogger())
    const result = await market.fetchIndex()
    expect(result.source).toBe('builtin')
    expect(result.warning).toContain('HTTP 500')
  })

  it('响应不是合法 JSON：回退内置', async () => {
    const market = fallbackMarket(
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('Unexpected token')
          },
        }) as unknown as Response,
      new FakeLogger(),
    )
    const result = await market.fetchIndex()
    expect(result.source).toBe('builtin')
    expect(result.warning).toContain('不是合法 JSON')
  })

  it('索引格式错误（缺少 personas）：回退内置', async () => {
    const market = fallbackMarket(() => jsonResponse({ hello: 'world' }), new FakeLogger())
    const result = await market.fetchIndex()
    expect(result.source).toBe('builtin')
    expect(result.warning).toContain('索引格式错误')
  })

  it('超时错误：warning 含「请求超时（50ms）」', async () => {
    const market = new PersonaMarket({
      config: marketConfig(),
      library: new FakeLibrary(),
      personas: builtinPersonas,
      logger: new FakeLogger(),
      timeoutMs: 50,
      fetchImpl: fakeFetch({
        [INDEX_URL]: () => {
          const error = new Error('aborted')
          error.name = 'TimeoutError'
          throw error
        },
      }),
    })
    const result = await market.fetchIndex()
    expect(result.warning).toContain('请求超时（50ms）')
  })

  it('回退时没有任何内置人格：entries 为空并给出提示', async () => {
    const market = new PersonaMarket({
      config: marketConfig(),
      library: new FakeLibrary(),
      logger: new FakeLogger(),
      fetchImpl: fakeFetch({ [INDEX_URL]: () => jsonResponse({ personas: [] }) }),
    })
    const result = await market.fetchIndex()
    expect(result.entries).toEqual([])
    expect(result.warning).toContain('没有找到可用的内置人格')
  })
})

/* ────────────────────────────── install ────────────────────────────── */

describe('install', () => {
  /** 远程索引（一条 persona-a）+ 包下载路由；返回 market 与调用记录。 */
  function remoteEnvironment(packBody: unknown, packRoute?: Route): { market: PersonaMarket; library: FakeLibrary; calls: FakeFetchCall[] } {
    const library = new FakeLibrary()
    const calls: FakeFetchCall[] = []
    const market = new PersonaMarket({
      config: marketConfig(),
      library,
      logger: new FakeLogger(),
      fetchImpl: fakeFetch(
        {
          [INDEX_URL]: () => jsonResponse({ version: 1, personas: [makeEntry({ id: 'persona-a', name: '人格 A', url: PACK_URL })] }),
          [PACK_URL]: packRoute ?? (() => jsonResponse(packBody)),
        },
        calls,
      ),
    })
    return { market, library, calls }
  }

  it('下载→解析→安装：索引 id 优先，首次 updated=false', async () => {
    const { market, library, calls } = remoteEnvironment(makePack({ id: 'pack-inner-id', name: '下载的人格' }))
    const { persona, updated } = await market.install('persona-a')
    expect(updated).toBe(false)
    expect(persona.id).toBe('persona-a')
    expect(persona.name).toBe('下载的人格')
    expect(persona.source).toBe('market')
    expect(library.installs).toHaveLength(1)
    expect(library.installs[0]?.source).toBe('market')
    // 索引 id 是权威身份：包内自带 id 被覆盖
    expect(library.installs[0]?.pack.id).toBe('persona-a')
    expect(library.installs[0]?.pack.name).toBe('下载的人格')
    expect(calls.map((call) => call.url)).toEqual([INDEX_URL, PACK_URL])
  })

  it('重复安装同 id：updated=true（覆盖已安装副本）', async () => {
    const { market } = remoteEnvironment(makePack({ name: '下载的人格' }))
    expect((await market.install('persona-a')).updated).toBe(false)
    expect((await market.install('persona-a')).updated).toBe(true)
  })

  it('内置人格无需安装：抛中文提示，不写库', async () => {
    const library = new FakeLibrary()
    const market = new PersonaMarket({
      config: testConfig(),
      library,
      personas: [makeEntry({ id: 'builtin-small', name: '小号', url: '' })],
      logger: new FakeLogger(),
    })
    await expect(market.install('builtin-small')).rejects.toThrow(/内置人格，无需安装/u)
    expect(library.installs).toEqual([])
  })

  it('索引中找不到 id：抛「人格市场中找不到 id」', async () => {
    const { market } = remoteEnvironment(makePack())
    await expect(market.install('nope')).rejects.toThrow(/人格市场中找不到 id：nope/u)
  })

  it('空 id / 纯中文 id 抛错；路径穿越 id 被消毒成普通 id', async () => {
    const library = new FakeLibrary()
    const market = new PersonaMarket({ config: testConfig(), library, logger: new FakeLogger() })
    await expect(market.install('')).rejects.toThrow(/id 非法/u)
    await expect(market.install('中文名')).rejects.toThrow(/id 非法/u)
    await expect(market.install('../../evil')).rejects.toThrow(/找不到 id：evil/u)
    expect(library.installs).toEqual([])
  })

  it('远程条目缺少下载地址：抛错', async () => {
    const library = new FakeLibrary()
    const market = new PersonaMarket({
      config: marketConfig(),
      library,
      logger: new FakeLogger(),
      fetchImpl: fakeFetch({
        [INDEX_URL]: () => jsonResponse({ personas: [makeEntry({ id: 'persona-a', name: '人格 A', url: '' })] }),
      }),
    })
    await expect(market.install('persona-a')).rejects.toThrow(/没有提供下载地址/u)
  })

  it('下载地址只允许 http/https：file: 协议被拒绝', async () => {
    const market = new PersonaMarket({
      config: marketConfig(),
      library: new FakeLibrary(),
      logger: new FakeLogger(),
      fetchImpl: fakeFetch({
        [INDEX_URL]: () =>
          jsonResponse({ personas: [makeEntry({ id: 'persona-a', name: '人格 A', url: 'file:///C:/persona.json' })] }),
      }),
    })
    await expect(market.install('persona-a')).rejects.toThrow(/只支持 http\/https/u)
  })

  it('下载的包格式非法：抛解析错误且不落库', async () => {
    const { market, library } = remoteEnvironment({ foo: 'bar' })
    await expect(market.install('persona-a')).rejects.toThrow(/id 非法/u)
    expect(library.installs).toEqual([])
  })

  it('下载失败（HTTP 404）：抛错且不落库', async () => {
    const { market, library } = remoteEnvironment(undefined, () => jsonResponse({}, 404))
    await expect(market.install('persona-a')).rejects.toThrow(/HTTP 404/u)
    expect(library.installs).toEqual([])
  })
})

/* ────────────────────────────── 与真实人格库集成 ────────────────────────────── */

describe('与 PersonaLibrary 集成', () => {
  it('市场下载落盘后：人格库可读取、列表标记 source=market、索引可显示已安装', async () => {
    const root = await tmpDir('market')
    const builtinDir = join(root, 'builtin')
    await mkdir(builtinDir, { recursive: true })
    const library = new PersonaLibrary({ config: testConfig(), logger: new FakeLogger(), workspace: root, builtinDir })
    const market = new PersonaMarket({
      config: marketConfig(),
      library,
      logger: new FakeLogger(),
      fetchImpl: fakeFetch({
        [INDEX_URL]: () => jsonResponse({ version: 1, personas: [makeEntry({ id: 'persona-a', name: '人格 A', url: PACK_URL })] }),
        [PACK_URL]: () => jsonResponse(makePack({ id: 'inner-id', name: '下载的人格', source: 'market', catchphrases: ['确实'], taboo: ['转账'] })),
      }),
    })

    const { persona, updated } = await market.install('persona-a')
    expect(updated).toBe(false)
    expect(persona.id).toBe('persona-a')
    expect(persona.source).toBe('market')

    const loaded = await library.get('persona-a')
    expect(loaded?.name).toBe('下载的人格')
    expect(loaded?.catchphrases).toEqual(['确实'])
    expect(loaded?.source).toBe('market')
    if (!loaded) throw new Error('unreachable')
    expect(library.toEnginePack(loaded).systemPrompt).toContain('转账')

    const listed = await library.list('persona-a')
    expect(listed.find((summary) => summary.id === 'persona-a')).toMatchObject({ source: 'market', active: true })

    // 再次拉索引：该条目应显示已安装
    const again = await market.fetchIndex()
    expect(again.source).toBe('remote')
    expect(again.entries.find((entry) => entry.id === 'persona-a')?.installed).toBe(true)
  })
})
