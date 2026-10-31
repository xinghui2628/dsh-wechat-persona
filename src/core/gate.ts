/**
 * 入站闸门：纯本地、同步、0 token 的第一道决策。
 *
 * 顺序（与需求约定一致，命中即返回）：
 * disabled -> breaker -> paused -> group-chat -> self-message -> 白名单
 * -> 空消息 -> 无意义(纯标点) -> 纯表情/非文本 -> 重复 -> 免打扰时段
 * -> 低活跃日/频控 -> 禁止话题。
 *
 * 两条重要约定：
 * - 所有 skip 分支**不产生任何状态副作用**（不改 seen/rate/paused…），方便上层
 *   重试与测试断言“被跳过就是被跳过”；
 * - 只有全部检查通过（skip:false）才写入去重指纹 `${contactId}:${message.id}`，
 *   并在指纹表超过 2000 条时清理过期（>6 小时）与最旧条目。
 *
 * /stop、/resume 命令由 engine 在调用本模块之前处理，这里不重复判断。
 */

import type { Decision, InboundMessage, RiskSignal, RuntimeState, SkipReason } from '../types.ts'
import type { WechatPersonaConfig } from '../config.ts'
import { formatHhMm } from '../util/time.ts'
import { checkRate } from './rate-limit.ts'
import { evaluateSchedule } from './schedule.ts'

/** 闸门入参。selfContactId 可选：传入时用于过滤“自己发的消息”。 */
export interface GateInput {
  message: InboundMessage
  config: WechatPersonaConfig
  state: RuntimeState
  now: number
  selfContactId?: string
}

/** 需要 engine 立即中断自动化的暂停/熔断信号。 */
export interface GateHalt {
  type: 'pause' | 'breaker'
  reason: string
  /** 仅 breaker 时有值（识别到的原始风控信号）。 */
  signal?: RiskSignal
}

/** 闸门结果：decision 为最终决策；halt 存在时 engine 应先处理 halt 再 return。 */
export interface GateResult {
  decision: Decision
  halt?: GateHalt
}

/** 去重指纹保留时长（超期在超出上限时清理）。 */
const SEEN_TTL_MS = 6 * 60 * 60 * 1000
/** 去重指纹上限。 */
const SEEN_MAX = 2000
/** 纯标点/空白消息（只算 P 类标点，不含 emoji 等 So 符号）。 */
const PUNCTUATION_ONLY = /^[\s\p{P}]+$/u
/** 纯 emoji 文本（含变体选择符/零宽连接符/键帽组合符）。 */
const EMOJI_ONLY = /^[\s\p{Extended_Pictographic}\uFE0F\u200D\u20E3]+$/u
/** 微信/QQ 的媒体占位符，如 [图片]、[表情]、[语音]。 */
const MEDIA_PLACEHOLDER = /\[[^\[\]]{1,12}\]/gu

/** 构造 skip 结果（detail 为空时不带该字段）。 */
function decide(reason: SkipReason, detail?: string): GateResult {
  return {
    decision: {
      skip: true,
      reason,
      ...(typeof detail === 'string' && detail !== '' ? { detail } : {}),
    },
  }
}

/** contactId/contactName 精确匹配白名单条目的 id/name/aliases。 */
function matchWhitelist(config: WechatPersonaConfig, contactId: string, contactName: string): boolean {
  const entries = Array.isArray(config?.whitelist) ? config.whitelist : []
  const id = typeof contactId === 'string' ? contactId.trim() : ''
  const name = typeof contactName === 'string' ? contactName.trim() : ''
  if (id === '' && name === '') return false
  for (const entry of entries) {
    if (!entry) continue
    const candidates = [entry.id, entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== '')
    if (candidates.length === 0) continue
    if (id !== '' && candidates.includes(id)) return true
    if (name !== '' && candidates.includes(name)) return true
  }
  return false
}

/** 非文本消息，或文本里只有 emoji/媒体占位符，都算“纯表情/非文本”。 */
function isPureStickerMessage(message: InboundMessage): boolean {
  if (message.kind !== 'text') return true
  const text = typeof message.text === 'string' ? message.text.trim() : ''
  if (text === '') return false
  const withoutPlaceholders = text.replace(MEDIA_PLACEHOLDER, '').trim()
  if (withoutPlaceholders === '') return true
  return EMOJI_ONLY.test(withoutPlaceholders)
}

/** 返回命中的禁止话题关键词；未命中返回 null。 */
function findForbiddenKeyword(text: string, config: WechatPersonaConfig): string | null {
  const keywords = Array.isArray(config?.safety?.forbiddenKeywords) ? config.safety.forbiddenKeywords : []
  for (const keyword of keywords) {
    if (typeof keyword !== 'string') continue
    const trimmed = keyword.trim()
    if (trimmed !== '' && text.includes(trimmed)) return trimmed
  }
  return null
}

/**
 * 记录已处理消息指纹（唯一副作用）。
 * 超出上限时先清理 >6 小时的旧指纹，再按时间淘汰最旧的，保证有界。
 */
function rememberFingerprint(state: RuntimeState, fingerprint: string, now: number): void {
  if (!state.seen || typeof state.seen !== 'object') state.seen = {}
  const seen = state.seen
  seen[fingerprint] = now
  const keys = Object.keys(seen)
  if (keys.length <= SEEN_MAX) return
  for (const key of keys) {
    const timestamp = seen[key]
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || now - timestamp > SEEN_TTL_MS) {
      delete seen[key]
    }
  }
  const remaining = Object.keys(seen)
  if (remaining.length <= SEEN_MAX) return
  remaining.sort((a, b) => (seen[a] ?? 0) - (seen[b] ?? 0))
  for (const key of remaining.slice(0, remaining.length - SEEN_MAX)) delete seen[key]
}

/**
 * 判断一条入站消息是否应该进入“调模型”流程。
 * 纯本地、同步、不联网、不写磁盘（只可能写内存里的 state.seen）。
 */
export function evaluateInbound(input: GateInput): GateResult {
  const { message, config, state, now } = input

  // 1) 总开关
  if (!config || config.enabled !== true) return decide('disabled', '插件未启用')

  // 2) 风控熔断（最高优先级：连暂停判断都让位给“立即中断”信号）
  if (state && state.breaker && state.breaker.tripped) {
    const reason = typeof state.breaker.reason === 'string' && state.breaker.reason !== '' ? state.breaker.reason : 'risk-control'
    return {
      decision: { skip: true, reason: 'breaker', detail: `风控熔断已触发（${reason}）` },
      halt: { type: 'breaker', reason },
    }
  }

  // 3) 暂停（手动 /stop 或禁止话题触发）。注意这里只 skip，不返回 halt：
  //    否则 engine 会把每条消息都当成新的风控事件去审计/通知。
  if (state && state.paused) {
    const reason = typeof state.pauseReason === 'string' && state.pauseReason !== '' ? state.pauseReason : ''
    return decide('paused', reason !== '' ? `引擎已暂停：${reason}` : '引擎已暂停')
  }

  // 4) 群聊不回复（通道层通常已过滤，这里兜底）
  if (!message || message.chatType !== 'single') return decide('group-chat', '群聊消息不回复')

  // 5) 自己发的消息不回复（通道传了 selfContactId 时生效）
  const selfContactId = typeof input.selfContactId === 'string' ? input.selfContactId.trim() : ''
  if (selfContactId !== '' && message.contactId === selfContactId) return decide('self-message', '自己的消息不回复')

  // 6) 白名单（只伺候主人允许的人）
  if (!matchWhitelist(config, message.contactId, message.contactName)) return decide('not-whitelisted', '不在白名单内')

  // 7) 空消息
  const text = typeof message.text === 'string' ? message.text.trim() : ''
  if (text === '') return decide('empty-message', '空消息')

  // 8) 无意义（纯标点/空白，如 "。。。"、"？"）
  if (PUNCTUATION_ONLY.test(text)) return decide('noise', '纯标点/空白消息')

  // 9) 纯表情/非文本（可配置为仍回复，例如主人喜欢回“？”）
  const ignorePureSticker = config.reply?.ignorePureSticker !== false
  if (ignorePureSticker && isPureStickerMessage(message)) {
    return decide('pure-sticker', message.kind === 'text' ? '纯表情消息' : `非文本消息（${message.kind}）`)
  }

  // 10) 重复消息（通道重投/通知重放）。只查已记录指纹，不在这里写入。
  const fingerprint = `${message.contactId}:${message.id}`
  if (state && state.seen && typeof state.seen === 'object' && Object.prototype.hasOwnProperty.call(state.seen, fingerprint)) {
    return decide('duplicate', `重复消息：${message.id}`)
  }

  // 11) 免打扰时段（作息表）
  const schedule = evaluateSchedule(config, now)
  if (!schedule.online) return decide('offline-hours', `当前 ${formatHhMm(now)} 不在在线时段`)

  // 12) 低活跃日 + 频控（低活跃日上限优先级最高）
  const counter = state && state.rate ? state.rate[message.contactId] : undefined
  const rateDecision = checkRate(config, counter, now, schedule.lowActivityDay)
  if (rateDecision.skip) return { decision: rateDecision }

  // 13) 禁止话题（转账/验证码/博彩…）：默认命中即暂停引擎等主人人工确认
  const forbidden = findForbiddenKeyword(text, config)
  if (forbidden !== null) {
    const result = decide('forbidden-content', `命中禁止话题「${forbidden}」`)
    if (config.safety?.pauseOnForbiddenInbound !== false) {
      return { decision: result.decision, halt: { type: 'pause', reason: `forbidden-content:${forbidden}` } }
    }
    return result
  }

  // 全部通过：记录去重指纹（唯一副作用）
  if (state) rememberFingerprint(state, fingerprint, now)
  return { decision: { skip: false } }
}
