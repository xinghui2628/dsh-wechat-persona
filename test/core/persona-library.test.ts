/**
 * PersonaLibrary 单元测试：
 * - 真实内置人格包（personas/builtin/*.json）合法性 + 固定顺序；
 * - list/get/active 语义与「已安装覆盖内置」；
 * - install/uninstall/exportPack/importJson 的落盘、消毒、容错与安全；
 * - SillyTavern 角色卡兼容映射；
 * - toEnginePack 的提示词合并与 examples 字段映射。
 *
 * 磁盘操作用注入的临时工作区（项目根下 .tmp-persona-* 目录，测试结束清理），
 * 不污染真实数据目录。
 */

import { describe, expect, it, afterAll } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WechatPersonaConfig } from '../../src/config.ts'
import type { PersonaPackV2, PersonaSummary } from '../../src/types.ts'
import {
  BUILTIN_PERSONA_ORDER,
  DEFAULT_BUILTIN_DIR,
  PersonaLibrary,
  isValidPersonaId,
  mapSillyTavernCard,
  parsePersonaPack,
  sanitizePersonaId,
} from '../../src/core/persona-library.ts'
import { FakeLogger, testConfig } from './fakes.ts'

/* ────────────────────────────── 测试基础设施 ────────────────────────────── */

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))

let tempRoots: string[] = []

/** 在项目根下建唯一临时目录（Windows 沙箱内可写，避免依赖系统 temp 权限）。 */
async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(PROJECT_ROOT, `.tmp-persona-${prefix}-`))
  tempRoots.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true })
  tempRoots = []
})

/** 构造一个合法 PersonaPackV2（字段可覆盖）。 */
function makePack(overrides: Partial<PersonaPackV2> = {}): PersonaPackV2 {
  return {
    version: 2,
    id: 'test-pack',
    name: '测试人格',
    avatar: '🙂',
    style: '短句口语，冷幽默',
    catchphrases: ['确实', '行吧'],
    systemPrompt: '你是测试人格，像真人在微信上短句聊天。不自称 AI，不客服腔。',
    examples: [{ user: '在吗', reply: '在，咋了' }],
    taboo: ['转账', '验证码'],
    stickers: [],
    author: '测试作者',
    description: '测试用内置人格',
    tags: ['测试'],
    packVersion: '1.0.0',
    source: 'local',
    ...overrides,
  }
}

interface LibraryEnv {
  root: string
  builtinDir: string
  dataDir: string
  logger: FakeLogger
  lib: PersonaLibrary
}

/** 建一个带自定义内置目录的人格库环境（每个测试独立目录）。 */
async function setupLibrary(options: {
  builtinPacks?: PersonaPackV2[]
  configMutate?: (config: WechatPersonaConfig) => void
  now?: () => number
} = {}): Promise<LibraryEnv> {
  const root = await tmpDir('lib')
  const builtinDir = join(root, 'builtin')
  await mkdir(builtinDir, { recursive: true })
  for (const pack of options.builtinPacks ?? []) {
    await writeFile(join(builtinDir, `${pack.id}.json`), JSON.stringify(pack, null, 2), 'utf8')
  }
  const config = testConfig((value) => {
    value.persona.activeId = 'builtin-small'
    options.configMutate?.(value)
  })
  const logger = new FakeLogger()
  const lib = new PersonaLibrary({ config, logger, workspace: root, builtinDir, now: options.now })
  return { root, builtinDir, dataDir: join(root, '.dsh-wechat-persona'), logger, lib }
}

function byId(summaries: PersonaSummary[], id: string): PersonaSummary | undefined {
  return summaries.find((summary) => summary.id === id)
}

/* ────────────────────────────── 内置人格包 ────────────────────────────── */

describe('内置人格包（真实 personas/builtin）', () => {
  it('默认目录包含 4 个内置人格且顺序固定', async () => {
    const lib = new PersonaLibrary({
      config: testConfig(),
      logger: new FakeLogger(),
      workspace: await tmpDir('builtin-list'),
    })
    const list = await lib.list('builtin-small')
    const builtin = list.filter((summary) => summary.source === 'builtin')
    expect(builtin.map((summary) => summary.id)).toEqual([...BUILTIN_PERSONA_ORDER])
    // activeId 只标记一个
    expect(builtin.filter((summary) => summary.active).map((summary) => summary.id)).toEqual(['builtin-small'])
  })

  it('每个人格 JSON 合法：提示词 200-500 字、含微信硬约束、8-12 条 examples', async () => {
    const lib = new PersonaLibrary({
      config: testConfig(),
      logger: new FakeLogger(),
      workspace: await tmpDir('builtin-fields'),
    })
    for (const id of BUILTIN_PERSONA_ORDER) {
      const pack = await lib.get(id)
      expect(pack, `缺少内置人格 ${id}`).not.toBeNull()
      if (!pack) continue
      expect(pack.version).toBe(2)
      expect(pack.id).toBe(id)
      expect(pack.name.length).toBeGreaterThan(0)
      expect(pack.avatar.length).toBeGreaterThan(0)
      expect(pack.style.length).toBeGreaterThan(0)
      expect(pack.description.length).toBeGreaterThan(0)
      expect(pack.author.length).toBeGreaterThan(0)
      expect(pack.packVersion.length).toBeGreaterThan(0)
      expect(pack.tags.length).toBeGreaterThan(0)
      expect(pack.catchphrases.length).toBeGreaterThanOrEqual(3)
      expect(pack.taboo.length).toBeGreaterThanOrEqual(4)
      expect(pack.source).toBe('builtin')

      const promptLength = Array.from(pack.systemPrompt).length
      expect(promptLength, `${id} 提示词过短`).toBeGreaterThanOrEqual(200)
      expect(promptLength, `${id} 提示词过长`).toBeLessThanOrEqual(500)
      for (const phrase of ['不自称 AI', '不客服腔', '短句口语']) {
        expect(pack.systemPrompt, `${id} 缺少约束「${phrase}」`).toContain(phrase)
      }
      expect(pack.examples.length).toBeGreaterThanOrEqual(8)
      expect(pack.examples.length).toBeLessThanOrEqual(12)
      for (const example of pack.examples) {
        expect(example.user.length).toBeGreaterThan(0)
        expect(example.reply.length).toBeGreaterThan(0)
      }
    }
  })

  it('DEFAULT_BUILTIN_DIR 指向插件包内 personas/builtin 目录', () => {
    const normalized = DEFAULT_BUILTIN_DIR.replace(/\\/gu, '/').replace(/\/+$/u, '')
    expect(normalized).toMatch(/\/personas\/builtin$/u)
    expect(normalized.split('/').slice(-2).join('/')).toBe('personas/builtin')
  })
})

/* ────────────────────────────── list / get / active ────────────────────────────── */

describe('list / get / activePack', () => {
  it('内置在前按固定排序，已安装同 id 覆盖内置，其余已安装按安装时间排序', async () => {
    let clock = 1000
    const env = await setupLibrary({
      builtinPacks: [makePack({ id: 'alpha', name: '甲' }), makePack({ id: 'beta', name: '乙' })],
      now: () => ++clock,
    })
    await env.lib.install(makePack({ id: 'custom-one', name: '自装一' }), 'local')
    await env.lib.install(makePack({ id: 'alpha', name: '甲（已安装覆盖）' }), 'local')
    await env.lib.install(makePack({ id: 'custom-two', name: '自装二' }), 'local')

    const list = await env.lib.list('alpha')
    expect(list.map((summary) => summary.id)).toEqual(['alpha', 'beta', 'custom-one', 'custom-two'])
    // 同 id 覆盖：名字来自已安装副本
    expect(byId(list, 'alpha')?.name).toBe('甲（已安装覆盖）')
    expect(byId(list, 'alpha')?.active).toBe(true)
    expect(byId(list, 'custom-one')?.active).toBe(false)
    // 内置条目 source 仍标记 builtin，已安装覆盖则是 local
    expect(byId(list, 'beta')?.source).toBe('builtin')
    expect(byId(list, 'alpha')?.source).toBe('local')
  })

  it('get 返回完整 v2 包；未知/非法 id 返回 null', async () => {
    const env = await setupLibrary({ builtinPacks: [makePack({ id: 'alpha', name: '甲' })] })
    const pack = await env.lib.get('alpha')
    expect(pack?.id).toBe('alpha')
    expect(pack?.name).toBe('甲')
    expect(await env.lib.get('missing')).toBeNull()
    expect(await env.lib.get('../alpha')).toBeNull()
    expect(await env.lib.get('ALPHA')).toBeNull()
    expect(await env.lib.get('')).toBeNull()
  })

  it('activeId / activePack / loadActivePack 跟随配置；activeId 为空返回 null', async () => {
    const env = await setupLibrary({
      builtinPacks: [makePack({ id: 'alpha', name: '甲' })],
      configMutate: (config) => {
        config.persona.activeId = 'alpha'
      },
    })
    expect(env.lib.activeId()).toBe('alpha')
    expect((await env.lib.activePack())?.id).toBe('alpha')

    const engine = await env.lib.loadActivePack()
    expect(engine).not.toBeNull()
    expect(engine?.name).toBe('甲')
    expect(engine?.examples).toEqual([{ user: '在吗', assistant: '在，咋了' }])
    expect(engine?.systemPrompt).toContain('说话风格：短句口语，冷幽默')

    const offEnv = await setupLibrary({
      builtinPacks: [],
      configMutate: (config) => {
        config.persona.activeId = ''
      },
    })
    expect(offEnv.lib.activeId()).toBe('')
    expect(await offEnv.lib.activePack()).toBeNull()
    expect(await offEnv.lib.loadActivePack()).toBeNull()
  })
})

/* ────────────────────────────── install ────────────────────────────── */

describe('install', () => {
  it('写入 <dataDir>/personas/<id>/pack.json 并能读回（含 installedAt）', async () => {
    const env = await setupLibrary({ now: () => 123456 })
    const summary = await env.lib.install(makePack({ id: 'new-pack', name: '新人格', source: 'market' }), 'local')
    expect(summary).toMatchObject({
      id: 'new-pack',
      name: '新人格',
      source: 'local',
      active: false,
      installedAt: 123456,
    })
    expect(await env.lib.isInstalled('new-pack')).toBe(true)

    const file = join(env.dataDir, 'personas', 'new-pack', 'pack.json')
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as PersonaPackV2
    expect(onDisk.id).toBe('new-pack')
    expect(onDisk.source).toBe('local')
    expect(onDisk.installedAt).toBe(123456)

    const loaded = await env.lib.get('new-pack')
    expect(loaded?.name).toBe('新人格')
    expect(loaded?.source).toBe('local')
  })

  it('同 id 重复安装 = 更新：installedAt 刷新、字段覆盖、目录不重复', async () => {
    let clock = 1000
    const env = await setupLibrary({ now: () => clock })
    const first = await env.lib.install(makePack({ id: 'same-id', name: '旧名字' }), 'local')
    expect(first.installedAt).toBe(1000)
    clock = 2000
    const second = await env.lib.install(makePack({ id: 'same-id', name: '新名字' }), 'local')
    expect(second.name).toBe('新名字')
    expect(second.installedAt).toBe(2000)
    expect((await env.lib.get('same-id'))?.name).toBe('新名字')
    expect(await readdir(join(env.dataDir, 'personas'))).toEqual(['same-id'])
  })

  it('安装时消毒 id 与来源：非法字符折叠、source 以参数为准', async () => {
    const env = await setupLibrary()
    const summary = await env.lib.install(makePack({ id: '  Built In Test!! ', name: '带空格' }), 'market')
    expect(summary.id).toBe('built-in-test')
    expect(summary.source).toBe('market')
    expect(await env.lib.isInstalled('built-in-test')).toBe(true)
    expect((await env.lib.get('built-in-test'))?.source).toBe('market')
  })

  it('拒绝非法 id、空提示词与非法来源', async () => {
    const env = await setupLibrary()
    await expect(env.lib.install(makePack({ id: '中文名字' }), 'local')).rejects.toThrow(/id 非法/u)
    await expect(
      env.lib.install(makePack({ id: 'ok-pack', systemPrompt: '', description: '' }), 'local'),
    ).rejects.toThrow(/缺少系统提示词/u)
    await expect(env.lib.install(makePack({ id: 'ok-pack' }), 'hack' as unknown as 'local')).rejects.toThrow(
      /来源非法/u,
    )
  })

  it('安装不成功时不留下半截目录/文件（非法包）', async () => {
    const env = await setupLibrary()
    await expect(env.lib.install(makePack({ id: 'bad-pack', systemPrompt: '', description: '' }), 'local')).rejects.toThrow()
    expect(await env.lib.isInstalled('bad-pack')).toBe(false)
    const personasDir = join(env.dataDir, 'personas')
    const dirs = await readdir(personasDir).catch(() => [] as string[])
    expect(dirs).toEqual([])
  })
})

/* ────────────────────────────── uninstall / export ────────────────────────────── */

describe('uninstall / exportPack', () => {
  it('卸载已安装人格；内置人格与不存在的 id 返回 false', async () => {
    const env = await setupLibrary({ builtinPacks: [makePack({ id: 'alpha', name: '甲' })] })
    await env.lib.install(makePack({ id: 'tmp-one', name: '临时' }), 'local')
    expect(await env.lib.uninstall('tmp-one')).toBe(true)
    expect(await env.lib.isInstalled('tmp-one')).toBe(false)
    expect(await env.lib.get('tmp-one')).toBeNull()

    // 内置只读：卸载返回 false 且内容仍在
    expect(await env.lib.uninstall('alpha')).toBe(false)
    expect(await env.lib.get('alpha')).not.toBeNull()
    expect(await env.lib.uninstall('not-exists')).toBe(false)
    expect(await env.lib.uninstall('../etc')).toBe(false)
    expect(await env.lib.uninstall('')).toBe(false)
  })

  it('exportPack 返回副本（修改不影响库），不存在返回 null', async () => {
    const env = await setupLibrary({ builtinPacks: [makePack({ id: 'alpha', name: '甲' })] })
    const exported = await env.lib.exportPack('alpha')
    expect(exported?.name).toBe('甲')
    if (!exported) throw new Error('unreachable')
    exported.name = '被改坏了'
    exported.examples.push({ user: 'x', reply: 'y' })
    const again = await env.lib.get('alpha')
    expect(again?.name).toBe('甲')
    expect(again?.examples.length).toBe(1)
    expect(await env.lib.exportPack('not-exists')).toBeNull()
  })
})

/* ────────────────────────────── 损坏容错 ────────────────────────────── */

describe('损坏数据容错', () => {
  it('内置 JSON 损坏只 warn 跳过，不影响其他人格', async () => {
    const env = await setupLibrary({ builtinPacks: [makePack({ id: 'good', name: '好的' })] })
    await writeFile(join(env.builtinDir, 'broken.json'), '{ 这不是 json', 'utf8')
    const list = await env.lib.list('')
    expect(list.map((summary) => summary.id)).toEqual(['good'])
    expect(env.logger.warnings().some((message) => message.includes('内置人格包损坏'))).toBe(true)
  })

  it('内置目录不存在时列表为空且 warn，不抛异常', async () => {
    const root = await tmpDir('missing-builtin')
    const logger = new FakeLogger()
    const lib = new PersonaLibrary({
      config: testConfig(),
      logger,
      workspace: root,
      builtinDir: join(root, 'none'),
    })
    expect(await lib.list('')).toEqual([])
    expect(logger.warnings().some((message) => message.includes('内置人格目录不存在'))).toBe(true)
  })

  it('已安装目录损坏 / 缺少 pack.json 时跳过并 warn', async () => {
    const env = await setupLibrary({ builtinPacks: [] })
    const installedRoot = join(env.dataDir, 'personas')
    await mkdir(join(installedRoot, 'bad-one'), { recursive: true })
    await writeFile(join(installedRoot, 'bad-one', 'pack.json'), '{oops', 'utf8')
    await mkdir(join(installedRoot, 'empty-dir'), { recursive: true })
    await env.lib.install(makePack({ id: 'good-one', name: '好的' }), 'local')

    const list = await env.lib.list('good-one')
    expect(list.map((summary) => summary.id)).toEqual(['good-one'])
    expect(list[0]?.active).toBe(true)
    expect(await env.lib.get('bad-one')).toBeNull()
    expect(env.logger.warnings().some((message) => message.includes('已安装人格包损坏'))).toBe(true)
  })
})

/* ────────────────────────────── importJson ────────────────────────────── */

describe('importJson / SillyTavern 兼容', () => {
  it('导入 PersonaPackV2 JSON 字符串，按本地来源安装', async () => {
    const env = await setupLibrary()
    const summary = await env.lib.importJson(JSON.stringify(makePack({ id: 'imported', name: '导入的' })))
    expect(summary.id).toBe('imported')
    expect(summary.source).toBe('local')
    expect((await env.lib.get('imported'))?.name).toBe('导入的')
  })

  it('导入 SillyTavern v2 角色卡：字段映射、中文名派生 card-<hash> id、追加微信约束', async () => {
    const env = await setupLibrary()
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '林小雨',
        description: '一个温柔的插画师。',
        personality: '安静、慢热、爱猫。',
        scenario: '住在杭州。',
        mes_example:
          '<START>\n{{user}}: 在吗\n{{char}}: 在的，咋啦\n<START>\n{{user}}: 吃了吗\n{{char}}: 吃了，你呢',
        tags: ['治愈', '日常'],
        creator: '阿桃',
        character_version: '1.2.0',
        avatar: 'xiaoyu.png',
      },
    }
    const summary = await env.lib.importJson(card)
    expect(summary.id).toMatch(/^card-[0-9a-f]{10}$/u)
    const pack = await env.lib.get(summary.id)
    expect(pack?.name).toBe('林小雨')
    expect(pack?.author).toBe('阿桃')
    expect(pack?.packVersion).toBe('1.2.0')
    expect(pack?.avatar).toBe('xiaoyu.png')
    expect(pack?.tags).toEqual(['治愈', '日常'])
    expect(pack?.systemPrompt).toContain('【角色设定】')
    expect(pack?.systemPrompt).toContain('安静、慢热、爱猫。')
    expect(pack?.systemPrompt).toContain('不自称 AI')
    expect(pack?.systemPrompt).toContain('不客服腔')
    expect(pack?.examples).toEqual([
      { user: '在吗', reply: '在的，咋啦' },
      { user: '吃了吗', reply: '吃了，你呢' },
    ])
    expect(pack?.source).toBe('local')
  })

  it('导入 SillyTavern v1 平铺卡片', async () => {
    const env = await setupLibrary()
    const summary = await env.lib.importJson({
      name: '老李',
      description: '退休教师，爱下棋。',
      mes_example: '{{user}}: 早\n{{char}}: 早啊',
    })
    expect(summary.id).toMatch(/^card-/u)
    const pack = await env.lib.get(summary.id)
    expect(pack?.name).toBe('老李')
    expect(pack?.examples).toEqual([{ user: '早', reply: '早啊' }])
  })

  it('mapSillyTavernCard 缺少角色信息时抛错', () => {
    expect(() => mapSillyTavernCard({ name: '' })).toThrow(/缺少 name/u)
    expect(() => mapSillyTavernCard({ name: '无描述' })).toThrow(/没有可用的 description/u)
  })

  it('导入非法内容抛中文错误', async () => {
    const env = await setupLibrary()
    await expect(env.lib.importJson('not json')).rejects.toThrow(/JSON 解析失败/u)
    await expect(env.lib.importJson({ foo: 'bar' })).rejects.toThrow(/id 非法/u)
    await expect(env.lib.importJson(123)).rejects.toThrow(/必须是 JSON 对象/u)
    expect(() => parsePersonaPack('')).toThrow(/内容为空/u)
  })
})

/* ────────────────────────────── toEnginePack ────────────────────────────── */

describe('toEnginePack', () => {
  it('合并风格/口头禅/禁忌段落，examples reply 映射为 assistant', async () => {
    const env = await setupLibrary({ builtinPacks: [makePack({ id: 'alpha', name: '甲' })] })
    const pack = makePack({
      id: 'engine-1',
      name: '引擎人格',
      systemPrompt: '基础提示词。',
      style: '冷幽默',
      catchphrases: ['确实', '行吧'],
      taboo: ['转账'],
      examples: [{ user: '在吗', reply: '在' }],
    })
    const engine = env.lib.toEnginePack(pack)
    expect(engine.name).toBe('引擎人格')
    expect(engine.systemPrompt).toContain('基础提示词。')
    expect(engine.systemPrompt).toContain('说话风格：冷幽默')
    expect(engine.systemPrompt).toContain('确实、行吧')
    expect(engine.systemPrompt).toContain('转账')
    expect(engine.examples).toEqual([{ user: '在吗', assistant: '在' }])
    expect(engine.sourceDir).toBe(resolve(env.dataDir, 'personas', 'engine-1'))

    // 内置来源的 sourceDir 指向内置目录
    const builtinPack = await env.lib.get('alpha')
    if (!builtinPack) throw new Error('unreachable')
    expect(env.lib.toEnginePack(builtinPack).sourceDir).toBe(resolve(env.builtinDir))
  })
})

/* ────────────────────────────── 构造默认值与 id 安全 ────────────────────────────── */

describe('构造参数 / 路径安全', () => {
  it('默认安装目录为 <workspace>/.dsh-wechat-persona/personas，内置目录为插件包默认', async () => {
    const root = await tmpDir('defaults')
    const lib = new PersonaLibrary({ config: testConfig(), logger: new FakeLogger(), workspace: root })
    expect(lib.installedRoot).toBe(resolve(root, '.dsh-wechat-persona', 'personas'))
    expect(lib.builtinRoot).toBe(DEFAULT_BUILTIN_DIR)
  })

  it('config.persona.dir / builtinDir 生效；dataDir 选项优先于默认值', async () => {
    const root = await tmpDir('configured')
    const configured = new PersonaLibrary({
      config: testConfig((config) => {
        config.persona.dir = 'custom/personas'
        config.persona.builtinDir = 'custom/builtin'
      }),
      logger: new FakeLogger(),
      workspace: root,
    })
    expect(configured.installedRoot).toBe(resolve(root, 'custom', 'personas'))
    expect(configured.builtinRoot).toBe(resolve(root, 'custom', 'builtin'))

    const withDataDir = new PersonaLibrary({
      config: testConfig(),
      logger: new FakeLogger(),
      workspace: root,
      dataDir: 'my-data',
    })
    expect(withDataDir.installedRoot).toBe(resolve(root, 'my-data', 'personas'))
  })

  it('sanitizePersonaId 折叠非法字符、截断 64；isValidPersonaId 严格校验', () => {
    expect(sanitizePersonaId('  My Persona!! ')).toBe('my-persona')
    expect(sanitizePersonaId('A_B-c')).toBe('a_b-c')
    expect(sanitizePersonaId('中文名字')).toBe('')
    expect(sanitizePersonaId('--x--')).toBe('x')
    expect(sanitizePersonaId('a'.repeat(80)).length).toBe(64)
    expect(sanitizePersonaId(123)).toBe('123')
    expect(sanitizePersonaId(undefined)).toBe('')

    expect(isValidPersonaId('builtin-small')).toBe(true)
    expect(isValidPersonaId('a_b-1')).toBe(true)
    expect(isValidPersonaId('-bad')).toBe(false)
    expect(isValidPersonaId('Bad')).toBe(false)
    expect(isValidPersonaId('has space')).toBe(false)
    expect(isValidPersonaId('../x')).toBe(false)
    expect(isValidPersonaId('')).toBe(false)
    expect(isValidPersonaId(undefined)).toBe(false)
  })

  it('路径穿越 id 在查询/卸载入口被挡住，内部路径计算越界直接抛错', async () => {
    const env = await setupLibrary()
    expect(await env.lib.get('../../etc/passwd')).toBeNull()
    expect(await env.lib.uninstall('../../evil')).toBe(false)
    const internals = env.lib as unknown as { installedDirOf(id: string): string }
    expect(() => internals.installedDirOf('..')).toThrow(/越界/u)
  })
})
