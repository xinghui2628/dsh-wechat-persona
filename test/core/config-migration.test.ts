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
