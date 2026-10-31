/**
 * 插件配置 schema（schemastery）+ 导出类型。
 *
 * 配置在 DSH 的「插件配置」页以表单呈现（字段 description 即表单说明），
 * 也可以直接写进 profile 的 cordis.patch.yml。所有数值在运行时还会做一次
 * 防御性 clamp（见各模块），schema 只是第一道闸。
 *
 * 安全默认值原则：
 * - 通道默认 mock（安装即空转，不碰真实微信）；
 * - desktop 通道默认关闭；
 * - 白名单为空 => 引擎不处理任何消息；
 * - 预算 / 在线时段 / 限频都有保守默认值。
 */

import z from '@deepseek-ai/schemastery'

export interface WhitelistEntry {
  /** 稳定标识：手机通道 = 微信备注名/昵称（必填，精确匹配）。 */
  id: string
  /** 展示名（日志用）。 */
  name: string
  /** 额外的匹配别名（手机通道通知标题可能显示昵称/备注）。 */
  aliases: string[]
  /** 备注，仅本机可见。 */
  note: string
}

export interface Point {
  x: number
  y: number
}

export interface WechatPersonaConfig {
  /** 总开关（关闭时插件不启动任何监听，工具返回停用提示）。 */
  enabled: boolean
  /** 通道选择：mock 空转 / 手机 adb / Windows 虚拟机 / 本机桌面自动化。 */
  activeChannel: 'mock' | 'phone-adb' | 'windows-vm' | 'desktop'
  /** 数据目录（记忆/状态/审计/草稿）。留空 = 工作区 .dsh-wechat-persona。 */
  dataDir: string
  /** 主人称呼（通知里用）。 */
  ownerName: string
  /** 白名单：只有这些联系人的单聊会被回复。 */
  whitelist: WhitelistEntry[]
  /** 只回白名单（默认 true；关闭后允许回复任意单聊，风险自担）。 */
  whitelistOnly: boolean

  /** 人格库（多套人格、切换、启停）。 */
  persona: {
    /** 当前启用的人格包 id；空字符串 = 关闭人格回复（本地拦截，0 token）。 */
    activeId: string
    /** 自定义人格根目录；留空 = <dataDir>/personas。 */
    dir: string
    /** 内置人格目录；留空 = 插件包内 personas/。 */
    builtinDir: string
    /** 人格功能总开关（false 时只记录不回复）。 */
    enabled: boolean
  }

  schedule: {
    /** 在线开始时间 HH:mm（本地时区）。 */
    onlineStart: string
    /** 在线结束时间 HH:mm；允许跨零点（如 22:00–02:00）。 */
    onlineEnd: string
    /** 工作日在线开始（留空回退 onlineStart）。 */
    workdayStart: string
    /** 工作日在线结束（留空回退 onlineEnd）。 */
    workdayEnd: string
    /** 周末在线开始（留空回退 onlineStart）。 */
    weekendStart: string
    /** 周末在线结束（留空回退 onlineEnd）。 */
    weekendEnd: string
    /** 低活跃日：1=周一 … 7=周日，0=不启用。 */
    lowActivityWeekday: number
    /** 在线时段外是否完全静默（false 仅供调试，不建议）。 */
    pauseOutsideHours: boolean
  }

  rateLimit: {
    /** 每个联系人每小时最多回复条数（按“回复批”计数）。 */
    perContactPerHour: number
    /** 每个联系人每天最多回复条数。 */
    perContactPerDay: number
    /** 同一联系人两次回复之间的最小间隔（秒）。 */
    minReplyIntervalSec: number
    /** 低活跃日每联系人额外收紧到的每日上限。 */
    lowActivityDailyLimit: number
  }

  reply: {
    /** 单条回复最大字符数（超出截断/分条）。 */
    maxChars: number
    /** 采样温度。 */
    temperature: number
    /** 思考等级（low 省 token，默认 low）。 */
    reasoningEffort: 'low' | 'medium' | 'high'
    /** 生成 token 上限（单次）。 */
    maxTokens: number
    /** 拆成多条发送的概率（0 表示永远整段发）。 */
    splitProbability: number
    /** 最多拆几条（2–3）。 */
    maxSplitParts: number
    /** 追加表情包的概率（0 关闭）。 */
    stickerProbability: number
    /** 最近 N 次不允许重复同一个表情包。 */
    stickerNoRepeatCount: number
    /** “正在输入”最短时长（毫秒）。 */
    typingMinMs: number
    /** “正在输入”最长时长（毫秒）。 */
    typingMaxMs: number
    /** 纯表情包消息是否忽略（不调用模型）。 */
    ignorePureSticker: boolean
    /** 是否回复群聊（默认关闭；开启前请确认合规）。 */
    groupChatEnabled: boolean
    /** 是否回复单聊（默认开启）。 */
    privateChatEnabled: boolean
    /** 连续对话轮数上限：上下文最多带多少轮（0=由 memory.contextMessages 决定）。 */
    maxContextTurns: number
    /** 人格目录（绝对路径）；留空 = 插件自带 persona/（旧字段，保留兼容）。 */
    personaDir: string
    /** 人格名（审计与日志用，旧字段，保留兼容）。 */
    personaName: string
  }

  /** 表情包（多来源：包内 + 上传目录 + 人格包）。 */
  stickers: {
    /** 表情包总开关。 */
    enabled: boolean
    /** 上传/自定义表情根目录；留空 = <dataDir>/stickers。 */
    dir: string
    /** 每条回复最多附几个表情（默认 1，防刷屏）。 */
    maxPerReply: number
  }

  memory: {
    /** 每个联系人保留的最近消息条数（硬性要求默认 30）。 */
    recentKeep: number
    /** 每次请求带上的最近消息条数（硬性要求默认 10）。 */
    contextMessages: number
    /** 每多少轮触发一次长期摘要压缩（默认 50）。 */
    summaryEveryTurns: number
    /** 是否自动摘要（false 时只存不压）。 */
    autoSummary: boolean
    /** 摘要最多字符数。 */
    maxSummaryChars: number
  }

  budget: {
    /** 每日 token 预算（默认 5 万）。 */
    dailyTokens: number
    /** 已用比例达到该值切草稿模式（只生成不发）。 */
    draftModeRatio: number
    /** 每日摘要调用次数上限（摘要也花 token）。 */
    maxSummaryCallsPerDay: number
  }

  search: {
    /** 是否启用按需联网搜索。 */
    enabled: boolean
    /** 每日搜索次数上限。 */
    maxPerDay: number
    /** 每次搜索返回条数。 */
    maxResults: number
    /** 额外的触发关键词（内置规则之外）。 */
    extraKeywords: string[]
  }

  safety: {
    /** 禁止话题关键词：命中入站消息 => 暂停并通知（0 token）。 */
    forbiddenKeywords: string[]
    /** 风控关键词：命中通道文本 => 熔断暂停（默认已内置一套，追加用）。 */
    riskKeywords: string[]
    /** 入站命中禁止关键词时是否暂停自动化。 */
    pauseOnForbiddenInbound: boolean
    /** 不转账：命中转账/红包类请求时拒绝并通知。 */
    blockTransfers: boolean
    /** 不点陌生链接：入站含可疑链接时只记录不点击/不转发。 */
    blockSuspiciousLinks: boolean
    /** 风控熔断开关（验证码/异常登录仍会硬停；关闭只会放宽 spam-limit 类软风控）。 */
    circuitBreakerEnabled: boolean
  }

  /** 人格市场（远程索引可留空 = 只用内置人格）。 */
  market: {
    /** 远程索引 URL（JSON）；留空或加载失败时只用内置人格。 */
    indexUrl: string
    /** 只显示内置人格（不访问网络）。 */
    builtinOnly: boolean
    /** 拉取索引/人格包超时（毫秒）。 */
    timeoutMs: number
  }

  channels: {
    mock: {
      /** 测试用：入站消息 JSON 文件路径（相对 dataDir），留空不自动灌入。 */
      inboundFile: string
    }
    phoneAdb: {
      /** adb 可执行文件路径（留空 = PATH 里的 adb）。 */
      adbPath: string
      /** 设备 serial（多设备必填；留空用唯一设备）。 */
      serial: string
      /** 微信包名。 */
      packageName: string
      /** 通知轮询间隔（毫秒）。 */
      pollIntervalMs: number
      /** 中文输入方式：adb-keyboard = ADBKeyboard 广播；tap-keys = 逐字点击（慢，兜底）。 */
      inputMethod: 'adb-keyboard' | 'tap-keys'
      /** ADBKeyboard IME id。 */
      adbKeyboardIme: string
      /** 发送按钮坐标兜底（找不到 UIA 节点时使用）。 */
      sendButton: Point | null
      /** 表情面板按钮坐标兜底。 */
      stickerButton: Point | null
      /** 表情面板内表情格子坐标（按顺序点击）。 */
      stickerGrid: Point[]
      /** 是否允许截图（默认 false；只有需要 OCR/排障时开）。 */
      allowScreenshot: boolean
      /** 单次 adb 命令超时（毫秒）。 */
      commandTimeoutMs: number
    }
    windowsVm: {
      /** 虚拟机/独立会话里 agent 的 TCP 地址。 */
      host: string
      port: number
      /** 共享密钥（IPC 鉴权，必须与 agent 一致）。 */
      token: string
      connectTimeoutMs: number
      reconnectIntervalMs: number
    }
    desktop: {
      /** 桌面通道必须显式开启（默认关闭）。 */
      enabled: boolean
      /** 微信窗口标题子串。 */
      windowTitle: string
      /** 用户空闲多久才允许操作（毫秒）。 */
      userActivityIdleMs: number
      /** 检测到用户活动后让出时长（毫秒，默认 30 秒）。 */
      pauseSeconds: number
      /** 是否用 PowerShell UIA helper 驱动（关闭则禁用发送）。 */
      driverEnabled: boolean
    }
  }

  logging: {
    /** 是否写审计日志。 */
    auditEnabled: boolean
    /** 审计日志单文件上限（MB），超出滚动到 audit.1.jsonl。 */
    maxAuditMb: number
    /** 设置页“最近收发记录”展示条数（默认 50）。 */
    recentLimit: number
    level: 'debug' | 'info' | 'warn' | 'error' | 'silent'
  }
}

export const Config: z<WechatPersonaConfig> = z.object({
  enabled: z.boolean().default(true).description('插件总开关；关闭后不监听任何通道'),
  activeChannel: z.union([z.const('mock'), z.const('phone-adb'), z.const('windows-vm'), z.const('desktop')])
    .default('mock')
    .description('通道：mock=空转测试（安装默认）/ phone-adb=安卓手机（推荐）/ windows-vm=独立 Windows 会话 / desktop=本机桌面（默认关闭）'),
  dataDir: z.string().default('').description('数据目录（记忆/状态/审计）。留空 = 工作区下的 .dsh-wechat-persona'),
  ownerName: z.string().default('主人').description('通知中使用的称呼'),
  whitelist: z.array(z.object({
    id: z.string().default('').description('联系人精确标识（微信备注名/昵称，手机通道按通知标题匹配）'),
    name: z.string().default('').description('展示名（日志用）'),
    aliases: z.array(z.string()).default([]).description('额外匹配别名'),
    note: z.string().default('').description('本机备注，不发给对方'),
  })).default([]).description('白名单单聊联系人；为空时插件不回复任何人'),
  whitelistOnly: z.boolean().default(true).description('只回白名单（默认开；关闭后允许回复任意单聊，风险自担）'),

  persona: z.object({
    activeId: z.string().default('builtin-small').description('当前启用的人格包 id；留空 = 关闭人格回复'),
    dir: z.string().default('').description('自定义人格根目录；留空 = 数据目录下的 personas/'),
    builtinDir: z.string().default('').description('内置人格目录；留空 = 插件包内 personas/'),
    enabled: z.boolean().default(true).description('人格功能总开关'),
  }).default({} as WechatPersonaConfig['persona']),

  schedule: z.object({
    onlineStart: z.string().default('08:30').description('在线开始时间 HH:mm（本地时区）'),
    onlineEnd: z.string().default('23:00').description('在线结束时间 HH:mm；可跨零点，如 22:00–02:00'),
    workdayStart: z.string().default('').description('工作日在线开始（留空沿用 onlineStart）'),
    workdayEnd: z.string().default('').description('工作日在线结束（留空沿用 onlineEnd）'),
    weekendStart: z.string().default('').description('周末在线开始（留空沿用 onlineStart）'),
    weekendEnd: z.string().default('').description('周末在线结束（留空沿用 onlineEnd）'),
    lowActivityWeekday: z.number().default(1).description('每周低活跃日：1=周一 … 7=周日，0=不启用'),
    pauseOutsideHours: z.boolean().default(true).description('在线时段外完全静默（不生成不发送）'),
  }).default({} as WechatPersonaConfig['schedule']),

  rateLimit: z.object({
    perContactPerHour: z.number().default(10).description('每人每小时回复上限'),
    perContactPerDay: z.number().default(60).description('每人每天回复上限'),
    minReplyIntervalSec: z.number().default(30).description('同一联系人两次回复的最小间隔（秒）'),
    lowActivityDailyLimit: z.number().default(5).description('低活跃日每人每日回复上限'),
  }).default({} as WechatPersonaConfig['rateLimit']),

  reply: z.object({
    maxChars: z.number().default(60).description('单条回复最大字符数'),
    temperature: z.number().default(1.1).description('采样温度（真人聊天可略高）'),
    reasoningEffort: z.union([z.const('low'), z.const('medium'), z.const('high')]).default('low').description('思考等级，默认 low 省 token'),
    maxTokens: z.number().default(160).description('单次生成 token 上限'),
    splitProbability: z.number().default(0.35).description('拆成 2–3 条发送的概率'),
    maxSplitParts: z.number().default(2).description('最多拆成几条（2–3）'),
    stickerProbability: z.number().default(0.25).description('回复追加表情包的概率'),
    stickerNoRepeatCount: z.number().default(8).description('最近 N 次不重复同一表情包'),
    typingMinMs: z.number().default(800).description('“正在输入”最短毫秒数'),
    typingMaxMs: z.number().default(5000).description('“正在输入”最长毫秒数'),
    ignorePureSticker: z.boolean().default(true).description('纯表情包消息直接忽略（0 token）'),
    groupChatEnabled: z.boolean().default(false).description('是否回复群聊（默认关闭）'),
    privateChatEnabled: z.boolean().default(true).description('是否回复单聊'),
    maxContextTurns: z.number().default(6).description('连续对话轮数上限：上下文最多带几轮（0=用 memory.contextMessages）'),
    personaDir: z.string().default('').description('人格目录绝对路径；留空 = 插件自带 persona/（旧字段）'),
    personaName: z.string().default('小号').description('人格名（日志/审计用，旧字段）'),
  }).default({} as WechatPersonaConfig['reply']),

  stickers: z.object({
    enabled: z.boolean().default(true).description('表情包总开关'),
    dir: z.string().default('').description('上传/自定义表情根目录；留空 = 数据目录下 stickers/'),
    maxPerReply: z.number().default(1).description('每条回复最多附几个表情（防刷屏）'),
  }).default({} as WechatPersonaConfig['stickers']),

  memory: z.object({
    recentKeep: z.number().default(30).description('每联系人保留最近消息条数'),
    contextMessages: z.number().default(10).description('每次请求携带的最近消息条数'),
    summaryEveryTurns: z.number().default(50).description('每多少条消息触发一次长期摘要'),
    autoSummary: z.boolean().default(true).description('是否自动压缩长期摘要'),
    maxSummaryChars: z.number().default(400).description('长期摘要最大字符数'),
  }).default({} as WechatPersonaConfig['memory']),

  budget: z.object({
    dailyTokens: z.number().default(50000).description('每日 token 预算（默认 5 万）'),
    draftModeRatio: z.number().default(0.85).description('已用比例达到该值后切草稿模式（只生成不发）'),
    maxSummaryCallsPerDay: z.number().default(4).description('每日摘要调用次数上限'),
  }).default({} as WechatPersonaConfig['budget']),

  search: z.object({
    enabled: z.boolean().default(true).description('是否启用按需联网搜索'),
    maxPerDay: z.number().default(20).description('每日搜索次数上限'),
    maxResults: z.number().default(3).description('每次搜索返回条数'),
    extraKeywords: z.array(z.string()).default([]).description('额外触发搜索的关键词'),
  }).default({} as WechatPersonaConfig['search']),

  safety: z.object({
    forbiddenKeywords: z.array(z.string()).default([
      '转账', '红包', '收款', '付款', '验证码', '密码', '银行卡', '信用卡',
      '借条', '欠款', '中奖', '刷单', '杀猪盘', '博彩', '裸聊', '加密货币', 'USDT',
    ]).description('禁止话题关键词：命中后暂停自动化并通知主人（0 token）'),
    riskKeywords: z.array(z.string()).default([]).description('额外风控关键词（验证码/异常登录等已内置）'),
    pauseOnForbiddenInbound: z.boolean().default(true).description('入站命中禁止关键词时暂停'),
    blockTransfers: z.boolean().default(true).description('不转账：拒绝转账/红包类请求并通知'),
    blockSuspiciousLinks: z.boolean().default(true).description('不点陌生链接：可疑链接只记录不点击'),
    circuitBreakerEnabled: z.boolean().default(true).description('风控熔断开关（验证码/异常登录仍会硬停）'),
  }).default({} as WechatPersonaConfig['safety']),

  market: z.object({
    indexUrl: z.string().default('').description('远程人格索引 JSON URL；留空或失败时只用内置人格'),
    builtinOnly: z.boolean().default(false).description('只用内置人格（不访问网络）'),
    timeoutMs: z.number().default(8000).description('拉取索引/人格包超时（毫秒）'),
  }).default({} as WechatPersonaConfig['market']),

  channels: z.object({
    mock: z.object({
      inboundFile: z.string().default('').description('测试用：入站消息 JSON 文件（相对 dataDir）'),
    }).default({} as WechatPersonaConfig['channels']['mock']),
    phoneAdb: z.object({
      adbPath: z.string().default('').description('adb 路径；留空用 PATH'),
      serial: z.string().default('').description('设备 serial（多设备必填）'),
      packageName: z.string().default('com.tencent.mm').description('微信包名'),
      pollIntervalMs: z.number().default(3000).description('通知轮询间隔（毫秒）'),
      inputMethod: z.union([z.const('adb-keyboard'), z.const('tap-keys')]).default('adb-keyboard').description('中文输入方式'),
      adbKeyboardIme: z.string().default('com.android.adbkeyboard/.AdbIME').description('ADBKeyboard 输入法 id'),
      sendButton: z.union([z.object({ x: z.number().default(0), y: z.number().default(0) }), z.const(null)])
        .default(null).description('发送按钮兜底坐标'),
      stickerButton: z.union([z.object({ x: z.number().default(0), y: z.number().default(0) }), z.const(null)])
        .default(null).description('表情按钮兜底坐标'),
      stickerGrid: z.array(z.object({ x: z.number().default(0), y: z.number().default(0) }))
        .default([]).description('表情面板格子坐标（按顺序）'),
      allowScreenshot: z.boolean().default(false).description('允许截图（仅排障/OCR 时开）'),
      commandTimeoutMs: z.number().default(15000).description('单条 adb 命令超时（毫秒）'),
    }).default({} as WechatPersonaConfig['channels']['phoneAdb']),
    windowsVm: z.object({
      host: z.string().default('127.0.0.1').description('VM/独立会话 agent 地址'),
      port: z.number().default(47653).description('agent 端口'),
      token: z.string().default('').description('IPC 共享密钥（必须与 agent 一致）'),
      connectTimeoutMs: z.number().default(5000).description('连接超时（毫秒）'),
      reconnectIntervalMs: z.number().default(3000).description('断线重连间隔（毫秒）'),
    }).default({} as WechatPersonaConfig['channels']['windowsVm']),
    desktop: z.object({
      enabled: z.boolean().default(false).description('桌面通道总开关（默认关闭；必须显式开启）'),
      windowTitle: z.string().default('微信').description('微信窗口标题子串'),
      userActivityIdleMs: z.number().default(5000).description('用户键鼠空闲多久才允许操作（毫秒）'),
      pauseSeconds: z.number().default(30).description('检测到用户活动后的让出时长（秒）'),
      driverEnabled: z.boolean().default(false).description('是否启用 PowerShell UIA 驱动（关闭时只读不写）'),
    }).default({} as WechatPersonaConfig['channels']['desktop']),
  }).default({} as WechatPersonaConfig['channels']),

  logging: z.object({
    auditEnabled: z.boolean().default(true).description('写本地审计日志（可清空）'),
    maxAuditMb: z.number().default(10).description('审计日志单文件上限（MB）'),
    recentLimit: z.number().default(50).description('设置页“最近收发记录”展示条数'),
    level: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error'), z.const('silent')])
      .default('info').description('日志级别'),
  }).default({} as WechatPersonaConfig['logging']),
})

/**
 * 生成一份完整默认配置（用于测试与运行时兜底）。
 * schemastery 的 schema 可调用：Config({}) => 全部默认值。
 */
export function defaultConfig(): WechatPersonaConfig {
  const validation = Config as unknown as (value: unknown) => WechatPersonaConfig
  return validation({})
}

/**
 * 配置迁移（旧版本 → 当前版本）。幂等：已迁移过的配置再跑一次 changed=false。
 *
 * 迁移规则：
 * - 旧 `schedule.onlineStart/onlineEnd` → 工作日/周末时段（仅当新字段为空）；
 * - 补 `persona.activeId`（旧版没有多套人格概念）；
 * - 旧 `reply.personaDir` 存在且未设置人格时，记录一条提示（是否启用由用户决定）；
 * - 其余字段交给 schemastery 默认值（缺失补默认，多余字段保留）。
 */
export function migrateConfig(input: unknown): {
  config: WechatPersonaConfig
  changed: boolean
  notes: string[]
} {
  const notes: string[] = []
  const raw = (
    input && typeof input === 'object' && !Array.isArray(input) ? structuredClone(input) : {}
  ) as Record<string, unknown>
  const schedule = isRecord(raw.schedule) ? raw.schedule : ({} as Record<string, unknown>)
  const persona = isRecord(raw.persona) ? raw.persona : ({} as Record<string, unknown>)
  const reply = isRecord(raw.reply) ? raw.reply : ({} as Record<string, unknown>)
  let changed = false

  const onlineStart = typeof schedule.onlineStart === 'string' ? schedule.onlineStart : '08:30'
  const onlineEnd = typeof schedule.onlineEnd === 'string' ? schedule.onlineEnd : '23:00'
  // 只有“旧版配置”（完全没有工作日/周末字段）才把 onlineStart/End 迁移过去。
  // v2 配置里这些字段显式留空表示“沿用 onlineStart/End”，属于用户意图，不能覆盖。
  const hasV2Schedule = (['workdayStart', 'workdayEnd', 'weekendStart', 'weekendEnd'] as const).some(
    (key) => typeof schedule[key] === 'string',
  )
  for (const [key, fallback] of [
    ['workdayStart', onlineStart],
    ['workdayEnd', onlineEnd],
    ['weekendStart', onlineStart],
    ['weekendEnd', onlineEnd],
  ] as const) {
    if (!hasV2Schedule) {
      schedule[key] = fallback
      changed = true
      notes.push(`迁移：schedule.${key} 沿用 ${fallback}`)
    } else if (typeof schedule[key] !== 'string') {
      schedule[key] = ''
      changed = true
    }
  }
  if (typeof schedule.onlineStart !== 'string' || !schedule.onlineStart.trim()) {
    schedule.onlineStart = '08:30'
    changed = true
  }
  if (typeof schedule.onlineEnd !== 'string' || !schedule.onlineEnd.trim()) {
    schedule.onlineEnd = '23:00'
    changed = true
  }
  if (typeof persona.activeId !== 'string') {
    persona.activeId = 'builtin-small'
    changed = true
    notes.push('迁移：persona.activeId 补为 builtin-small')
  }
  if (typeof persona.enabled !== 'boolean') {
    persona.enabled = true
    changed = true
  }
  if (typeof raw.whitelistOnly !== 'boolean') {
    raw.whitelistOnly = true
    changed = true
    notes.push('迁移：whitelistOnly 补为 true')
  }
  if (typeof reply.groupChatEnabled !== 'boolean') {
    reply.groupChatEnabled = false
    changed = true
  }
  if (typeof reply.privateChatEnabled !== 'boolean') {
    reply.privateChatEnabled = true
    changed = true
  }
  if (typeof reply.maxContextTurns !== 'number' || reply.maxContextTurns < 0) {
    reply.maxContextTurns = 6
    changed = true
  }
  if (typeof reply.personaDir === 'string' && reply.personaDir.trim()) {
    notes.push('提示：旧字段 reply.personaDir 仍生效；建议在设置页改用人格库以支持多套人格')
  }

  raw.schedule = schedule
  raw.persona = persona
  raw.reply = reply
  const config = (Config as unknown as (value: unknown) => WechatPersonaConfig)(raw)
  return { config, changed, notes }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
