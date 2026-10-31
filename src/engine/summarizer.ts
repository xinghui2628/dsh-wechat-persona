/**
 * 长期记忆摘要：每 summaryEveryTurns 条消息触发一次，把「旧摘要 + 最近若干条」
 * 压成一段 ≤maxSummaryChars 的中文摘要。摘要本身也走 LLM，因此受预算与
 * 每日摘要次数限制约束（由 engine 检查后再调用）。
 */

import type { LlmLike, LlmUsage, MemoryMessage } from '../types.ts'

export interface SummarizeOptions {
  llm: LlmLike
  personaName: string
  contactName: string
  previousSummary: string
  messages: MemoryMessage[]
  maxSummaryChars: number
  signal?: AbortSignal
}

export interface SummarizeResult {
  summary: string
  usage: LlmUsage
  provider?: string
  model?: string
  durationMs?: number
}

const SUMMARIZER_SYSTEM = [
  '你是聊天记忆压缩器。把给定的微信聊天记录压缩成一段简短中文摘要，供以后继续聊天时参考。',
  '要求：',
  '- 只保留稳定事实与关系信息：对方称呼/身份线索、共同话题、约好的事、对方偏好与近况；',
  '- 不写寒暄、不复述原话、不评价、不推测；',
  '- 纯文本一段话，不要列表、不要标题、不要引号；',
  '- 不超过给定字数。',
].join('\n')

export async function summarizeMemory(options: SummarizeOptions): Promise<SummarizeResult | null> {
  const transcript = options.messages
    .slice(-40)
    .map((message) => `${message.role === 'user' ? '对方' : '我'}：${message.text}`)
    .join('\n')
  const userText = [
    `聊天对象：${options.contactName}`,
    options.previousSummary.trim() !== '' ? `已有摘要：${options.previousSummary.trim()}` : '已有摘要：（无）',
    '最近聊天记录：',
    transcript,
    `请输出不超过 ${options.maxSummaryChars} 字的新摘要。`,
  ].join('\n')

  try {
    const result = await options.llm.complete({
      system: SUMMARIZER_SYSTEM,
      messages: [{ role: 'user', text: userText }],
      temperature: 0.2,
      maxTokens: Math.max(120, Math.min(400, options.maxSummaryChars * 2)),
      reasoningEffort: 'low',
      signal: options.signal,
    })
    const summary = result.text.trim().replace(/^["'“”]|["'“”]$/g, '')
    if (summary === '') return null
    return {
      summary,
      usage: result.usage,
      provider: result.provider,
      model: result.model,
      durationMs: result.durationMs,
    }
  } catch {
    return null
  }
}
