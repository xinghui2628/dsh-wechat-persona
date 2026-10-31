/**
 * Cordis host 插件入口：把「宿主能力」（ctx.llm / ctx.web / ctx.tools / 工作区目录）
 * 装配成回复引擎 + 可插拔通道 + 本地审计/预算/风控，并提供 wechatPersona 服务与运维工具。
 *
 * 设计原则：
 * - 不 import 任何宿主包类型，只用结构化接口（真实 ctx 结构兼容即可），
 *   这样即使宿主类型包无法解析，插件也能独立编译；
 * - 装配失败、服务缺失、通道不可用都只降级 + 告警，绝不影响 DSH 主进程加载；
 * - 所有资源注册包在 ctx.effect 里，插件卸载/热重载时能干净停止通道与计时器；
 * - 默认 mock 通道 + 空白名单：安装即安全空转，不会碰真实微信；
 * - 数据目录在 boot 时才解析（此时 workingDirectory 服务已就绪），默认落在
 *   宿主默认工作区的 `.dsh-wechat-persona/`，失败时回退进程工作目录。
 */

import { isAbsolute, relative, resolve, join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { AuditLogLike, Channel, ConfigPersistenceInfo, FileStoreLike, Notifier, PersonaPack } from './types.ts'
import type { PersonaEngineLike } from './types.ts'
import type { WechatPersonaConfig } from './config.ts'
import type { EngineStatus, SendResult } from './types.ts'
import { Config, migrateConfig } from './config.ts'
import { createLogger } from './util/logger.ts'
import { FsStore } from './util/fs-store.ts'
import { mathRandom, systemClock } from './util/misc.ts'
import { AuditLog } from './core/audit.ts'
import { createInitialState, StateManager } from './core/state.ts'
import { MemoryStore } from './core/memory.ts'
import { createNotifier } from './core/notifier.ts'
import { loadPersona } from './core/persona.ts'
import { PersonaLibrary } from './core/persona-library.ts'
import { PersonaMarket } from './core/persona-market.ts'
import { StickerCatalog } from './core/stickers.ts'
import { HostLlm, type HostLlmStream, type HostModelSelection } from './llm/client.ts'
import { HostSearch, type HostWeb } from './llm/search.ts'
import { PersonaEngine } from './engine/engine.ts'
import { createChannel } from './channels/channel.ts'
import { readService, type ServiceHost } from './util/host.ts'
import { registerPersonaTools, type PersonaService } from './tools.ts'
import { API_PREFIX, attachPersonaRoutes, createPersonaApi, type PersonaApi, type PersonaWebServerLike } from './server/api.ts'

/* ────────────────────────── 宿主结构化接口（只取用到的部分） ────────────────────────── */

interface HostLoggerLike {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

interface HostContext {
  logger?: HostLoggerLike
  get?(name: string): unknown
  provide?(name: string, value: unknown): void
  effect?(fn: () => void | (() => void), label?: string): void
  on?(event: string, fn: (...args: unknown[]) => void): void
  /** Cordis 条件注入（形如 `ctx.inject(['webServer'], child => ...)`）。 */
  inject?(names: string[], fn: (child: ServiceHost) => void): unknown
  [key: string]: unknown
}

interface WorkingDirectoryService {
  defaultDirectory?: string
}

/** 宿主 configEditor 的 profile 条目形状（结构化，不 import 宿主包）。 */
interface HostConfigEntry {
  options?: { id?: string; name?: string; config?: unknown }
}

/** 宿主 configEditor 服务：用于把完整插件 Config 写回 profile patch。 */
interface HostConfigEditor {
  entries(): HostConfigEntry[]
  edit(entry: unknown, change: (current: unknown, inherited: unknown) => unknown): Promise<void>
}

/* ────────────────────────── 插件元信息 ────────────────────────── */

/** 插件版本（与 package.json 保持一致）。 */
const PLUGIN_VERSION = '0.2.8'

export const name = 'dsh-wechat-persona'

/** 提供给其它插件/UI 查询的服务名。 */
export const provide = ['wechatPersona']

export { Config }

/**
 * 不声明 inject：Cordis 的 inject 只接受 `string[]` 或 `{ 服务名?: 配置 }`，
 * 而本插件希望宿主服务缺失时也能降级加载，因此运行时用 readService 安全读取。
 */
export const inject: string[] = []

/* ────────────────────────── apply ────────────────────────── */

export function apply(ctx: HostContext, rawConfig: WechatPersonaConfig): void {
  // 配置迁移（旧版 → v2）：幂等；迁移日志只打印，不阻塞加载。
  const migrated = migrateConfig(rawConfig)
  const config = migrated.config
  const logger = createLogger(normalizeLogLevel(config.logging.level))
  if (migrated.changed && migrated.notes.length > 0) {
    logger.info(`配置已迁移：${migrated.notes.slice(0, 6).join('；')}`)
  }
  const host = ctx as unknown as ServiceHost
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const personaDir = (workspace: string): string =>
    config.reply.personaDir.trim() ? resolve(workspace, config.reply.personaDir) : resolve(packageRoot, 'persona')
  const stickersDir = resolve(packageRoot, 'stickers')

  const clock = systemClock
  const random = mathRandom

  let engine: PersonaEngine | null = null
  let booted = false
  let bootError: string | null = null
  let dataRoot = ''
  let store: FileStoreLike | null = null
  let audit: AuditLog | null = null
  let library: PersonaLibrary | null = null
  let market: PersonaMarket | null = null
  let stickersCatalog: StickerCatalog | null = null
  let memoryStore: MemoryStore | null = null
  let runtimeState: ReturnType<typeof createInitialState> = createInitialState(clock.now())
  let api: PersonaApi | null = null
  let disposeApiRoutes: (() => void) | null = null
  /** webServer 服务晚于插件 boot 就绪时，由 inject 回调暂存到这里。 */
  let lateWebServer: PersonaWebServerLike | null = null
  let persistInfo: ConfigPersistenceInfo = {
    editable: false,
    reason: '设置服务尚未就绪（插件仍在启动）',
  }

  /** 读取插件包内资源（文档/CHANGELOG），不存在或越界返回 null。 */
  const readAsset = async (rel: string): Promise<string | null> => {
    try {
      const target = resolve(packageRoot, rel)
      const inside = relative(packageRoot, target)
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null
      return await readFile(target, 'utf8')
    } catch {
      return null
    }
  }

  /**
   * 把完整配置写回 profile 的 cordis.patch.yml。
   * 走宿主 configEditor.edit：它负责校验、原子写、reconcile 与插件重载。
   */
  const saveConfig = async (next: WechatPersonaConfig): Promise<{ ok: boolean; error?: string }> => {
    const editor = readService<HostConfigEditor>(host, 'configEditor')
    if (!editor || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
      const reason = '宿主未提供 configEditor 服务，无法从设置界面保存配置；请直接编辑 profile 的 cordis.patch.yml'
      persistInfo = { editable: false, reason }
      return { ok: false, error: reason }
    }
    try {
      const entry = editor.entries().find((item) => {
        const id = item.options?.id
        const entryName = item.options?.name
        return (
          id === 'dsh-wechat-persona' ||
          entryName === 'dsh-wechat-persona' ||
          (typeof entryName === 'string' && entryName.includes('dsh-wechat-persona'))
        )
      })
      if (!entry) {
        const reason = '未在 profile 中找到 dsh-wechat-persona 配置条目'
        persistInfo = { editable: false, reason }
        return { ok: false, error: reason }
      }
      const snapshot = structuredClone(next) as unknown
      await editor.edit(entry, () => snapshot)
      persistInfo = { editable: true, lastSavedAt: clock.now() }
      logger.info('配置已保存，插件将按新配置重新加载')
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      persistInfo = { editable: true, lastSavedAt: persistInfo.lastSavedAt, lastError: message }
      logger.warn('保存配置失败', message)
      return { ok: false, error: message }
    }
  }


  /**
   * 挂载设置界面 HTTP API（幂等；依赖就绪前调用会直接跳过）。
   *
   * 宿主的 webServer 服务要等 webStartup 之后才可用，而 boot 是异步的，
   * 启动瞬间读到的 webServer 常常是 undefined；所以这里允许两次挂载：
   * boot 结束时试一次、ctx.inject(['webServer']) 回调再补一次。
   */
  const mountSettingsApi = (webServer: PersonaWebServerLike | null): void => {
    bootDebug(`mount: webServer=${!!webServer} register=${webServer ? typeof webServer.register : 'n/a'} deps=${!!library}/${!!stickersCatalog}/${!!memoryStore}`)
    if (!webServer || typeof webServer.register !== 'function') return
    if (!library || !stickersCatalog || !memoryStore) return
    try {
      if (!api) {
        api = createPersonaApi({
          version: PLUGIN_VERSION,
          getConfig: () => config,
          saveConfig,
          persist: () => persistInfo,
          getEngine: () => engine as unknown as PersonaEngineLike | null,
          personas: library,
          market: market!,
          stickers: stickersCatalog,
          memory: memoryStore,
          audit: audit!,
          state: () => runtimeState,
          clock,
          logger,
          asset: readAsset,
          dataDir: () => dataRoot,
        })
      }
      disposeApiRoutes?.()
      disposeApiRoutes = attachPersonaRoutes(webServer, api, logger)
      bootDebug(`attached ${API_PREFIX}`)
      logger.info(`设置界面 API 已注册：${API_PREFIX}`)
    } catch (error) {
      bootDebug(`attach failed: ${error instanceof Error ? error.message : String(error)}`)
      logger.error('挂载设置界面 API 失败', error instanceof Error ? error.message : String(error))
    }
  }


  /** 调试：把启动阶段的关键事实写到临时文件（设置页 404 排查用，稳定后可删）。 */
  const bootDebug = (message: string): void => {
    try {
      appendFileSync(join(tmpdir(), 'dsh-wechat-persona-debug.log'), `${new Date().toISOString()} ${message}\n`)
    } catch {
      // 调试日志失败不影响插件
    }
  }

  const notReadyStatus = (): EngineStatus => {
    const now = clock.now()
    const state = createInitialState(now)
    return {
      personaName: config.reply.personaName,
      channelId: config.activeChannel,
      channelState: config.enabled ? 'starting' : 'stopped',
      channelDetail: config.enabled ? (bootError ?? 'engine starting') : 'plugin disabled',
      paused: !config.enabled,
      pauseReason: config.enabled ? undefined : 'disabled',
      breaker: state.breaker,
      budget: state.budget,
      budgetPhase: 'ok',
      stats: state.stats,
      today: {
        dayKey: '',
        llmCalls: 0,
        llmTokens: 0,
        cacheReadTokens: 0,
        searches: 0,
        sends: 0,
        drafts: 0,
        skips: {},
      },
      contacts: 0,
      online: false,
      lowActivityDay: false,
      startedAt: now,
    }
  }

  const service: PersonaService = {
    async status(): Promise<EngineStatus> {
      if (engine) return engine.status()
      return notReadyStatus()
    },
    async pause(reason: string): Promise<void> {
      if (!engine) {
        logger.warn('引擎未启动，无法暂停')
        return
      }
      await engine.pause(reason.trim() || 'manual')
    },
    async resume(): Promise<void> {
      if (!engine) {
        logger.warn('引擎未启动，无法恢复')
        return
      }
      await engine.resume()
    },
    async sendTest(contactId: string, text: string): Promise<SendResult> {
      if (!engine) return { ok: false, error: 'engine not ready' }
      return engine.sendTest(contactId, text)
    },
    async clearMemory(contactId?: string): Promise<void> {
      if (engine) {
        await engine.clearMemory(contactId)
        return
      }
      if (memoryStore) {
        await memoryStore.clear(contactId)
      }
    },
    async clearAudit(): Promise<void> {
      if (!audit) return
      if (engine) {
        await engine.clearAudit()
        return
      }
      await audit.clear()
    },
  }

  // 先提供 service：即使引擎还在启动/降级，工具与其它插件也能查询状态。
  ;(ctx as { provide?: (name: string, value: unknown) => void }).provide?.('wechatPersona', service)

  // 运维工具（注册失败不影响引擎）
  try {
    const count = registerPersonaTools(ctx, service, logger)
    if (count > 0) logger.info(`已注册 ${count} 个运维工具`)
  } catch (error) {
    logger.warn('运维工具注册失败（已跳过）', error instanceof Error ? error.message : String(error))
  }

  const boot = async (): Promise<void> => {
    if (booted) return
    booted = true
    bootDebug('boot start')
    try {
      // ① 工作区与数据目录（即使引擎禁用也要就绪：设置界面与工具依赖）
      const workingDirectory = readService<WorkingDirectoryService>(host, 'workingDirectory')
      const workspace = workingDirectory?.defaultDirectory?.trim() || process.cwd()
      dataRoot = config.dataDir.trim() ? resolve(workspace, config.dataDir) : resolve(workspace, '.dsh-wechat-persona')
      store = new FsStore(dataRoot)
      audit = new AuditLog({
        store,
        enabled: config.logging.auditEnabled,
        logger,
        maxAuditMb: config.logging.maxAuditMb,
      })
      const notifier: Notifier = createNotifier({ store, logger, toast: true })
      const stateManager = new StateManager(store)

      const state = await stateManager.load(clock.now())
      runtimeState = state

      // 人格库（内置只读 + 已安装），人格市场（远程索引失败回退内置）
      library = new PersonaLibrary({ config, logger, dataDir: dataRoot })
      market = new PersonaMarket({ config, library, logger })
      const activePack = config.persona.enabled ? await library.loadActivePack(config.persona.activeId) : null
      if (activePack) {
        logger.info(`人格已加载：${activePack.name}（${config.persona.activeId}）`)
      } else {
        logger.warn(`人格库中找不到 ${config.persona.activeId}，回退旧版 persona 目录`)
      }
      const persona: PersonaPack =
        activePack ??
        (await loadPersona({ dir: personaDir(workspace), name: config.reply.personaName, logger }))

      // 表情包多来源：插件包内置（只读）+ 用户上传 + 当前人格自带
      stickersCatalog = new StickerCatalog({
        dirs: [
          { dir: stickersDir, origin: 'package' },
          { dir: resolve(dataRoot, 'stickers'), origin: 'uploaded' },
          { dir: resolve(dataRoot, 'personas', config.persona.activeId, 'stickers'), origin: 'persona' },
        ],
        random,
        logger,
      })
      const stickers = stickersCatalog
      await stickers.load()
      memoryStore = new MemoryStore({ store, config, clock, logger })
      const memory = memoryStore

      // ③ 设置界面 HTTP API：引擎未启动时也能查看状态 / 修改配置 / 管理人格与表情
      const webServer = readService<PersonaWebServerLike>(host, 'webServer')
      const configEditor = readService<HostConfigEditor>(host, 'configEditor')
      if (configEditor && typeof configEditor.entries === 'function') {
        const hasEntry = configEditor.entries().some((item) => {
          const id = item.options?.id
          const entryName = item.options?.name
          return (
            id === 'dsh-wechat-persona' ||
            entryName === 'dsh-wechat-persona' ||
            (typeof entryName === 'string' && entryName.includes('dsh-wechat-persona'))
          )
        })
        persistInfo = hasEntry
          ? { editable: true }
          : {
              editable: false,
              reason: 'profile 中暂未找到 dsh-wechat-persona 配置条目（可管理人格/表情与查看日志，但不能写回插件配置）',
            }
      } else {
        persistInfo = { editable: false, reason: '宿主未提供 configEditor 服务（当前 DSH 版本不支持从界面保存配置）' }
      }
      if (webServer && typeof webServer.register === 'function') {
        mountSettingsApi(webServer)
      } else if (lateWebServer) {
        // inject 回调比 boot 先到：用暂存的服务补挂
        mountSettingsApi(lateWebServer)
      } else {
        bootDebug('boot: no webServer yet')
        logger.warn('宿主 webServer 尚未就绪，等待注入回调后注册设置界面 API')
      }

      if (!config.enabled) {
        logger.info('插件已禁用（enabled=false），不启动回复引擎；设置界面仍可修改配置')
        return
      }

      // ④ 回复引擎
      const llmService = readService<HostLlmStream>(host, 'llm')
      if (!llmService || typeof llmService.stream !== 'function') {
        bootError = 'llm service unavailable'
        logger.warn('宿主 llm 服务不可用，回复引擎不启动（插件其余能力保持可用）')
        return
      }
      const channel: Channel = await createChannel(config, { clock, logger, store })

      const web = readService<HostWeb>(host, 'web')
      const search = config.search.enabled && web && typeof web.search === 'function' ? new HostSearch(web, config.search.maxResults) : null
      const agentDefaultModel = readService<{ currentSelection?(): HostModelSelection | null | undefined }>(
        host,
        'agentDefaultModel',
      )
      const selection = (): HostModelSelection | null => {
        try {
          return agentDefaultModel?.currentSelection?.() ?? null
        } catch {
          return null
        }
      }
      const llm = new HostLlm({ llm: llmService, selection, logger })

      engine = new PersonaEngine({
        config,
        logger,
        clock,
        random,
        store,
        channel,
        llm,
        search,
        notifier,
        state,
        audit: audit as unknown as AuditLogLike,
        memory,
        stickers,
        persona,
        saveState: () => stateManager.save(state),
      })
      await engine.start()
      logger.info(
        `微信小号人格分身已启动：通道=${channel.id}，在线时段=${config.schedule.onlineStart}-${config.schedule.onlineEnd}，` +
          `白名单=${config.whitelist.length} 人，数据目录=${dataRoot}`,
      )
    } catch (error) {
      bootError = error instanceof Error ? error.message : String(error)
      logger.error('回复引擎启动失败（插件继续运行，不影响宿主）', bootError)
      try {
        await audit?.record({ type: 'error', reason: 'boot-failed', detail: bootError.slice(0, 300) })
      } catch {
        // 审计失败不影响启动流程
      }
    }
  }

  const shutdown = async (): Promise<void> => {
    try {
      disposeApiRoutes?.()
    } catch (error) {
      logger.warn('卸载设置界面 API 路由失败', error instanceof Error ? error.message : String(error))
    }
    disposeApiRoutes = null
    api?.dispose()
    api = null
    const current = engine
    engine = null
    if (!current) return
    try {
      await current.stop()
    } catch (error) {
      logger.warn('引擎停止失败', error instanceof Error ? error.message : String(error))
    }
  }

  // 宿主的 webServer 服务要到 webStartup 之后才可用（dsh-wechat 同款 conditional-inject）。
  // 用 inject 回调拿到服务后补挂设置界面路由；即使回调早于 boot 完成，也会暂存等待。
  if (typeof ctx.inject === 'function') {
    bootDebug(`apply: inject available, registering webServer hook (ctx.get=${typeof ctx.get})`)
    try {
      ctx.inject(['webServer'], (httpCtx: ServiceHost) => {
        const ws = readService<PersonaWebServerLike>(httpCtx, 'webServer')
        bootDebug(`inject fired: webServer=${!!ws} register=${ws ? typeof ws.register : 'n/a'}`)
        if (!ws) return
        lateWebServer = ws
        mountSettingsApi(ws)
      })
    } catch (error) {
      bootDebug(`inject register failed: ${error instanceof Error ? error.message : String(error)}`)
      logger.warn('注册 webServer 注入回调失败', error instanceof Error ? error.message : String(error))
    }
  } else {
    bootDebug('apply: ctx.inject is not a function')
  }

  // DSH 插件卸载/热重载时清理引擎与通道。
  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => {
        void boot()
        return () => {
          void shutdown()
        }
      },
      'dsh-wechat-persona: engine',
    )
  } else {
    void boot()
    process.once('beforeExit', () => {
      void shutdown()
    })
  }
}

function normalizeLogLevel(level: string): 'debug' | 'info' | 'warn' | 'error' {
  return level === 'debug' || level === 'warn' || level === 'error' ? level : 'info'
}
