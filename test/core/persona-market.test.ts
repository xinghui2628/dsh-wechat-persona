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
import { PersonaMarket, MARKET_MAX_RESPONSE_BYTES, assertSafeMarketUrl, isPrivateMarketHost } from '../../src/core/persona-market.ts'
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

/** 构造 fetch 的假 Response（带 JSON Content-Type 与 text()，行为贴近真实 fetch）。 */
function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      'content-type': 'application/json',
      'content-length': String(new TextEncoder().encode(text).byteLength),
    }),
    text: async () => text,
    json: async () => body,
  } as unknown as Response
}

/** 构造非 JSON Content-Type 的响应。 */
function textResponse(text: string, contentType = 'text/html', status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response
}

/** 构造重定向响应（302 + Location）。 */
function redirectResponse(location: string, status = 302): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ location }),
    text: async () => '',
    json: async () => ({}),
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
    // 10.3：手动跟随重定向，每一跳重新做 SSRF 校验
    expect(calls[0]?.init?.redirect).toBe('manual')
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
      () => textResponse('{not-json', 'application/json'),
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

/* ────────────────────── 10.3 SSRF / 远程下载安全 ────────────────────── */

describe('10.3 SSRF 防护：地址校验与远程下载安全', () => {
  const builtinPersonas = [makeEntry({ id: 'builtin-small', name: '小号', url: '' })]

  function ssrfMarket(indexUrl: string, route: Route, calls: FakeFetchCall[] = [], logger = new FakeLogger()) {
    return {
      logger,
      calls,
      market: new PersonaMarket({
        config: marketConfig(() => {}, indexUrl),
        library: new FakeLibrary(),
        personas: builtinPersonas,
        logger,
        fetchImpl: fakeFetch({ [indexUrl]: route }, calls),
      }),
    }
  }

  it('isPrivateMarketHost 覆盖 localhost / 内网 IPv4 / IPv6 / .local / 数字变体', () => {
    const privateHosts = [
      'localhost',
      'localhost.',
      'app.local',
      'svc.internal',
      '127.0.0.1',
      '127.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '2130706433',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
      'fd00::1',
      'fe80::1',
    ]
    for (const host of privateHosts) {
      expect(isPrivateMarketHost(host), host).toBe(true)
    }
    const publicHosts = ['example.com', 'cdn.example.com', '1.1.1.1', '8.8.8.8', '2001:4860:4860::8888']
    for (const host of publicHosts) {
      expect(isPrivateMarketHost(host), host).toBe(false)
    }
  })

  it('assertSafeMarketUrl：拒绝非 http/https、内嵌凭据、内网地址，且错误信息不回显完整 URL', () => {
    expect(assertSafeMarketUrl('https://example.com/index.json')).toBe('https://example.com/index.json')
    expect(() => assertSafeMarketUrl('file:///C:/persona.json')).toThrow(/只支持 http\/https/u)
    expect(() => assertSafeMarketUrl('javascript:alert(1)')).toThrow(/只支持 http\/https/u)
    expect(() => assertSafeMarketUrl('https://user:pass@example.com/index.json')).toThrow(/用户名或密码/u)
    expect(() => assertSafeMarketUrl('http://169.254.169.254/latest/meta-data')).toThrow(/本机或内网/u)
    try {
      assertSafeMarketUrl('http://169.254.169.254/latest/meta-data', '索引地址')
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('169.254.169.254')
    }
  })

  it('indexUrl 指向内网/非法协议：回退内置人格、不访问网络、warning 不回显内网 URL', async () => {
    const cases: Array<{ url: string; pattern: RegExp }> = [
      { url: 'http://127.0.0.1:8080/index.json', pattern: /内网/u },
      { url: 'http://169.254.169.254/latest/meta-data', pattern: /内网/u },
      { url: 'http://10.0.0.5/index.json', pattern: /内网/u },
      { url: 'http://172.20.1.1/index.json', pattern: /内网/u },
      { url: 'http://192.168.1.2/index.json', pattern: /内网/u },
      { url: 'http://[::1]/index.json', pattern: /内网/u },
      { url: 'http://printer.local/index.json', pattern: /内网/u },
      { url: 'ftp://example.com/index.json', pattern: /只支持 http\/https/u },
    ]
    for (const item of cases) {
      const calls: FakeFetchCall[] = []
      const { market } = ssrfMarket(item.url, () => jsonResponse({ personas: [makeEntry()] }), calls)
      const result = await market.fetchIndex()
      expect(result.source, item.url).toBe('builtin')
      expect(result.warning ?? '', item.url).toMatch(item.pattern)
      expect(result.warning ?? '', item.url).not.toContain('169.254')
      expect(calls, item.url).toEqual([])
    }
  })

  it('重定向到内网地址：拒绝跟随（不外泄请求），回退内置并提示内网', async () => {
    const calls: FakeFetchCall[] = []
    const { market } = ssrfMarket(INDEX_URL, () => redirectResponse('http://127.0.0.1/secret'), calls)
    const result = await market.fetchIndex()
    expect(result.source).toBe('builtin')
    expect(result.warning ?? '').toMatch(/内网/u)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(INDEX_URL)
  })

  it('重定向次数超过上限（2 跳）：拒绝并回退，不无限跟随', async () => {
    const calls: FakeFetchCall[] = []
    const market = new PersonaMarket({
      config: marketConfig(),
      library: new FakeLibrary(),
      personas: builtinPersonas,
      logger: new FakeLogger(),
      fetchImpl: fakeFetch(
        {
          [INDEX_URL]: () => redirectResponse('https://example.com/hop-1'),
          'https://example.com/hop-1': () => redirectResponse('https://example.com/hop-2'),
          'https://example.com/hop-2': () => redirectResponse('https://example.com/hop-3'),
        },
        calls,
      ),
    })
    const result = await market.fetchIndex()
    expect(result.source).toBe('builtin')
    expect(result.warning ?? '').toContain('重定向次数超过上限')
    expect(calls).toHaveLength(3)
  })

  it('相对路径重定向：按当前 URL 解析后继续拉取', async () => {
    const calls: FakeFetchCall[] = []
    const realIndex = 'https://example.com/personas/real-index.json'
    const market = new PersonaMarket({
      config: marketConfig(() => {}, 'https://example.com/personas/index.json'),
      library: new FakeLibrary(),
      logger: new FakeLogger(),
      fetchImpl: fakeFetch(
        {
          'https://example.com/personas/index.json': () => redirectResponse('./real-index.json'),
          [realIndex]: () => jsonResponse({ personas: [makeEntry({ id: 'persona-a' })] }),
        },
        calls,
      ),
    })
    const result = await market.fetchIndex()
    expect(result.source).toBe('remote')
    expect(result.entries.map((entry) => entry.id)).toEqual(['persona-a'])
    expect(calls.map((call) => call.url)).toEqual(['https://example.com/personas/index.json', realIndex])
  })

  it('Content-Type 不是 JSON：拒绝并回退内置', async () => {
    const { market } = ssrfMarket(INDEX_URL, () => textResponse('<html>not json</html>', 'text/html'))
    const result = await market.fetchIndex()
    expect(result.source).toBe('builtin')
    expect(result.warning ?? '').toContain('Content-Type 不是 JSON')
  })

  it('Content-Length 超过 2MB：拒绝并回退内置', async () => {
    const { market } = ssrfMarket(INDEX_URL, () => {
      const response = jsonResponse({ personas: [makeEntry()] })
      ;(response.headers as Headers).set('content-length', String(MARKET_MAX_RESPONSE_BYTES + 1))
      return response
    })
    const result = await market.fetchIndex()
    expect(result.source).toBe('builtin')
    expect(result.warning ?? '').toContain('超过 2MB 上限')
  })

  it('无 Content-Length 但流式响应体超过 2MB：读取过程中拒绝（不把整段读进内存后才判断）', async () => {
    const { market } = ssrfMarket(INDEX_URL, () => {
      const chunk = new Uint8Array(1024 * 1024)
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 1
          if (sent > 3) {
            controller.close()
            return
          }
          controller.enqueue(chunk)
        },
      })
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body,
      } as unknown as Response
    })
    const result = await market.fetchIndex()
    expect(result.source).toBe('builtin')
    expect(result.warning ?? '').toContain('超过 2MB 上限')
  })

  it('install 下载地址指向内网 / 含凭据：拒绝且不请求、不落库', async () => {
    const library = new FakeLibrary()
    for (const badUrl of ['http://127.0.0.1/pack.json', 'http://192.168.0.2/pack.json', 'https://user:pass@example.com/pack.json']) {
      const calls: FakeFetchCall[] = []
      const market = new PersonaMarket({
        config: marketConfig(),
        library,
        logger: new FakeLogger(),
        fetchImpl: fakeFetch(
          {
            [INDEX_URL]: () => jsonResponse({ personas: [makeEntry({ id: 'persona-a', url: badUrl })] }),
          },
          calls,
        ),
      })
      await expect(market.install('persona-a'), badUrl).rejects.toThrow(/内网|用户名或密码/u)
      expect(calls.map((call) => call.url), badUrl).toEqual([INDEX_URL])
    }
    expect(library.installs).toEqual([])
  })

  it('install 下载响应 Content-Type 非 JSON：拒绝且不落库', async () => {
    const calls: FakeFetchCall[] = []
    const market = new PersonaMarket({
      config: marketConfig(),
      library: new FakeLibrary(),
      logger: new FakeLogger(),
      fetchImpl: fakeFetch(
        {
          [INDEX_URL]: () => jsonResponse({ personas: [makeEntry({ id: 'persona-a', url: PACK_URL })] }),
          [PACK_URL]: () => textResponse('<html>', 'text/html'),
        },
        calls,
      ),
    })
    await expect(market.install('persona-a')).rejects.toThrow(/Content-Type 不是 JSON/u)
    expect(calls.map((call) => call.url)).toEqual([INDEX_URL, PACK_URL])
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

/* ─────────────────── 发布前安全复核：SSRF 边界（只读追加） ─────────────────── */

describe('发布前安全复核：SSRF 边界（当前实现 + 已知缺口证据）', () => {
  it('IPv4 十进制/十六进制/短点分/前导零写法经 URL 归一化后仍被拒绝', () => {
    for (const url of [
      'http://2130706433/',
      'http://0x7f000001/',
      'http://127.1/',
      'http://0177.0.0.1/',
      'http://127.0.0.1./',
      'http://localhost.:80/',
      'http://127.0.0.1:8080/',
      'http://0.0.0.0/',
    ]) {
      expect(() => assertSafeMarketUrl(url), url).toThrow(/不允许指向本机或内网地址/)
    }
  })

  it('IPv6 回环/映射/ULA/链路本地/未指定地址被拒绝', () => {
    for (const url of [
      'http://[::1]/',
      'http://[0:0:0:0:0:0:0:1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[fc00::1]/',
      'http://[fd12:3456::1]/',
      'http://[fe80::1]/',
      'http://[::]/',
    ]) {
      expect(() => assertSafeMarketUrl(url), url).toThrow(/不允许指向本机或内网地址/)
    }
  })

  it('内嵌凭据与非 http(s) 协议被拒绝；错误信息不回显原始 URL', () => {
    for (const url of ['http://127.0.0.1@example.com/', 'http://user:pass@example.com/']) {
      expect(() => assertSafeMarketUrl(url), url).toThrow(/不允许包含用户名或密码/)
    }
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://evil.example.test/a.json']) {
      expect(() => assertSafeMarketUrl(url), url).toThrow(/只支持 http\/https/)
    }
    try {
      assertSafeMarketUrl('http://2130706433/')
      throw new Error('unreachable')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain('2130706433')
      expect(message).not.toContain('127.0.0.1')
    }
  })

  it('[已知缺口 P2] IPv4-compatible / NAT64 形式的 IPv6 字面量当前不被字符串校验拦截', () => {
    // 说明：需要特定网络栈（IPv4-compatible 路由 / NAT64）才可能真正连到 127.0.0.1，
    // 当前实现按字符串判定会放行；修复方案与测试设计见 docs/SECURITY-REVIEW-PRE-RELEASE.md。
    expect(() => assertSafeMarketUrl('http://[::127.0.0.1]/')).not.toThrow()
    expect(() => assertSafeMarketUrl('http://[64:ff9b::127.0.0.1]/')).not.toThrow()
  })

  it('[已知缺口 P1] 公网域名通过字符串校验，DNS 解析/重绑定不由本实现校验（注入 fetch 证据）', async () => {
    expect(isPrivateMarketHost('rebind.example.test')).toBe(false)
    const calls: FakeFetchCall[] = []
    const market = new PersonaMarket({
      config: marketConfig(() => {}, 'http://rebind.example.test/index.json'),
      library: new FakeLibrary(),
      logger: new FakeLogger(),
      fetchImpl: fakeFetch(
        {
          'http://rebind.example.test/index.json': () =>
            jsonResponse({
              version: 1,
              personas: [makeEntry({ id: 'persona-a', name: '人格 A', url: PACK_URL })],
            }),
        },
        calls,
      ),
    })
    const result = await market.fetchIndex()
    // 当前实现只校验 URL 字符串，真正解析到哪个 IP 由 fetch/DNS 决定（潜在 DNS rebinding）。
    expect(result.source).toBe('remote')
    expect(calls[0]?.url).toBe('http://rebind.example.test/index.json')
  })

  it('302 重定向到十进制 IPv4 / IPv6 映射 / 末尾点地址时，每一跳校验都会拒绝', async () => {
    for (const target of ['http://2130706433/', 'http://[::ffff:127.0.0.1]/', 'http://127.0.0.1./']) {
      const calls: FakeFetchCall[] = []
      const market = new PersonaMarket({
        config: marketConfig(),
        library: new FakeLibrary(),
        logger: new FakeLogger(),
        fetchImpl: fakeFetch({ [INDEX_URL]: () => redirectResponse(target) }, calls),
      })
      const result = await market.fetchIndex()
      expect(result.source, target).toBe('builtin')
      expect(calls, target).toHaveLength(1)
    }
  })
})
