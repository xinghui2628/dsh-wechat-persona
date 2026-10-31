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
  SendResult,
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
  if (b.length >= 4 && (a.includes(b) || b.includes(a))) return true
  const head = Math.min(a.length, b.length, 12)
  if (head >= 4 && (a.startsWith(b.slice(0, head)) || b.startsWith(a.slice(0, head)))) return true
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
    await this.persist()
  }

  async stop(): Promise<void> {
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
    await this.audit({ type: 'stop', reason, detail: 'manual-pause' })
    await this.persist()
  }

  async resume(): Promise<void> {
    resumeEngine(this.deps.state, { clearBreaker: true })
    resetBreaker(this.deps.state)
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
    }
  }

  async clearMemory(contactId?: string): Promise<void> {
    await this.deps.memory.clear(contactId)
    await this.audit({ type: 'config', reason: 'memory-cleared', detail: contactId ?? 'all' })
  }

  async clearAudit(): Promise<void> {
    await this.deps.audit.clear()
  }

  /** 手动发一条测试消息（工具用；受通道能力限制）。 */
  async sendTest(contactId: string, text: string): Promise<SendResult> {
    const result = await this.deps.channel.send(contactId, { kind: 'text', text })
    await this.audit({
      type: result.ok ? 'send' : 'send-fail',
      contactId,
      send: { kind: 'text', chars: text.length, ok: result.ok, error: result.error },
    })
    return result
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
    await this.deps.clock.sleep(plan.typingMs)

    // 11) 发送（每个 part 最多重试 1 次；任何一条失败即中止本批，避免半截刷屏）
    let sent = 0
    let stickerSent: string | null = null
    for (let index = 0; index < planParts.length; index += 1) {
      const part = planParts[index] as OutboundPart
      if (index > 0) {
        await this.deps.clock.sleep(300 + Math.floor(this.deps.random.next() * 700))
      }
      const startedAt = clock.now()
      let sendResult: SendResult = { ok: false, error: 'not-sent' }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          sendResult = await channel.send(message.contactId, part)
        } catch (error) {
          sendResult = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        if (sendResult.ok) break
        await this.deps.clock.sleep(400 + Math.floor(this.deps.random.next() * 600))
      }
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
