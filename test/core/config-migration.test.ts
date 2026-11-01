/**
 * 配置迁移测试：旧版本配置 → 当前版本，幂等、不丢数据、异常输入兜底。
 */
import { describe, expect, it } from 'vitest'
import { defaultConfig, migrateConfig } from '../../src/config.ts'

describe('config 迁移 migrateConfig', () => {
  it('空配置补全为安全默认值并标记 changed', () => {
    const { config, changed, notes } = migrateConfig({})
    expect(changed).toBe(true)
    expect(config.persona.activeId).toBe('builtin-small')
    expect(config.persona.enabled).toBe(true)
    expect(config.whitelistOnly).toBe(true)
    expect(config.reply.privateChatEnabled).toBe(true)
    expect(config.reply.groupChatEnabled).toBe(false)
    expect(config.reply.maxContextTurns).toBe(6)
    expect(config.schedule.workdayStart).toBe('08:30')
    expect(config.schedule.workdayEnd).toBe('23:00')
    expect(notes.length).toBeGreaterThan(0)
  })

  it('旧版 onlineStart/onlineEnd 迁移到工作日与周末时段', () => {
    const { config, changed } = migrateConfig({
      schedule: { onlineStart: '09:00', onlineEnd: '22:30' },
    })
    expect(changed).toBe(true)
    expect(config.schedule.workdayStart).toBe('09:00')
    expect(config.schedule.workdayEnd).toBe('22:30')
    expect(config.schedule.weekendStart).toBe('09:00')
    expect(config.schedule.weekendEnd).toBe('22:30')
    // 旧字段保留，兼容仍在读它的旧代码/用户配置
    expect(config.schedule.onlineStart).toBe('09:00')
  })

  it('已迁移配置幂等（changed=false 且 notes 为空）', () => {
    const { config, changed, notes } = migrateConfig(defaultConfig())
    expect(changed).toBe(false)
    expect(notes).toEqual([])
    expect(config.persona.activeId).toBe('builtin-small')
  })

  it('保留用户显式设置的开关值', () => {
    const { config } = migrateConfig({
      whitelistOnly: false,
      persona: { enabled: false, activeId: 'builtin-dafeiyu' },
      reply: { privateChatEnabled: false, maxContextTurns: 2 },
      schedule: { workdayStart: '07:00', workdayEnd: '01:00' },
    })
    expect(config.whitelistOnly).toBe(false)
    expect(config.persona.enabled).toBe(false)
    expect(config.persona.activeId).toBe('builtin-dafeiyu')
    expect(config.reply.privateChatEnabled).toBe(false)
    expect(config.reply.maxContextTurns).toBe(2)
    expect(config.schedule.workdayStart).toBe('07:00')
    expect(config.schedule.workdayEnd).toBe('01:00')
  })

  it('非法输入不崩溃并回落默认值', () => {
    for (const bad of [null, undefined, 'x', 42, [], true]) {
      const { config } = migrateConfig(bad as unknown)
      expect(config.persona.activeId).toBe('builtin-small')
      expect(config.schedule.workdayEnd).toBe('23:00')
    }
  })

  it('旧里 personaDir 字段给出迁移提示但不丢失新人格库默认值', () => {
    const { config, notes } = migrateConfig({ reply: { personaDir: '~/.dsh/persona' } })
    expect(notes.some((note) => note.includes('personaDir'))).toBe(true)
    expect(config.persona.dir).toBe('')
    expect(config.persona.activeId).toBe('builtin-small')
  })
})

describe('12.4 门槛 7：v0.2.8 配置 → v3.0.0 迁移', () => {
  // 模拟 v0.2.8 的真实配置形态：没有 sendMode / safeMode / onboardingDone / apiToken，
  // 且仍使用旧版在线时段字段（onlineStart/onlineEnd）。
  const legacyV028 = {
    enabled: true,
    activeChannel: 'mock',
    ownerName: '老板',
    whitelist: [{ id: 'wxid_alice', name: '老友', aliases: ['旧友'] }],
    whitelistOnly: true,
    persona: { enabled: true, activeId: 'builtin-dafeiyu' },
    schedule: { onlineStart: '09:00', onlineEnd: '22:30' },
    rateLimit: { perContactPerHour: 6, perContactPerDay: 30, minReplyIntervalSec: 45 },
    reply: { maxChars: 80, personaName: '小号旧版' },
    budget: { dailyTokens: 20000, draftModeRatio: 0.8 },
    market: { indexUrl: 'https://example.com/market.json', builtinOnly: false },
    legacyUnknownField: { nested: [1, 2, 3] },
  }

  it('补齐 v3.0.0 新增字段的默认值，且不丢旧字段', () => {
    const { config } = migrateConfig(legacyV028 as unknown)
    // 新增字段：sendMode 默认 auto、safeMode/onboardingDone 默认关闭、apiToken 为空（兼容模式）
    expect(config.sendMode).toBe('auto')
    expect(config.safeMode).toBe(false)
    expect(config.onboardingDone).toBe(false)
    expect(config.apiToken).toBe('')
    // 旧字段全部保留
    expect(config.enabled).toBe(true)
    expect(config.ownerName).toBe('老板')
    expect(config.whitelist).toHaveLength(1)
    expect(config.whitelist[0]?.id).toBe('wxid_alice')
    expect(config.persona.activeId).toBe('builtin-dafeiyu')
    expect(config.rateLimit.perContactPerHour).toBe(6)
    expect(config.rateLimit.minReplyIntervalSec).toBe(45)
    expect(config.reply.maxChars).toBe(80)
    expect(config.reply.personaName).toBe('小号旧版')
    expect(config.budget.dailyTokens).toBe(20000)
    expect(config.market.indexUrl).toBe('https://example.com/market.json')
    // 旧在线时段字段迁移为 v2 时段，同时旧字段保留
    expect(config.schedule.workdayStart).toBe('09:00')
    expect(config.schedule.workdayEnd).toBe('22:30')
    expect(config.schedule.onlineStart).toBe('09:00')
  })

  it('迁移后不抛异常：未知字段原样保留（不参与解释）且再次迁移幂等', () => {
    const { config } = migrateConfig(legacyV028 as unknown)
    expect(config).toBeTypeOf('object')
    // migrateConfig 的策略是「多余字段保留」以兼容仍在读旧字段的旧代码：
    // 未知字段既不参与解释，也不会导致迁移失败。
    expect(Object.prototype.hasOwnProperty.call(config, 'legacyUnknownField')).toBe(true)
    expect(config.ownerName).toBe('老板')
    // 旧配置 → 3.0.0 后再次迁移应幂等（changed=false、notes 为空）
    const again = migrateConfig(config)
    expect(again.changed).toBe(false)
    expect(again.notes).toEqual([])
  })

  it('显式 sendMode 保留；非法 sendMode 回落 auto 并给出迁移提示', () => {
    const confirm = migrateConfig({ ...legacyV028, sendMode: 'confirm' }).config
    expect(confirm.sendMode).toBe('confirm')
    const draft = migrateConfig({ ...legacyV028, sendMode: 'draft' }).config
    expect(draft.sendMode).toBe('draft')

    const bogus = migrateConfig({ ...legacyV028, sendMode: 'sometimes' })
    expect(bogus.config.sendMode).toBe('auto')
    expect(bogus.changed).toBe(true)
    expect(bogus.notes.some((note) => note.includes('sendMode'))).toBe(true)
  })

  it('v3.0.0 完整配置再迁移不产生额外改动（不含未知字段）', () => {
    const { config } = migrateConfig(legacyV028 as unknown)
    const again = migrateConfig(config)
    expect(again.changed).toBe(false)
    expect(again.config.sendMode).toBe(config.sendMode)
    expect(again.config.safeMode).toBe(config.safeMode)
    expect(again.config.onboardingDone).toBe(config.onboardingDone)
    expect(again.config.apiToken).toBe(config.apiToken)
  })
})
