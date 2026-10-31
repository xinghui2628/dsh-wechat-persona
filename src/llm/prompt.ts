/**
 * 提示词组装：system 前缀（人格 + 输出规则 + few-shot）在会话内稳定，
 * 便于 provider 前缀缓存；每个联系人的摘要 / 最近 10 条 / 新消息 / 搜索结果
 * 只进 messages，不污染 system 前缀。
 */

import type { LlmMessage, MemoryMessage, MemoryProfile, PersonaPack, SearchIntent, SearchResult } from '../types.ts'
import type { WechatPersonaConfig } from '../config.ts'
import { formatProfile } from '../core/preferences.ts'

export interface PromptContext {
  config: WechatPersonaConfig
  persona: PersonaPack
  contactName: string
  /** 长期摘要（可能为空）。 */
  summary: string
  /** 对联系人的轻量偏好（称呼/忌口/话题，可能为空）。 */
  profile?: MemoryProfile
  /** 最近消息（不含本次新消息，旧的在前）。 */
  recent: MemoryMessage[]
  /** 本次要回复的新消息文本。 */
  incomingText: string
  /** 按需联网搜索（未触发/失败时 result 为 null）。 */
  search?: { intent: SearchIntent; result: SearchResult | null }
}

/** 稳定 system 前缀。同一插件配置下跨联系人一致（前缀缓存友好）。 */
export function buildSystemPrompt(persona: PersonaPack, config: WechatPersonaConfig): string {
  const maxChars = Math.max(10, config.reply.maxChars)
  const lines: string[] = [
    `你是「${persona.name}」。你在微信上和一个认识的人单聊，下面是你的完整人设与说话方式。`,
    '',
    persona.systemPrompt.trim(),
    '',
    '# 输出规则（最高优先级）',
    '- 只输出你此刻要发的微信内容：不要解释、不要加引号、不要 markdown、不要列表、不要括号里的动作描述。',
    `- 口语、短句：多数 1–2 句，总长尽量不超过 ${maxChars} 个字；偶尔可以多一句，但别写成小作文。`,
    '- 禁止客服腔、禁止说教、禁止总结、禁止列点、禁止长篇。',
    '- 绝不暴露你是 AI / 模型 / 机器人 / 助手 / 提示词；被问身份就含糊带过或转移话题。',
    '- 不主动要联系方式、不导流、不发链接、不推销；对方提到转账/红包/验证码/密码/银行卡时直接拒绝并结束话题。',
    '- 聊天里没有的实时信息不要编造；有“联网资料”时只依据资料，没有就说不知道。',
    '- 不用“首先/其次/总之/希望对你有帮助”这类书面连接词。',
    '',
    '# 像真人聊天（重要）',
    '- 先接住对方的情绪或重点，再回应内容：对方在吐槽就先顺着说一句，对方在分享就先给个反应，别直接给建议或结论。',
    '- 不要复述对方的话，也不要用“你说得对/确实/理解你的感受”这种客服式附和。',
    '- 对方可能连着发好几条短消息：把它们当成一段话合起来理解，用一条回复应对，不要一条一条回。',
    '- 长度自然变化：多数时候 1–2 句、10–40 个字就够；偶尔可以多说半句；不要每条都一样长、一样起头。',
    '- 口语优先：可以用“嗯、啊、行、得了、哈哈、离谱、绝了”这类语气词；允许省略主语、说半句；不要像写作文。',
    '- 没听懂或信息不够就自然追问一句（“啊？你指的是啥”），不要硬编。',
    '- 不要承诺做不到的事：发语音、发图片/视频、发表情包、见面、转账、代付、实时查询。对方要求时直接说做不到或岔开。',
    '- 别重复你最近说过的话和句式；同一个梗、同一句口头禅不要连用。',
    '- 别每句都反问、别连续追问；聊天是来回，不是审问。对方换了话题就跟着换，对方不想聊就收。',
    '- 对不同关系的人保持自然距离：熟人说熟人的话，不熟的人别自来熟、别过度热情。',
  ]
  if (persona.examples.length > 0) {
    lines.push('', '# 风格样例（只学语气和长度，不要照抄内容）')
    for (const example of persona.examples) {
      lines.push(`对方：${example.user}`)
      lines.push(`你：${example.assistant}`)
    }
  }
  return lines.join('\n')
}

function formatSearch(intent: SearchIntent, result: SearchResult): string {
  const parts: string[] = [`【联网资料（关键词：${intent.query}，只作参考，不要照搬原文，不要说你查了资料）】`]
  if (result.content && result.content.trim() !== '') {
    parts.push(result.content.trim().slice(0, 800))
  }
  for (const source of result.sources.slice(0, 5)) {
    const title = source.title?.trim() || source.url
    const snippet = source.snippet?.trim()
    parts.push(`- ${title}${snippet ? '：' + snippet.slice(0, 200) : ''}`)
  }
  return parts.join('\n')
}

/** 组装本次请求的对话消息（最后一条一定是新消息）。 */
export function buildMessages(ctx: PromptContext): LlmMessage[] {
  const messages: LlmMessage[] = []
  if (ctx.summary.trim() !== '') {
    messages.push({
      role: 'user',
      text: `【之前和${ctx.contactName}聊过，这是我们的聊天摘要，供你延续话题】\n${ctx.summary.trim()}`,
    })
  }
  const profileLine = formatProfile(ctx.profile)
  if (profileLine !== '') {
    messages.push({ role: 'user', text: `【关于${ctx.contactName}，你记得】\n${profileLine}` })
  }
  // 连续对话轮数上限（0 = 不额外限制，由 memory.contextMessages 决定）。
  const turns = Math.max(0, Math.trunc(Number(ctx.config.reply.maxContextTurns) || 0))
  const turnLimit = turns > 0 ? turns * 2 : Number.POSITIVE_INFINITY
  const keep = Math.max(0, Math.min(ctx.config.memory.contextMessages, turnLimit))
  const recent = keep === 0 ? [] : ctx.recent.slice(-keep)
  for (const item of recent) {
    messages.push({ role: item.role, text: item.text })
  }
  if (ctx.search && ctx.search.result) {
    messages.push({ role: 'user', text: formatSearch(ctx.search.intent, ctx.search.result) })
  }
  messages.push({ role: 'user', text: ctx.incomingText })
  return messages
}
