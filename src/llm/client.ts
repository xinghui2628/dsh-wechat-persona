/**
 * LLM 客户端：把宿主 ctx.llm 的流式接口包成 LlmLike（单次补全 + usage 统计）。
 *
 * 只依赖结构化接口（不 import DSH 类型），这样引擎与测试不依赖宿主包。
 * 消息构造遵循 @deepseek-ai/dsh-llm 的 RequestMessage：
 * - 用户消息可以是 RequestUserInput（无 id/source）；
 * - assistant 历史必须带 id 与 source.kind='model'。
 */

import type { LlmLike, LlmMessage, LlmRequest, LlmResult, LlmUsage, Logger } from '../types.ts'
import { randomId } from '../util/misc.ts'

export interface HostTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface HostStreamChunk {
  type: string
  text?: string
  usage?: HostTokenUsage
  reason?: { kind?: string; failure?: { message?: string } }
}

export interface HostLlmStream {
  stream(options: Record<string, unknown>): AsyncIterable<HostStreamChunk>
}

export interface HostModelSelection {
  provider?: string
  model?: string
  reasoning?: string
}

export interface HostLlmOptions {
  llm: HostLlmStream
  /** 读取 DSH 当前默认模型（agentDefaultModel.currentSelection）。 */
  selection?: () => HostModelSelection | null | undefined
  logger: Logger
  fallbackProvider?: string
  fallbackModel?: string
}

const PROVIDER_FALLBACK = 'deepseek-account'
const MODEL_FALLBACK = 'deepseek-flash'

function toHostMessages(messages: LlmMessage[], provider: string, model: string): unknown[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: [{ type: 'text', text: message.text }] }
    }
    return {
      role: 'assistant',
      id: randomId('msg'),
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'model', provider, model },
    }
  })
}

export class HostLlm implements LlmLike {
  private readonly options: HostLlmOptions

  constructor(options: HostLlmOptions) {
    this.options = options
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const startedAt = Date.now()
    const selection = this.options.selection?.() ?? undefined
    const provider = selection?.provider ?? this.options.fallbackProvider ?? PROVIDER_FALLBACK
    const model = selection?.model ?? this.options.fallbackModel ?? MODEL_FALLBACK
    const hostOptions: Record<string, unknown> = {
      provider,
      model,
      system: request.system,
      messages: toHostMessages(request.messages, provider, model),
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    }
    if (request.reasoningEffort) hostOptions.reasoningEffort = request.reasoningEffort
    if (request.signal) hostOptions.signal = request.signal

    let text = ''
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 }
    let finishReason = 'stop'

    try {
      for await (const chunk of this.options.llm.stream(hostOptions)) {
        switch (chunk.type) {
          case 'text-delta':
            if (typeof chunk.text === 'string') text += chunk.text
            break
          case 'usage': {
            const raw = chunk.usage ?? {}
            usage.inputTokens = raw.inputTokens ?? usage.inputTokens
            usage.outputTokens = raw.outputTokens ?? usage.outputTokens
            if (raw.totalTokens !== undefined) usage.totalTokens = raw.totalTokens
            if (raw.cacheReadTokens !== undefined) usage.cacheReadTokens = raw.cacheReadTokens
            if (raw.cacheWriteTokens !== undefined) usage.cacheWriteTokens = raw.cacheWriteTokens
            break
          }
          case 'finish': {
            const kind = chunk.reason?.kind ?? 'stop'
            finishReason = kind
            if (kind === 'error' || kind === 'aborted') {
              const detail = chunk.reason?.failure?.message ?? kind
              throw new Error(`模型调用 ${kind}：${detail}`)
            }
            break
          }
          default:
            break
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.logger.warn('LLM 调用失败', message)
      throw error instanceof Error ? error : new Error(message)
    }

    if (usage.totalTokens === undefined) {
      usage.totalTokens = usage.inputTokens + usage.outputTokens
    }
    return {
      text: text.trim(),
      usage,
      finishReason,
      provider,
      model,
      durationMs: Date.now() - startedAt,
    }
  }
}
