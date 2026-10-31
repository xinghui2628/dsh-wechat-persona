/**
 * client/lib.js 纯逻辑单测。
 *
 * 运行（项目根，Windows 沙箱需要 --import 预加载）：
 *   npm run test:sandbox -- test/client
 * 或：
 *   $env:NODE_OPTIONS='--import ./test/core/sandbox-preload.mjs'
 *   npx vitest run --pool=threads test/client
 */
import { describe, expect, it } from 'vitest'
import '../../client/lib.js'

const lib = (globalThis as any).DshWechatPersonaLib

describe('数值裁剪与格式化', () => {
  it('clampNumber / clampInt 处理非法值与越界', () => {
    expect(lib.clampNumber('12', 0, 10, 3)).toBe(10)
    expect(lib.clampNumber('-2', 0, 10, 3)).toBe(0)
    expect(lib.clampNumber('abc', 0, 10, 3)).toBe(3)
    expect(lib.clampNumber(undefined, 1, 5, 2)).toBe(2)
    expect(lib.clampInt('7.6', 0, 10, 0)).toBe(8)
  })

  it('格式化函数输出中文可读文本', () => {
    expect(lib.formatTokens(999)).toBe('999')
    expect(lib.formatTokens(1234)).toBe('1.2k')
    expect(lib.formatTokens(523456)).toBe('523k')
    expect(lib.formatTokens(2500000)).toBe('2.5M')
    expect(lib.formatDuration(800)).toBe('800 毫秒')
    expect(lib.formatDuration(1500)).toBe('2 秒')
    expect(lib.formatDuration(90000)).toBe('1 分 30 秒')
    expect(lib.formatDuration(3600000)).toBe('1 小时')
    expect(lib.formatUptime(65)).toBe('1 分 5 秒')
    expect(lib.formatBytes(2048)).toBe('2 KB')
    expect(lib.formatBytes(2 * 1024 * 1024)).toBe('2 MB')
    expect(lib.formatPercent(0.35)).toBe('35%')
    expect(lib.ratioToPercentText(0.355)).toBe('35.5')
    expect(lib.percentTextToRatio('35', 0)).toBeCloseTo(0.35)
    expect(lib.percentTextToRatio('oops', 0.5)).toBe(0.5)
  })
})

describe('时间与在线时段', () => {
  it('解析 / 规范 / 跨零点判断', () => {
    expect(lib.parseTimeToMinutes('08:30')).toBe(510)
    expect(lib.parseTimeToMinutes('8:5')).toBe(null)
    expect(lib.parseTimeToMinutes('24:00')).toBe(null)
    expect(lib.normalizeTime('8:05')).toBe('08:05')
    expect(lib.minutesToTime(510)).toBe('08:30')
    expect(lib.isWithinWindow(600, 510, 1380)).toBe(true)
    expect(lib.isWithinWindow(100, 510, 1380)).toBe(false)
    // 22:00–02:00 跨零点
    expect(lib.isWithinWindow(1380, 1320, 120)).toBe(true)
    expect(lib.isWithinWindow(60, 1320, 120)).toBe(true)
    expect(lib.isWithinWindow(600, 1320, 120)).toBe(false)
  })

  it('工作时段 / 周末空值回退到 onlineStart/onlineEnd', () => {
    const schedule = {
      onlineStart: '08:30',
      onlineEnd: '23:00',
      workdayStart: '09:00',
      workdayEnd: '18:00',
      weekendStart: '',
      weekendEnd: '',
    }
    expect(lib.resolveOnlineWindow(schedule, 3)).toMatchObject({ start: '09:00', end: '18:00', source: 'workday' })
    expect(lib.resolveOnlineWindow(schedule, 6)).toMatchObject({ start: '08:30', end: '23:00', source: 'default' })
    expect(lib.describeOnlineWindow(schedule, 3)).toBe('工作日 09:00–18:00')
    expect(lib.describeOnlineWindow(schedule, 0)).toBe('默认 08:30–23:00')
  })

  it('nextOnlineAt：在线中返回当前，否则返回下次开始时间', () => {
    const schedule = { onlineStart: '08:30', onlineEnd: '23:00' }
    const online = new Date(2026, 9, 30, 10, 0, 0) // 周五 10:00
    expect(lib.isOnlineNow(schedule, online)).toBe(true)
    expect(lib.nextOnlineAt(schedule, online).getTime()).toBe(online.getTime())

    const early = new Date(2026, 9, 30, 7, 0, 0)
    expect(lib.isOnlineNow(schedule, early)).toBe(false)
    const next = lib.nextOnlineAt(schedule, early)
    expect(next.getDate()).toBe(30)
    expect(next.getHours()).toBe(8)
    expect(next.getMinutes()).toBe(30)

    // 周末使用默认时段，次日（周六）08:30 仍是下次上线时间
    const late = new Date(2026, 9, 30, 23, 30, 0)
    const nextDay = lib.nextOnlineAt(schedule, late)
    expect(nextDay.getDate()).toBe(31)
    expect(nextDay.getHours()).toBe(8)
  })
})

describe('关键词 / 别名 / 白名单', () => {
  it('关键词与别名分隔、去重', () => {
    expect(lib.splitKeywords('转账, 红包；验证码\n转账、USDT')).toEqual(['转账', '红包', '验证码', 'USDT'])
    expect(lib.joinKeywords(['a', 'b'])).toBe('a\nb')
    expect(lib.parseAliases('老婆|宝贝、老婆')).toEqual(['老婆', '宝贝'])
    expect(lib.formatAliases(['老婆', '宝贝'])).toBe('老婆、宝贝')
  })

  it('粘贴名单解析：正常、缺备注名、重复行', () => {
    const text = ['张三, 小张, 张哥|三哥, 老同学', '# 注释行', '李四', ', 没名字', '张三, 重复', '王五, , , 备注'].join('\n')
    const result = lib.parseWhitelistText(text)
    expect(result.entries).toEqual([
      { id: '张三', name: '小张', aliases: ['张哥', '三哥'], note: '老同学' },
      { id: '李四' },
      { id: '王五', note: '备注' },
    ])
    expect(result.errors.length).toBe(2)
    expect(result.errors[1]).toContain('重复')
  })

  it('名单文本往返与过滤', () => {
    const entries = [
      { id: '张三', name: '小张', aliases: ['张哥'], note: '老同学' },
      { id: '李四' },
    ]
    expect(lib.whitelistToText(entries)).toBe('张三, 小张, 张哥, 老同学\n李四, , , ')
    expect(lib.filterWhitelist(entries, '张哥').map((e: any) => e.id)).toEqual(['张三'])
    expect(lib.filterWhitelist(entries, '不存在')).toEqual([])
    expect(lib.validateWhitelistEntries([{ id: 'a' }, { id: 'a' }, { id: '' }]).length).toBe(2)
  })
})

describe('人格包编辑', () => {
  it('草稿与 PersonaPackV2 往返保留关键字段', () => {
    const pack = {
      version: 2,
      id: 'lin-yao',
      name: '林瑶',
      avatar: '🙂',
      style: '温柔',
      catchphrases: ['好呀', '抱抱'],
      systemPrompt: '你叫林瑶。',
      examples: [{ user: '在吗', reply: '在的呀' }],
      taboo: ['前任'],
      stickers: [{ emotion: 'happy', name: '开心.png' }],
      author: 'tester',
      description: '测试人格',
      tags: ['温柔', '日常'],
      packVersion: '1.2.0',
    }
    const draft = lib.personaDraftFromPack(pack)
    expect(draft.tags).toBe('温柔, 日常')
    expect(draft.catchphrases).toBe('好呀\n抱抱')
    expect(draft.examples).toBe('在吗 => 在的呀')
    const rebuilt = lib.personaDraftToPack(draft, pack)
    expect(rebuilt).toMatchObject({
      version: 2,
      id: 'lin-yao',
      name: '林瑶',
      author: 'tester',
      packVersion: '1.2.0',
      source: 'local',
    })
    expect(rebuilt.examples).toEqual([{ user: '在吗', reply: '在的呀' }])
    expect(rebuilt.stickers).toEqual(pack.stickers)
  })

  it('校验：缺 id / 非法 id / 缺系统提示词 / 示例格式错误', () => {
    const bad = lib.validatePersonaDraft({ id: 'Bad Id', name: '', systemPrompt: '', examples: '没有分隔符' })
    expect(bad.ok).toBe(false)
    expect(bad.errors.map((e: any) => e.field)).toEqual(expect.arrayContaining(['id', 'name', 'systemPrompt', 'examples']))

    const good = lib.validatePersonaDraft({ id: 'lin-yao', name: '林瑶', systemPrompt: '你叫林瑶。', examples: '' })
    expect(good.ok).toBe(true)
    expect(good.examples).toEqual([])
  })

  it('示例解析支持多种分隔符并给出错误行', () => {
    const parsed = lib.parseExampleLines('在吗 => 在的\n吃了没 → 刚吃完\n\t晚安\t好梦\n坏行')
    expect(parsed.examples.length).toBe(3)
    expect(parsed.errors).toEqual(['第 4 行：示例请用「用户 => 回复」格式'])
  })

  it('PersonaSummary 兜底为可导出的 pack，导出文件名安全', () => {
    const pack = lib.personaPackFromSummary({ id: 'builtin-small', name: '小号', tags: ['内置'], author: 'dsh' })
    expect(pack).toMatchObject({ version: 2, id: 'builtin-small', name: '小号', source: 'local' })
    expect(pack.systemPrompt).toBe('')
    expect(lib.personaExportFilename('builtin-small', new Date(2026, 9, 30, 23, 12))).toBe(
      'dsh-persona-builtin-small-20261030-2312.json',
    )
    expect(lib.isZipFilename('pack.ZIP')).toBe(true)
    expect(lib.isZipFilename('pack.json')).toBe(false)
  })

  it('解析粘贴的人格 JSON', () => {
    expect(lib.parsePersonaPackText('not json').ok).toBe(false)
    expect(lib.parsePersonaPackText(JSON.stringify({ version: 1, id: 'a', name: 'a' })).ok).toBe(false)
    const ok = lib.parsePersonaPackText(JSON.stringify({ version: 2, id: 'a', name: 'A', tags: [] }))
    expect(ok.ok).toBe(true)
    expect(ok.pack.id).toBe('a')
  })
})

describe('表情包上传校验', () => {
  it('校验文件类型 / 大小 / base64 解析', () => {
    expect(lib.validateStickerFile({ name: 'a.png', mime: 'image/png', size: 1024 }).ok).toBe(true)
    expect(lib.validateStickerFile({ name: 'a.webp', mime: 'image/webp', size: 1024 }).ok).toBe(true)
    // 与 Host 保持一致：JPEG 不被接受（Host 只允许 PNG / GIF / WebP）。
    expect(lib.validateStickerFile({ name: 'a.jpg', mime: 'image/jpeg', size: 1024 }).ok).toBe(false)
    expect(lib.validateStickerFile({ name: 'a.bmp', mime: 'image/bmp', size: 10 }).ok).toBe(false)
    expect(lib.validateStickerFile({ name: 'a.zip', mime: '', size: 10 }).ok).toBe(false)
    expect(lib.validateStickerFile({ name: 'a.png', mime: '', size: 2 * 1024 * 1024 + 1 }).ok).toBe(false)
    expect(lib.estimateBase64Bytes('AAAA')).toBe(3)
    expect(lib.estimateBase64Bytes('AAA=')).toBe(2)
    const data = 'data:image/png;base64,iVBORw0KGgo='
    const converted = lib.dataUrlToBase64(data)
    expect(converted.ok).toBe(true)
    expect(converted.base64).toBe('iVBORw0KGgo=')
    expect(converted.byteLength).toBe(8)
    expect(lib.dataUrlToBase64('http://example.com/a.png').ok).toBe(false)
  })
})

describe('配置对比与状态视图', () => {
  it('countConfigChanges 统计嵌套改动叶子数，configChanged 快速判断', () => {
    const prev = { enabled: true, reply: { maxChars: 60, temperature: 1.1 }, whitelist: [{ id: 'a' }], safety: { blockTransfers: true } }
    const next = { enabled: true, reply: { maxChars: 80, temperature: 1.1 }, whitelist: [{ id: 'a' }], safety: { blockTransfers: false } }
    expect(lib.countConfigChanges(prev, next)).toBe(2)
    expect(lib.countConfigChanges(prev, JSON.parse(JSON.stringify(prev)))).toBe(0)
    expect(lib.configChanged(prev, next)).toBe(true)
    expect(lib.configChanged(prev, JSON.parse(JSON.stringify(prev)))).toBe(false)
    expect(lib.countConfigChanges(prev, { ...next, enabled: false, whitelist: [{ id: 'b' }] })).toBe(4)
  })

  it('引擎状态 / 跳过原因 / 事件摘要', () => {
    expect(lib.channelStateLabel('degraded')).toBe('降级')
    expect(lib.budgetPhaseLabel('draft')).toBe('草稿模式')
    expect(lib.engineStatusView({ paused: true, pauseReason: '人工暂停' })).toMatchObject({ label: '已暂停', tone: 'warn' })
    expect(lib.engineStatusView({ channelState: 'running' })).toMatchObject({ label: '运行中', tone: 'success' })
    expect(lib.engineStatusView({ channelState: 'error' })).toMatchObject({ label: '异常', tone: 'error' })
    expect(lib.engineStatusView({ breaker: { tripped: true, reason: '连续失败' } })).toMatchObject({ label: '风控熔断' })
    expect(lib.humanizeSkipReason('rate-limit')).toBe('触发频率限制')
    expect(lib.eventTypeLabel('send-fail')).toBe('发送失败')
    expect(lib.eventTone('risk')).toBe('error')
    expect(lib.formatEventSummary({ type: 'llm', llm: { model: 'flash', totalTokens: 1234, durationMs: 1500 } })).toBe(
      'flash · 1.2k tokens · 2 秒',
    )
    expect(lib.formatEventSummary({ type: 'skip', reason: 'offline' })).toBe('不在线时段')
  })

  it('事件倒序与 summary 统计卡', () => {
    const events = [
      { ts: new Date(2026, 9, 30, 10, 0, 0).toISOString(), type: 'start' },
      { ts: new Date(2026, 9, 30, 10, 5, 0).toISOString(), type: 'send' },
    ]
    expect(lib.decorateEvents(events).map((e: any) => e.type)).toEqual(['send', 'start'])
    expect(lib.decorateEvents(events, 1).length).toBe(1)
    const cards = lib.auditSummaryCards({ llmCalls: 3, llmTokens: 1234, searches: 1, sends: 2, drafts: 4, skips: { offline: 2, 'rate-limit': 3 } })
    expect(cards.find((c: any) => c.key === 'llmTokens').value).toBe('1.2k')
    expect(cards.find((c: any) => c.key === 'skips').value).toBe('5')
    expect(cards.length).toBe(6)
  })
})
