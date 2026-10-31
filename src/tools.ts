/**
 * DSH 工具注册：把引擎的运维能力暴露给 agent/用户。
 *
 * 工具清单：
 * - wechat_persona_status       查看运行状态（通道、暂停、熔断、预算、今日统计）
 * - wechat_persona_pause        一键停止（暂停引擎并落盘）
 * - wechat_persona_resume       恢复（清熔断并重启通道）
 * - wechat_persona_send_test    向白名单联系人发一条测试消息（验证通道）
 * - wechat_persona_clear_memory 清空某联系人/全部记忆
 * - wechat_persona_clear_audit  清空本地审计日志
 *
 * 这里不 import 任何宿主包：用结构化的 ToolRegistry 接口（与 D:\dsh-plugins\computer
 * 的 host 工具写法一致），拿不到 tools 服务时静默跳过，绝不因为工具注册失败影响插件加载。
 */
import type { EngineStatus, SendResult } from './types.ts'
import { readService, type ServiceHost } from './util/host.ts'

/**
 * 工具层依赖的引擎能力（用接口而非具体类）：
 * - 正常路径由 PersonaEngine 实现；
 * - 插件 disabled 时由 index.ts 提供带“已禁用”提示的包装实现，保证工具仍可查询状态。
 */
export interface PersonaService {
  status(): Promise<EngineStatus>
  pause(reason: string): Promise<void>
  resume(): Promise<void>
  sendTest(contactId: string, text: string): Promise<SendResult>
  clearMemory(contactId?: string): Promise<void>
  clearAudit(): Promise<void>
}

interface JsonSchemaObject {
  type: 'object'
  additionalProperties?: boolean
  required?: string[]
  properties: Record<string, unknown>
}

interface ToolRegistration {
  name: string
  description: string
  parameters: JsonSchemaObject
  output: {
    schema: JsonSchemaObject
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

interface ToolRegistry {
  register: (definition: ToolRegistration) => unknown
}

interface HostContextLike {
  get?: (name: string) => unknown
  [key: string]: unknown
}

interface ToolLogger {
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
}

const NO_PARAMS: JsonSchemaObject = { type: 'object', additionalProperties: false, properties: {} }
const TEXT_OUTPUT: ToolRegistration['output']['schema'] = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
}

function textOutput(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function statusText(status: EngineStatus): string {
  const budget = status.budget
  const lines = [
    `微信分身状态：${status.paused ? '已暂停' : '运行中'}${status.pauseReason ? `（${status.pauseReason}）` : ''}`,
    `通道：${status.channelId} / ${status.channelState}${status.channelDetail ? ` / ${status.channelDetail}` : ''}`,
    `人格：${status.personaName}；在线时段：${status.online ? '是' : '否'}${status.lowActivityDay ? '（今日低活跃）' : ''}`,
    `熔断：${status.breaker.tripped ? `已触发（${status.breaker.reason ?? 'unknown'}，${new Date(status.breaker.at ?? 0).toISOString()}）` : '未触发'}`,
    `预算：${budget.spentTokens}/${status.budgetPhase === 'ok' ? '未超' : status.budgetPhase === 'draft' ? '草稿模式' : '已超限'}（日预算 ${budget.spentTokens} tokens 已用，今日模型调用 ${status.today.llmCalls} 次 / ${status.today.llmTokens} tokens，缓存命中 ${status.today.cacheReadTokens}）`,
    `今日：发送 ${status.today.sends} 条 / 草稿 ${status.today.drafts} 条 / 搜索 ${status.today.searches} 次 / 跳过 ${Object.values(status.today.skips).reduce((n, v) => n + v, 0)} 次`,
    `联系人：${status.contacts} 个；累计模型调用 ${status.stats.llmCalls} 次，累计发送 ${status.stats.sends} 条`,
  ]
  return lines.join('\n')
}

function describeSend(result: SendResult): string {
  return result.ok ? '已发送' : `发送失败：${result.error ?? 'unknown'}`
}

/**
 * 注册全部运维工具。返回成功注册数量。
 * 传入 logger 用于注册失败降级告警（宿主 ctx.logger 可能不存在，由调用方兜底）。
 */
export function registerPersonaTools(ctx: HostContextLike, engine: PersonaService, logger: ToolLogger): number {
  const tools = readService<ToolRegistry>(ctx as unknown as ServiceHost, 'tools')
  if (!tools || typeof tools.register !== 'function') {
    logger.warn('tools 服务不可用，微信分身运维工具未注册（插件功能不受影响）')
    return 0
  }

  const definitions: ToolRegistration[] = [
    {
      name: 'wechat_persona_status',
      description:
        '查看 dsh-wechat-persona（微信小号 AI 分身）的运行状态：通道、暂停/熔断、token 预算与今日统计。排查“为什么没回复”时先调它。',
      parameters: NO_PARAMS,
      output: {
        schema: TEXT_OUTPUT,
        render: (_args, value) => textOutput(asString(asRecord(value).text)),
      },
      async execute(): Promise<unknown> {
        return { text: statusText(await engine.status()) }
      },
    },
    {
      name: 'wechat_persona_pause',
      description: '一键停止微信分身：暂停回复引擎（保留状态，重启后仍暂停），用于紧急止损。恢复请用 wechat_persona_resume。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: { type: 'string', description: '暂停原因（写入审计日志），默认 user-request' },
        },
      },
      output: {
        schema: TEXT_OUTPUT,
        render: (_args, value) => textOutput(asString(asRecord(value).text)),
      },
      async execute(args): Promise<unknown> {
        const reason = asString(asRecord(args).reason) || 'user-request'
        await engine.pause(reason)
        return { text: `已暂停微信分身（原因：${reason}）。` }
      },
    },
    {
      name: 'wechat_persona_resume',
      description:
        '恢复微信分身：清除暂停与风控熔断状态并尝试重启通道。注意：出现验证码/异常登录/限制提示后，必须人工在微信客户端确认安全再恢复。',
      parameters: NO_PARAMS,
      output: {
        schema: TEXT_OUTPUT,
        render: (_args, value) => textOutput(asString(asRecord(value).text)),
      },
      async execute(): Promise<unknown> {
        await engine.resume()
        const status = await engine.status()
        return { text: `已恢复微信分身。\n通道：${status.channelId}/${status.channelState}` }
      },
    },
    {
      name: 'wechat_persona_send_test',
      description: '向白名单联系人发送一条测试文本，用于验证通道是否可用（不会触发 LLM 生成）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['contactId', 'text'],
        properties: {
          contactId: { type: 'string', description: '白名单联系人的 id 或名称（见配置 whitelist）' },
          text: { type: 'string', description: '要发送的文本（建议 60 字以内）' },
        },
      },
      output: {
        schema: TEXT_OUTPUT,
        render: (_args, value) => textOutput(asString(asRecord(value).text)),
      },
      async execute(args): Promise<unknown> {
        const data = asRecord(args)
        const contactId = asString(data.contactId)
        const text = asString(data.text)
        if (!contactId || !text) return { text: '参数错误：contactId 与 text 必填。' }
        const result = await engine.sendTest(contactId, text)
        return { text: describeSend(result) }
      },
    },
    {
      name: 'wechat_persona_clear_memory',
      description: '清空微信分身的联系人记忆（JSON 存储）。不传 contactId 时清空全部联系人记忆，用于隐私清理。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          contactId: { type: 'string', description: '联系人 id；省略则清空全部' },
        },
      },
      output: {
        schema: TEXT_OUTPUT,
        render: (_args, value) => textOutput(asString(asRecord(value).text)),
      },
      async execute(args): Promise<unknown> {
        const contactId = asString(asRecord(args).contactId)
        await engine.clearMemory(contactId || undefined)
        return { text: contactId ? `已清空联系人 ${contactId} 的记忆。` : '已清空全部联系人记忆。' }
      },
    },
    {
      name: 'wechat_persona_clear_audit',
      description: '清空本地审计日志（messages 的 0-token 跳过原因、LLM token 用量、搜索与发送记录）。',
      parameters: NO_PARAMS,
      output: {
        schema: TEXT_OUTPUT,
        render: (_args, value) => textOutput(asString(asRecord(value).text)),
      },
      async execute(): Promise<unknown> {
        await engine.clearAudit()
        return { text: '已清空本地审计日志。' }
      },
    },
  ]

  let registered = 0
  for (const definition of definitions) {
    try {
      tools.register(definition)
      registered += 1
    } catch (error) {
      logger.warn(
        `工具注册失败（已跳过）：${definition.name}`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  return registered
}
