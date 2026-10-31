/**
 * 回复引擎：入站 → 本地 0-token 判断 →（命中才）搜索 / 模型 → 拟人化 → 发送 → 记账。
 *
 * 设计要点：
 * - 纯依赖注入（EngineDeps），不 import 宿主包；单元/集成测试用假 Clock/Random/LLM/
 *   Channel 就能证明验收标准（0 次 LLM 调用、10 秒内生成、预算、熔断…）；
 * - 所有入站消息串行处理（内部 promise 链），避免并发发送与状态竞争；
 * - 任何异常都被隔离在单条消息内，绝不让通道回调把宿主进程带崩；
 * - 每次关键状态变化都 saveState()，断线重启后能恢复暂停/熔断/预算状态。
 */

import type {
  EngineDeps,
  EngineStatus,
  InboundMessage,
  LlmRequest,
  LlmResult,
  MemoryMessage,
  MemoryProfile,
  OutboundPart,
  PersonaPack,
  RiskSignal,
  SendDelivery,
  SendResult,
  SkipReason,
  StickerCatalogLike,
} from '../types.ts'
import type { WechatPersonaConfig } from '../config.ts'
import { evaluateSchedule, nextOnlineAt } from '../core/schedule.ts'
import { evaluateInbound } from '../core/gate.ts'
import { addUsage, budgetPhase, normalizeBudget } from '../core/budget.ts'
import { checkRate, normalizeCounter, recordReply } from '../core/rate-limit.ts'
import { detectRisk, resetBreaker, tripBreaker } from '../core/breaker.ts'
import { isStopCommand, pauseEngine, resumeEngine } from '../core/stop.ts'
import { detectSearchIntent } from '../core/search-intent.ts'
import { detectEmotion } from '../core/emotion.ts'
import { clampText, planHumanReply } from '../core/humanize.ts'
import { extractPreferences } from '../core/preferences.ts'
import { buildMessages, buildSystemPrompt } from '../llm/prompt.ts'
import { summarizeMemory } from './summarizer.ts'
import { dayKey } from '../util/time.ts'

/** 模型输出清洗：去 markdown/引号/前缀，保留换行以便拆条。 */
export function sanitizeReply(text: string): string {
  let result = text.trim()
  result = result.replace(/^```[a-z]*\n?/i, '').replace(/```$/g, '').trim()
  result = result.replace(/^["'“”『』]+|["'“”『』]+$/g, '').trim()
  result = result.replace(/^(你|小号|我)[：:]\s*/u, '').trim()
  result = result.replace(/\*\*/g, '').replace(/`/g, '')
  result = result.replace(/\n{3,}/g, '\n\n').trim()
  return result
}

function matchWhitelist(config: WechatPersonaConfig, contactId: string, contactName: string): boolean {
  const id = contactId.trim()
  const name = contactName.trim()
  for (const entry of config.whitelist) {
    const candidates = [entry.id, entry.name, ...(entry.aliases ?? [])].map((item) => item.trim()).filter((item) => item !== '')
    if (candidates.includes(id) || (name !== '' && candidates.includes(name))) return true
  }
  return false
}

/** 归一化文本：去标点/空白，用于自回声比对。 */
function normalizeEchoText(text: unknown): string {
  return String(text ?? '').replace(/[\s，。！？、,.!?；;：:""''（）()【】\[\]…~～-]/g, '')
}

/** 暂停期间暂存入站消息的持久化文件（P1-4；不塞进 RuntimeState：state.ts 的白名单字段会丢弃新字段）。 */
const DEFERRED_FILE = 'deferred-inbound.json'
/** 暂存队列上限，避免长时间暂停把消息无限堆积在磁盘/内存。 */
const DEFERRED_MAX = 50

/** 一条暂停期间暂存、恢复后补处理的入站消息（持久化结构，需保持向后兼容）。 */
interface DeferredInboundEntry {
  message: InboundMessage
  deferredAt: number
  reason: string
}

interface DeferredStoreFile {
  version: 1
  entries: DeferredInboundEntry[]
}

/**
 * 旧版通道（PS1 未返回 delivery 字段）的错误语义推断（P0-2）：
 * 只有命中这些「发送前就失败」的原因，才能确定消息没有发出去、允许重试。
 * 反例（必须按 unknown 处理、绝不重试）：「快发送已回车但气泡未确认…」「发送后未在聊天区
 * 看到消息气泡…」「脚本异常…」——回车已按，重试可能造成同一条消息发两次。
 */
const NOT_SENT_ERROR_PATTERN =
  /已拒绝发送|已取消发送|已放弃发送|缺少聊天定位|无法确认目标聊天窗口|无法确认已打开|未启动|已禁用|已停止|空消息|发送文本为空|缺少 -?TextBase64|TextBase64 不是合法|无法确认用户键鼠空闲状态|暂停发送中|加载 Win32 封装失败|初始化 Windows OCR 失败|not-sent/

/** 把通道返回值归一化成投递三态：成功即 sent；未知/非法一律保守按 unknown。 */
export function resolveSendDelivery(result: SendResult): SendDelivery {
  if (result.ok) return 'sent'
  const delivery = result.delivery
  if (delivery === 'sent' || delivery === 'not-sent' || delivery === 'unknown') return delivery
  return 'unknown'
}

/** 是否允许重试：只有「确认没发出去」才重试，unknown 一律不重试（防重复发送，P0-2）。 */
export function canRetrySend(result: SendResult): boolean {
  if (result.ok) return false
  if (result.delivery !== undefined) return result.delivery === 'not-sent'
  const error = typeof result.error === 'string' ? result.error : ''
  if (error === '') return false
  return NOT_SENT_ERROR_PATTERN.test(error)
}

/** 发送门禁（P0-1 / P1-5）：任何一项不满足都不允许调用 channel.send。 */
interface SendBlock {
  reason: SkipReason
  detail: string
}

/**
 * 判断入站文本是不是机器人自己刚说过的话（通道回读造成）。
 * 列表预览会截断、OCR 会漏字认错字，所以整串之外还要比前缀/后缀与字符重合率。
 * 安全原则：宁可漏回一条，也不自问自答。
 */
function looksLikeOwnText(inbound: unknown, own: unknown): boolean {
  const a = normalizeEchoText(inbound)
  const b = normalizeEchoText(own)
  if (a.length < 2 || b.length < 2) return false
  if (a === b) return true
  // 短消息（≤4 字）只在完全相同才算回声：否则「大吧鱼」这种复述自己名字的短句
  // 会被「大吧鱼？我这名字还能被你叫歪…」里的包含关系误杀，导致正常消息不回。
  if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) return true
  const head = Math.min(a.length, b.length, 12)
  if (head >= 6 && (a.startsWith(b.slice(0, head)) || b.startsWith(a.slice(0, head)))) return true
  if (a.length >= 6 && b.length >= 6) {
    const chars = [...new Set(a)]
    const common = chars.filter((ch) => b.includes(ch)).length
    if (common / chars.length >= 0.6) return true
  }
  return false
}

export class PersonaEngine {
  private readonly deps: EngineDeps
  private started = false
  private chain: Promise<unknown> = Promise.resolve()
  /** 暂停/停止/熔断时打断在飞的拟人延迟与发送（P0-1）；恢复时换一个新的。 */
  private abortController = new AbortController()
  /** 暂停期间暂存、恢复后按序补处理的入站消息（P1-4）。 */
  private deferred: DeferredInboundEntry[] = []
  /** 暂存补处理的单飞锁，避免 start/resume 并发重放同一批消息。 */
  private flushTask: Promise<void> | null = null
  /** 发送尝试的投递三态计数（P0-2，随 status 暴露）。 */
  private readonly deliveryCounts = { sent: 0, notSent: 0, unknown: 0 }

  constructor(deps: EngineDeps) {
    this.deps = deps
  }

  /** 设置页切换人格后热更新（不必重载插件）。 */
  setPersona(pack: PersonaPack): void {
    this.deps.persona = pack
  }

  /** 上传/删除表情包后热更新表情目录。 */
  setStickers(catalog: StickerCatalogLike): void {
    this.deps.stickers = catalog
  }

  /* ────────────────────────── 生命周期 ────────────────────────── */

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.abortController = new AbortController()
    // 重启后先把上次暂停期间暂存的消息读回来（未暂停时下面直接补处理）。
    await this.loadDeferred()
    // P1-7：启动时若状态仍是暂停/熔断，绝不静默开始收消息/发消息；等主人显式 resume。
    // 只拦暂停/熔断：预算耗尽不应让通道永远起不来（次日预算会自动恢复）。
    const blocked = this.canSend({ checkBudget: false })
    if (blocked) {
      this.deps.logger.warn('启动时处于暂停/熔断状态，保持暂停不启动通道', `${blocked.reason}: ${blocked.detail}`)
      await this.audit({ type: 'start', reason: blocked.reason, detail: `blocked: ${blocked.detail}` })
      await this.persist()
      return
    }
    try {
      await this.deps.channel.start(
        (message) => {
          void this.handleInbound(message)
        },
        (signal) => {
          void this.handleRisk(signal)
        },
      )
      await this.audit({ type: 'start', detail: `channel=${this.deps.channel.id}` })
    } catch (error) {
      this.deps.logger.error('通道启动失败', error instanceof Error ? error.message : String(error))
      await this.audit({ type: 'error', reason: 'channel-start-failed', detail: String(error) })
    }
    await this.flushDeferred()
    await this.persist()
  }

  async stop(): Promise<void> {
    // 先中止在飞的拟人延迟/发送，再停通道，避免 stop 与发送竞争（P0-1）。
    this.abortController.abort()
    try {
      await this.deps.channel.stop()
    } catch (error) {
      this.deps.logger.warn('通道停止失败', error instanceof Error ? error.message : String(error))
    }
    this.started = false
    await this.audit({ type: 'stop', detail: 'engine-stop' })
    await this.persist()
  }

  async pause(reason: string): Promise<void> {
    pauseEngine(this.deps.state, reason, this.deps.clock.now())
    // P0-1：用户暂停时立即打断在飞的拟人延迟/发送，而不是等当前这条消息发完。
    this.abortController.abort()
    await this.audit({ type: 'stop', reason, detail: 'manual-pause' })
    await this.persist()
  }

  async resume(): Promise<void> {
    resumeEngine(this.deps.state, { clearBreaker: true })
    resetBreaker(this.deps.state)
    // 新的 AbortController：恢复后才允许新的发送任务。
    this.abortController = new AbortController()
    await this.audit({ type: 'resume' })
    if (this.started) {
      try {
        await this.deps.channel.start(
          (message) => {
            void this.handleInbound(message)
          },
          (signal) => {
            void this.handleRisk(signal)
          },
        )
      } catch (error) {
        this.deps.logger.warn('恢复后重启通道失败', error instanceof Error ? error.message : String(error))
      }
    }
    // P1-4：恢复后按序补处理暂停期间暂存的消息。
    await this.flushDeferred()
    await this.persist()
  }

  /* ────────────────────────── 对外查询 / 操作 ────────────────────────── */

  async status(): Promise<EngineStatus> {
    const { config, clock, state, channel, memory, audit, persona } = this.deps
    const now = clock.now()
    const schedule = evaluateSchedule(config, now)
    const budget = normalizeBudget(state.budget, now)
    let today: EngineStatus['today']
    try {
      today = await audit.summary()
    } catch {
      today = {
        dayKey: dayKey(now),
        llmCalls: 0,
        llmTokens: 0,
        cacheReadTokens: 0,
        searches: 0,
        sends: 0,
        drafts: 0,
        skips: {},
      }
    }
    let contacts = 0
    try {
      contacts = (await memory.listContacts()).length
    } catch {
      contacts = 0
    }
    const channelStatus = channel.status()
    return {
      personaName: persona.name,
      channelId: channel.id,
      channelState: channelStatus.state,
      channelDetail: channelStatus.detail ?? channelStatus.lastError,
      paused: state.paused,
      pauseReason: state.pauseReason,
      breaker: state.breaker,
      budget,
      budgetPhase: budgetPhase(config, budget, now),
      stats: state.stats,
      today,
      contacts,
      online: schedule.online,
      lowActivityDay: schedule.lowActivityDay,
      nextOnlineAt: nextOnlineAt(config, now),
      startedAt: state.stats.startedAt,
      lastActivityAt: state.lastActivityAt,
      delivery: { ...this.deliveryCounts },
      deferredCount: this.deferred.length,
    }
  }

  async clearMemory(contactId?: string): Promise<void> {
    await this.deps.memory.clear(contactId)
    await this.audit({ type: 'config', reason: 'memory-cleared', detail: contactId ?? 'all' })
  }

  async clearAudit(): Promise<void> {
    await this.deps.audit.clear()
  }

  /**
   * 手动发一条测试消息（工具 / 设置页用）。
   * P1-5：与自动发送共用同一套门禁（暂停 / 熔断 / 预算 / 白名单 / 频控），
   * 不再绕过引擎直接调用 channel.send。
   */
  async sendTest(contactId: string, text: string): Promise<SendResult> {
    const blocked = this.canSend({ contactId, checkWhitelist: true, checkRate: true })
    if (blocked) {
      this.deps.logger.warn('手动发送被门禁拒绝', `${blocked.reason}: ${blocked.detail}`)
      await this.audit({
        type: 'send-fail',
        contactId,
        reason: blocked.reason,
        send: {
          kind: 'text',
          chars: text.length,
          ok: false,
          error: `已拒绝发送：${blocked.detail}`,
          delivery: 'not-sent',
        },
      })
      return { ok: false, error: `已拒绝发送：${blocked.detail}`, delivery: 'not-sent' }
    }
    const startedAt = this.deps.clock.now()
    let result: SendResult
    try {
      result = await this.deps.channel.send(contactId, { kind: 'text', text }, this.abortController.signal)
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        delivery: 'unknown',
      }
    }
    const delivery = resolveSendDelivery(result)
    this.countDelivery(delivery)
    const delivered = delivery === 'sent'
    if (delivered) {
      const now = this.deps.clock.now()
      const counter = normalizeCounter(this.deps.state.rate[contactId], now)
      this.deps.state.rate[contactId] = recordReply(counter, now)
      this.deps.state.stats.sends += 1
      this.deps.state.lastActivityAt = now
    }
    await this.audit({
      type: delivered ? 'send' : 'send-fail',
      contactId,
      reason: delivered ? 'manual-send' : 'manual-send-failed',
      send: {
        kind: 'text',
        chars: text.length,
        ok: delivered,
        error: result.error,
        delivery,
        durationMs: this.deps.clock.now() - startedAt,
      },
    })
    await this.persist()
    return { ...result, ok: delivered, delivery }
  }

  /* ──────────────────────── 发送门禁 / 暂存补处理 ──────────────────────── */

  /**
   * 统一发送门禁（P0-1 / P1-5）：暂停、熔断、预算、白名单、频控任一不满足都拒绝发送。
   * 自动回复在拟人延迟后、每个 part 发出前、每次重试前调用；手动发送（sendTest）也走这里。
   */
  canSend(options: { contactId?: string; contactName?: string; checkWhitelist?: boolean; checkRate?: boolean; checkBudget?: boolean } = {}): SendBlock | null {
    const { config, state } = this.deps
    // 先看 AbortSignal：pause()/stop()/熔断会 abort，这是最实时的“已暂停”信号。
    if (this.abortController.signal.aborted) {
      return { reason: 'paused', detail: '引擎已暂停或停止，等待恢复后再发送' }
    }
    if (state.paused) {
      return { reason: 'paused', detail: `引擎已暂停${state.pauseReason ? `：${state.pauseReason}` : ''}` }
    }
    if (state.breaker.tripped) {
      return { reason: 'breaker', detail: `熔断已触发${state.breaker.reason ? `：${state.breaker.reason}` : ''}` }
    }
    const now = this.deps.clock.now()
    // 预算不阻碍 engine.start()：否则预算耗尽当次重启后通道永远起不来（次日也不会自愈）。
    if (options.checkBudget !== false && budgetPhase(config, normalizeBudget(state.budget, now), now) === 'exhausted') {
      return { reason: 'budget-hard-stop', detail: '今日 token 预算已用尽' }
    }
    const contactId = options.contactId?.trim()
    if (contactId && options.checkWhitelist) {
      if (!matchWhitelist(config, contactId, options.contactName ?? '')) {
        return { reason: 'not-whitelisted', detail: `联系人 ${contactId} 不在白名单内` }
      }
    }
    if (contactId && options.checkRate) {
      const counter = normalizeCounter(state.rate[contactId], now)
      const lowActivityDay = evaluateSchedule(config, now).lowActivityDay
      const decision = checkRate(config, counter, now, lowActivityDay)
      if (decision.skip) return { reason: decision.reason, detail: decision.detail ?? '触发发送频控' }
    }
    return null
  }

  /** 带 AbortSignal 的 sleep：暂停/停止时立即醒来，不把暂停拖到延迟结束（P0-1）。 */
  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    let onAbort: (() => void) | undefined
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => resolve()
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([this.deps.clock.sleep(ms, signal), aborted])
    } catch {
      // 打断 / 时钟异常不应让回复流程崩溃
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }

  private countDelivery(delivery: SendDelivery): void {
    if (delivery === 'sent') this.deliveryCounts.sent += 1
    else if (delivery === 'not-sent') this.deliveryCounts.notSent += 1
    else this.deliveryCounts.unknown += 1
  }

  /** 发送被门禁拦下：记 skip（区别于“发送失败”，不污染错误计数）。 */
  private async recordSendBlocked(message: InboundMessage, blocked: SendBlock, now: number): Promise<void> {
    this.deps.state.stats.skips += 1
    await this.audit({
      type: 'skip',
      contactId: message.contactId,
      contactName: message.contactName,
      msgId: message.id,
      reason: blocked.reason,
      detail: `send-blocked: ${blocked.detail}`,
      extra: { kind: message.kind, tokens: 0, at: now, sendBlocked: true },
    })
    await this.persist()
  }

  /** 暂停期间哪些消息需要暂存（P1-4）：白名单单聊（或关闭白名单限制的单聊）、显式放行的群聊。 */
  private shouldDeferWhilePaused(message: InboundMessage, fromWhitelist: boolean): boolean {
    const { config } = this.deps
    if (message.chatType === 'single') return fromWhitelist || config.whitelistOnly === false
    return fromWhitelist && config.reply.groupChatEnabled === true
  }

  /** 暂停期间把入站消息标记为 deferred 并持久化，恢复后按序补处理（P1-4）。 */
  private async deferInbound(message: InboundMessage, now: number, detail: string): Promise<void> {
    const exists = this.deferred.some(
      (entry) => entry.message.id === message.id && entry.message.contactId === message.contactId,
    )
    if (!exists) {
      this.deferred.push({ message, deferredAt: now, reason: detail })
      while (this.deferred.length > DEFERRED_MAX) this.deferred.shift()
      await this.saveDeferred()
    }
    this.deps.state.stats.skips += 1
    await this.audit({
      type: 'skip',
      contactId: message.contactId,
      contactName: message.contactName,
      msgId: message.id,
      reason: 'paused',
      detail: `deferred: ${detail}`,
      extra: { kind: message.kind, tokens: 0, at: now, deferred: true },
    })
    await this.persist()
  }

  private async saveDeferred(): Promise<void> {
    try {
      const payload: DeferredStoreFile = { version: 1, entries: this.deferred }
      await this.deps.store.writeJson(DEFERRED_FILE, payload)
    } catch (error) {
      this.deps.logger.warn('暂存入站消息落盘失败', error instanceof Error ? error.message : String(error))
    }
  }

  private async loadDeferred(): Promise<void> {
    try {
      const data = await this.deps.store.readJson<DeferredStoreFile>(DEFERRED_FILE)
      if (!data || !Array.isArray(data.entries)) return
      this.deferred = data.entries
        .filter(
          (entry): entry is DeferredInboundEntry =>
            Boolean(
              entry &&
                entry.message &&
                typeof entry.message.id === 'string' &&
                typeof entry.message.contactId === 'string' &&
                (entry.message.kind === 'text' || entry.message.kind === 'sticker'),
            ),
        )
        .slice(-DEFERRED_MAX)
    } catch (error) {
      this.deps.logger.warn('读取暂存入站消息失败', error instanceof Error ? error.message : String(error))
    }
  }

  /** 恢复后补处理暂存消息（单飞，避免 start/resume 并发重放）。 */
  private async flushDeferred(): Promise<void> {
    if (this.flushTask) return this.flushTask
    this.flushTask = this.flushDeferredInner().finally(() => {
      this.flushTask = null
    })
    return this.flushTask
  }

  private async flushDeferredInner(): Promise<void> {
    if (this.deferred.length === 0) return
    const entries = this.deferred.slice()
    this.deferred = []
    await this.saveDeferred()
    let blockedAt: number | null = null
    for (let index = 0; index < entries.length; index += 1) {
      // 补处理途中若再次暂停/熔断，剩余消息留在队列里等下次恢复。
      if (this.canSend()) {
        blockedAt = index
        break
      }
      await this.handleInbound(entries[index]!.message)
    }
    if (blockedAt !== null) {
      this.deferred = [...entries.slice(blockedAt), ...this.deferred]
      await this.saveDeferred()
    }
    await this.persist()
  }

  /* ────────────────────────── 风控熔断 ────────────────────────── */

  async handleRisk(signal: RiskSignal): Promise<void> {
    const { state, clock, notifier, channel, logger, config } = this.deps
    // 熔断开关关闭时：只记录 + 通知，不暂停、不停通道（由用户自行决定风险）。
    if (config.safety.circuitBreakerEnabled === false) {
      try {
        await this.audit({
          type: 'risk',
          reason: signal.kind,
          detail: `matched=${signal.matched}（熔断开关已关闭，未暂停）`,
          extra: { text: signal.text.slice(0, 120) },
        })
      } catch (error) {
        logger.warn('风控审计写入失败', String(error))
      }
      try {
        await notifier.notify(
          'warn',
          '微信风控提示（熔断已关闭）',
          `检测到「${signal.kind}」：${signal.text.slice(0, 80)}。熔断开关关闭，自动化未暂停，请尽快人工确认。`,
        )
      } catch (error) {
        logger.warn('风控通知失败', String(error))
      }
      return
    }
    tripBreaker(state, signal)
    // 立即暂停所有自动化：熔断标记 + 暂停状态，双重保障（任一被清掉也不会继续发消息）。
    pauseEngine(state, `risk:${signal.kind}`, clock.now())
    state.pausedAt = clock.now()
    // P0-1：熔断必须立刻打断在飞回复，不能等当前这条发完。
    this.abortController.abort()
    try {
      await this.audit({
        type: 'risk',
        reason: signal.kind,
        detail: `matched=${signal.matched}`,
        extra: { text: signal.text.slice(0, 120) },
      })
    } catch (error) {
      logger.warn('风控审计写入失败', String(error))
    }
    try {
      await channel.stop()
    } catch (error) {
      logger.warn('风控触发后停止通道失败', String(error))
    }
    try {
      await notifier.notify(
        'critical',
        '微信风控提示：自动化已暂停',
        `检测到「${signal.kind}」：${signal.text.slice(0, 80)}。请立即人工处理微信，确认安全后在插件工具中手动恢复。`,
      )
    } catch (error) {
      logger.warn('风控通知失败', String(error))
    }
    try {
      await this.persist()
    } catch (error) {
      logger.warn('风控状态落盘失败', String(error))
    }
    this.deps.logger.error('风控熔断已触发，所有自动化暂停', signal.kind)
  }

  /* ────────────────────────── 入站主流程 ────────────────────────── */

  handleInbound(message: InboundMessage): Promise<void> {
    const task = this.chain.then(
      () => this.process(message),
      () => this.process(message),
    )
    this.chain = task.catch(() => undefined)
    return task
  }

  private async process(message: InboundMessage): Promise<void> {
    try {
      await this.processInner(message)
    } catch (error) {
      this.deps.state.stats.errors += 1
      this.deps.logger.error('处理入站消息异常（已隔离）', error instanceof Error ? error.message : String(error))
      try {
        await this.audit({
          type: 'error',
          contactId: message.contactId,
          msgId: message.id,
          reason: 'engine-exception',
          detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        })
      } catch {
        // 审计失败不影响主流程
      }
      await this.persist()
    }
  }

  private async processInner(message: InboundMessage): Promise<void> {
    const { config, clock, state, memory, audit, channel } = this.deps
    const now = clock.now()
    const fromWhitelist = matchWhitelist(config, message.contactId, message.contactName)

    // 0) 人格停用 / 私聊开关
    if (config.persona.enabled === false || this.deps.persona.systemPrompt.trim() === '') {
      await this.skip(message, { skip: true, reason: 'persona-disabled' }, now)
      return
    }
    if (message.chatType === 'single' && config.reply.privateChatEnabled === false) {
      await this.skip(message, { skip: true, reason: 'private-chat-disabled' }, now)
      return
    }

    // 1) 群聊：默认关闭；显式开启且发送者在白名单内才放行（通道通常已过滤）
    if (message.chatType !== 'single') {
      if (!(config.reply.groupChatEnabled === true && fromWhitelist)) {
        await this.skip(message, { skip: true, reason: 'group-chat' }, now)
        return
      }
    }

    // 2) 聊天内 /stop（仅白名单联系人有效）
    if (fromWhitelist && isStopCommand(message.text)) {
      pauseEngine(state, 'chat-stop-command', now)
      state.pausedAt = now
      // P0-1：/stop 也要立刻打断当前在飞回复（生成完、拟人延迟中、发送循环中）。
      this.abortController.abort()
      await this.audit({ type: 'stop', contactId: message.contactId, reason: 'chat-stop-command', detail: message.text })
      await this.persist()
      return
    }

    // 2.5) 自回声保护：通道偶尔会把机器人自己的消息回读成入站（列表预览变化 / 窗口 OCR），
    // 如果拿它当新消息回复，就会越聊越嗨、自言自语。用最近对话里自己的话比对，命中就静默跳过。
    if (fromWhitelist && typeof memory.recent === 'function') {
      try {
        const recentTurns = await memory.recent(message.contactId, message.contactName, 12)
        const ownTurns = (recentTurns || []).filter((turn) => turn && turn.role === 'assistant').slice(-6)
        if (ownTurns.some((turn) => looksLikeOwnText(message.text, turn.text))) {
          this.deps.logger.debug?.(
            `[engine] 跳过自回声消息：${message.contactName} ${String(message.text).slice(0, 30)}`,
          )
          await this.skip(message, { skip: true, reason: 'self-echo' }, now)
          return
        }
      } catch {
        // 记忆读取失败不阻断正常回复流程
      }
    }

    // 3) 本地 0-token 判断
    // whitelistOnly=false 时允许非白名单的单聊（“只回白名单”开关）；不修改用户配置，
    // 只给本次判断临时追加一条白名单，保证本地规则引擎不需要知道这个开关。
    const gateConfig: WechatPersonaConfig =
      !fromWhitelist && config.whitelistOnly === false && message.chatType === 'single'
        ? {
            ...config,
            whitelist: [
              ...config.whitelist,
              { id: message.contactId, name: message.contactName, aliases: [], note: '' },
            ],
          }
        : config
    // 群聊显式放行时，本地规则仍按“单聊 + 发送者在白名单”判断，避免 gate 无条件拦群聊。
    const gateMessage: InboundMessage =
      message.chatType === 'single' ? message : { ...message, chatType: 'single' }
    const gate = evaluateInbound({ message: gateMessage, config: gateConfig, state, now })
    if (gate.halt) {
      const halt = gate.halt
      if (halt.type === 'breaker') {
        const signal: RiskSignal = halt.signal ?? {
          kind: 'unknown',
          text: halt.reason,
          matched: halt.reason,
          at: now,
        }
        await this.handleRisk(signal)
        return
      }
      pauseEngine(state, halt.reason, now)
      state.pausedAt = now
      // P0-1：命中禁止话题触发暂停时，同时打断在飞回复。
      this.abortController.abort()
      await this.audit({
        type: 'risk',
        contactId: message.contactId,
        reason: halt.reason,
        detail: message.text.slice(0, 120),
      })
      try {
        await this.deps.notifier.notify(
          'warn',
          '检测到敏感话题，已暂停自动化',
          `联系人「${message.contactName}」的消息命中禁止话题（${halt.reason}）。请人工查看后决定是否恢复。`,
        )
      } catch (error) {
        this.deps.logger.warn('敏感话题通知失败', String(error))
      }
      await this.persist()
      return
    }
    if (gate.decision.skip) {
      // P1-4：暂停期间白名单消息不丢——记 skip 的同时暂存，恢复后按序补处理。
      if (gate.decision.reason === 'paused' && this.shouldDeferWhilePaused(message, fromWhitelist)) {
        await this.deferInbound(message, now, gate.decision.detail ?? 'engine-paused')
        return
      }
      await this.skip(message, gate.decision, now)
      return
    }

    // 4) 预算：超限直接停
    state.budget = normalizeBudget(state.budget, now)
    if (budgetPhase(config, state.budget, now) === 'exhausted') {
      await this.skip(message, { skip: true, reason: 'budget-hard-stop' }, now)
      return
    }

    const lowActivityDay = evaluateSchedule(config, now).lowActivityDay
    const counter = normalizeCounter(state.rate[message.contactId], now)
    const rateDecision = checkRate(config, counter, now, lowActivityDay)
    if (rateDecision.skip) {
      await this.skip(message, rateDecision, now)
      return
    }

    // 5) 命中：按需联网搜索（失败降级）
    let searchForPrompt: { intent: ReturnType<typeof detectSearchIntent> & object; result: Awaited<ReturnType<NonNullable<EngineDeps['search']>['search']>> } | undefined
    for (;;) {
      const intent = config.search.enabled && this.deps.search ? detectSearchIntent(message.text, config) : null
      if (!intent) break
      if (state.stats.searchDayKey !== dayKey(now)) {
        state.stats.searchDayKey = dayKey(now)
        state.stats.searchDayCount = 0
      }
      if (state.stats.searchDayCount >= config.search.maxPerDay) break
      const startedAt = clock.now()
      try {
        const result = await this.deps.search!.search(intent.query)
        state.stats.searches += 1
        state.stats.searchDayCount += 1
        searchForPrompt = { intent, result }
        await this.audit({
          type: 'search',
          contactId: message.contactId,
          msgId: message.id,
          search: {
            query: intent.query,
            category: intent.category,
            sources: result.sources.length,
            ok: true,
            durationMs: clock.now() - startedAt,
          },
        })
      } catch (error) {
        state.stats.searches += 1
        state.stats.searchDayCount += 1
        await this.audit({
          type: 'search',
          contactId: message.contactId,
          msgId: message.id,
          search: { query: intent.query, category: intent.category, ok: false, durationMs: clock.now() - startedAt },
          detail: error instanceof Error ? error.message : String(error),
        })
        // 搜索失败降级：不阻断回复
      }
      break
    }

    // 6) 读记忆并组装上下文（新消息不进 recent，由 buildMessages 追加）
    const summary = await memory.summaryOf(message.contactId, message.contactName)
    const recent = await memory.recent(message.contactId, message.contactName, config.memory.contextMessages)
    await memory.append(message.contactId, message.contactName, {
      role: 'user',
      text: message.text,
      at: now,
    })

    // 6.1) 0-token 偏好提取：称呼/忌口/最近话题，只记有把握的（宁缺毋滥）
    const prefPatch = extractPreferences(message.text)
    if (Object.keys(prefPatch).length > 0 && typeof memory.mergeProfile === 'function') {
      try {
        await memory.mergeProfile(message.contactId, message.contactName, prefPatch, now)
      } catch (error) {
        this.deps.logger.debug('偏好提取落盘失败', String(error))
      }
    }
    let profile: MemoryProfile | undefined
    if (typeof memory.profileOf === 'function') {
      try {
        profile = await memory.profileOf(message.contactId, message.contactName)
      } catch {
        profile = undefined
      }
    }

    const system = buildSystemPrompt(this.deps.persona, config)
    const messages = buildMessages({
      config,
      persona: this.deps.persona,
      contactName: message.contactName,
      summary,
      profile,
      recent,
      incomingText: message.text,
      search: searchForPrompt ? { intent: searchForPrompt.intent, result: searchForPrompt.result } : undefined,
    })

    // 7) 调模型（失败重试 1 次；若当前模型不支持所选「思考等级」，自动降级后重试）
    let result: LlmResult | null = null
    let lastError: unknown = null
    let effort: LlmRequest['reasoningEffort'] = config.reply.reasoningEffort
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await this.deps.llm.complete({
          system,
          messages,
          temperature: config.reply.temperature,
          maxTokens: config.reply.maxTokens,
          ...(effort ? { reasoningEffort: effort } : {}),
        })
        break
      } catch (error) {
        lastError = error
        const detail = error instanceof Error ? error.message : String(error)
        // DSH 当前默认模型不一定支持 low/medium/high（例如 deepseek-flash 不支持 medium），
        // 被拒时去掉思考等级再试一次，避免用户选了「中/高」后完全不回消息。
        if (effort && /reasoning effort/i.test(detail)) {
          this.deps.logger.warn(`模型不支持思考等级「${effort}」，已自动降级重试`, detail.slice(0, 160))
          effort = undefined
        }
      }
    }
    if (!result) {
      state.stats.errors += 1
      await this.audit({
        type: 'error',
        contactId: message.contactId,
        msgId: message.id,
        reason: 'model-failed',
        detail: lastError instanceof Error ? lastError.message.slice(0, 300) : String(lastError).slice(0, 300),
      })
      await this.persist()
      return
    }

    // 8) token 记账
    const usage = result.usage
    const totalTokens = usage.totalTokens ?? usage.inputTokens + usage.outputTokens
    state.budget = addUsage(state.budget, usage, now)
    state.stats.llmCalls += 1
    state.stats.llmTokens += totalTokens
    await this.audit({
      type: 'llm',
      contactId: message.contactId,
      msgId: message.id,
      llm: {
        provider: result.provider,
        model: result.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        durationMs: result.durationMs,
        finishReason: result.finishReason,
      },
    })

    const reply = clampText(sanitizeReply(result.text), config.reply.maxChars)
    if (reply === '') {
      state.stats.errors += 1
      await this.audit({
        type: 'error',
        contactId: message.contactId,
        msgId: message.id,
        reason: 'empty-reply',
        detail: result.text.slice(0, 200),
      })
      await this.persist()
      return
    }

    // 9) 草稿模式：只生成不发（超预算也不发）
    const phase = budgetPhase(config, state.budget, now)
    if (phase === 'draft' || phase === 'exhausted') {
      state.stats.drafts += 1
      await this.deps.store.append(
        'drafts.jsonl',
        JSON.stringify({ ts: now, contactId: message.contactId, contactName: message.contactName, text: reply, totalTokens, phase }) + '\n',
      )
      await this.audit({
        type: 'draft',
        contactId: message.contactId,
        msgId: message.id,
        reason: phase === 'exhausted' ? 'budget-exhausted' : 'budget-draft',
        detail: reply.slice(0, 200),
      })
      await this.persist()
      return
    }

    // 10) 拟人化：随机正在输入 + 分条 + 表情包不重复
    const emotion = detectEmotion(reply)
    const recentStickerIds = await memory.lastStickerIds(message.contactId, message.contactName)
    // 降级：配置里关掉表情，或通道本身发不出表情（如桌面视觉通道）→ 概率置 0。
    const channelStickers = channel.capabilities?.stickers !== false
    const replyConfig: WechatPersonaConfig =
      config.stickers.enabled === false || !channelStickers
        ? { ...config, reply: { ...config.reply, stickerProbability: 0 } }
        : config
    const plan = planHumanReply(reply, {
      config: replyConfig,
      random: this.deps.random,
      stickers: this.deps.stickers,
      recentStickerIds,
      emotion,
    })
    // 每条回复最多发 maxPerReply 张表情（0 = 不发表情），避免连刷。
    const maxStickers = Math.max(0, Math.floor(Number(config.stickers.maxPerReply) || 0))
    let stickerCount = 0
    const planParts: OutboundPart[] = []
    for (const part of plan.parts as OutboundPart[]) {
      if (part.kind === 'sticker') {
        if (!channelStickers || stickerCount >= maxStickers) continue
        stickerCount += 1
      }
      planParts.push(part)
    }
    const sendSignal = this.abortController.signal
    // 拟人延迟也要能被打断：暂停/停止时立即醒来，不把暂停拖到延迟结束（P0-1）。
    await this.sleep(plan.typingMs, sendSignal)

    // 11) 发送
    //   P0-1：拟人延迟结束后、每个 part 发出前、每次重试前都重新过发送门禁
    //         （暂停/熔断/预算可能在“生成完 → 延迟中”发生）；
    //   P0-2：只有确认「没发出去」（delivery='not-sent'）才允许重试，unknown 绝不重试。
    //   任何一条发送失败即中止本批，避免半截刷屏。
    let sent = 0
    let stickerSent: string | null = null
    for (let index = 0; index < planParts.length; index += 1) {
      const part = planParts[index] as OutboundPart
      if (index > 0) {
        await this.sleep(300 + Math.floor(this.deps.random.next() * 700), sendSignal)
      }
      const preSend = this.canSend()
      if (preSend) {
        await this.recordSendBlocked(message, preSend, clock.now())
        break
      }
      const startedAt = clock.now()
      let sendResult: SendResult = { ok: false, error: 'not-sent', delivery: 'not-sent' }
      let blockedByGate = false
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // 每次真正调用通道前都复查门禁（重试可能跨越 pause/熔断）。
        const blocked = this.canSend()
        if (blocked) {
          sendResult = { ok: false, error: `send-blocked: ${blocked.detail}`, delivery: 'not-sent' }
          await this.recordSendBlocked(message, blocked, clock.now())
          blockedByGate = true
          break
        }
        try {
          sendResult = await channel.send(message.contactId, part, sendSignal)
        } catch (error) {
          // 异常时无法确认是否已发出 → unknown（不重试）。
          sendResult = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            delivery: 'unknown',
          }
        }
        const delivery = resolveSendDelivery(sendResult)
        this.countDelivery(delivery)
        if (sendResult.ok) break
        if (sendSignal.aborted) break
        if (attempt >= 1) break
        if (!canRetrySend(sendResult)) break
        await this.sleep(400 + Math.floor(this.deps.random.next() * 600), sendSignal)
      }
      if (blockedByGate) break
      if (sendResult.ok) {
        sent += 1
        if (part.kind === 'sticker') stickerSent = part.stickerId
        await this.audit({
          type: 'send',
          contactId: message.contactId,
          msgId: message.id,
          send: {
            kind: part.kind,
            chars: part.kind === 'text' ? part.text.length : undefined,
            stickerId: part.kind === 'sticker' ? part.stickerId : undefined,
            ok: true,
            delivery: 'sent',
            durationMs: clock.now() - startedAt,
          },
        })
      } else {
        state.stats.errors += 1
        await this.audit({
          type: 'send-fail',
          contactId: message.contactId,
          msgId: message.id,
          send: {
            kind: part.kind,
            chars: part.kind === 'text' ? part.text.length : undefined,
            stickerId: part.kind === 'sticker' ? part.stickerId : undefined,
            ok: false,
            error: sendResult.error,
            delivery: resolveSendDelivery(sendResult),
            durationMs: clock.now() - startedAt,
          },
        })
        break
      }
    }

    if (sent === 0) {
      await this.persist()
      return
    }

    // 12) 记账 + 记忆
    state.rate[message.contactId] = recordReply(counter, now)
    state.stats.sends += sent
    state.lastActivityAt = now
    await memory.append(message.contactId, message.contactName, { role: 'assistant', text: reply, at: now })
    if (stickerSent) await memory.rememberSticker(message.contactId, message.contactName, stickerSent)
    await this.persist()

    // 13) 长期摘要（每 N 条，受预算与每日摘要次数限制）
    await this.maybeSummarize(message.contactId, message.contactName, now)
  }

  /* ────────────────────────── 记忆摘要 ────────────────────────── */

  private async maybeSummarize(contactId: string, contactName: string, now: number): Promise<void> {
    const { config, state, memory, audit } = this.deps
    if (!config.memory.autoSummary) return
    let due = false
    try {
      due = await memory.shouldSummarize(contactId, contactName)
    } catch {
      return
    }
    if (!due) return
    if (budgetPhase(config, normalizeBudget(state.budget, now), now) !== 'ok') return
    const today = dayKey(now)
    if (state.stats.summaryDayKey !== today) {
      state.stats.summaryDayKey = today
      state.stats.summaryCalls = 0
    }
    if (state.stats.summaryCalls >= config.budget.maxSummaryCallsPerDay) return

    const previous = await memory.summaryOf(contactId, contactName)
    const messages = await memory.recent(contactId, contactName, Math.max(20, config.memory.recentKeep))
    const result = await summarizeMemory({
      llm: this.deps.llm,
      personaName: this.deps.persona.name,
      contactName,
      previousSummary: previous,
      messages,
      maxSummaryChars: config.memory.maxSummaryChars,
    })
    if (!result) return
    await memory.setSummary(contactId, contactName, result.summary)
    state.budget = addUsage(state.budget, result.usage, now)
    state.stats.summaryCalls += 1
    state.stats.llmCalls += 1
    state.stats.llmTokens += result.usage.totalTokens ?? result.usage.inputTokens + result.usage.outputTokens
    await this.audit({
      type: 'summary',
      contactId,
      llm: {
        provider: result.provider,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        durationMs: result.durationMs,
        finishReason: 'stop',
      },
      detail: result.summary.slice(0, 200),
    })
    await this.persist()
  }

  /* ────────────────────────── 内部工具 ────────────────────────── */

  private async skip(message: InboundMessage, decision: Extract<ReturnType<typeof evaluateInbound>['decision'], { skip: true }>, now: number): Promise<void> {
    this.deps.state.stats.skips += 1
    await this.audit({
      type: 'skip',
      contactId: message.contactId,
      contactName: message.contactName,
      msgId: message.id,
      reason: decision.reason,
      detail: decision.detail,
      extra: { kind: message.kind, tokens: 0, at: now },
    })
    await this.persist()
  }

  private async audit(event: Parameters<EngineDeps['audit']['record']>[0]): Promise<void> {
    try {
      await this.deps.audit.record(event)
    } catch (error) {
      this.deps.logger.warn('审计日志写入失败', error instanceof Error ? error.message : String(error))
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.saveState()
    } catch (error) {
      this.deps.logger.warn('状态落盘失败', error instanceof Error ? error.message : String(error))
    }
  }
}
