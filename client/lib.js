/**
 * dsh-wechat-persona · 浏览器端纯逻辑工具（无 DOM 依赖，可单测）。
 *
 * 背景：DSH Web 客户端的插件是「单文件、无构建」的，client/client.js 里内联了一份
 * 同样的纯逻辑（不能 import 本文件），本文件供 vitest 覆盖这些算法。修改时请把
 * client.js 中同名实现一并同步（两边函数体保持一致）。
 *
 * 双导出：
 *   - 浏览器：window.DshWechatPersonaLib = { ... }
 *   - Node / vitest：module.exports = { ... }
 */
;(function (root, factory) {
  'use strict'
  const lib = factory()
  // 双导出：始终挂到全局（浏览器 / ESM 测试都走这里），CommonJS 环境额外给 module.exports。
  root.DshWechatPersonaLib = lib
  if (typeof module === 'object' && module && module.exports) {
    module.exports = lib
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  /** Tab 顺序（client/client.js 的导航也按此顺序渲染）。 */
  const TAB_IDS = [
    'overview',
    'persona',
    'whitelist',
    'schedule',
    'reply',
    'stickers',
    'budget',
    'logs',
    'market',
    'help',
  ]

  /** 表情分类（与服务端 Emotion 类型一致）。 */
  const EMOTIONS = [
    { id: 'happy', label: '开心' },
    { id: 'playful', label: '俏皮' },
    { id: 'shy', label: '害羞' },
    { id: 'comfort', label: '安慰' },
    { id: 'curious', label: '好奇' },
    { id: 'neutral', label: '中性' },
  ]
  const EMOTION_IDS = EMOTIONS.map(function (e) { return e.id })
  const EMOTION_LABELS = EMOTIONS.reduce(function (acc, e) { acc[e.id] = e.label; return acc }, {})

  /** 推理强度。 */
  const REASONING_EFFORTS = [
    { value: 'low', label: '低（省 token，默认）' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高（更慢、更贵）' },
  ]

  /** 通道类型。 */
  const CHANNELS = [
    { value: 'mock', label: '模拟通道（本地调试，默认）' },
    { value: 'phone-adb', label: '安卓真机 · ADB' },
    { value: 'windows-vm', label: 'Windows 虚拟机 · 微信' },
    { value: 'desktop', label: '本机桌面微信' },
  ]

  /** 低活跃日（0 = 不启用，1 = 周一 … 7 = 周日）。 */
  const WEEKDAY_OPTIONS = (function () {
    const names = ['不启用', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
    const out = []
    for (let i = 0; i < names.length; i++) out.push({ value: i, label: names[i] })
    return out
  })()

  /** 粘贴名单的行格式提示。 */
  const WHITELIST_TEXT_HINT =
    '每行一个联系人：备注名, 昵称, 别名1|别名2, 备注（备注名必填，其余可留空；以 # 开头的行会被忽略）'

  /** 表情包上传限制。 */
  const MAX_STICKER_BYTES = 2 * 1024 * 1024
  // 与 Host 端一致：只接受 PNG / GIF / WebP（Host 会校验文件头，JPEG 会被拒绝）。
  const STICKER_MIME_ALLOWED = ['image/png', 'image/gif', 'image/webp']
  const STICKER_EXT_ALLOWED = ['.png', '.gif', '.webp']

  // ---------------------------------------------------------------------------
  // 数字 / 格式化
  // ---------------------------------------------------------------------------

  function pad2(n) {
    return n < 10 ? '0' + n : String(n)
  }

  function toDate(value) {
    if (value === null || value === undefined || value === '') return null
    const d = value instanceof Date ? value : new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }

  /** 数值裁剪；非法值 / 空值返回 fallback。 */
  function clampNumber(value, min, max, fallback) {
    if (value === null || value === undefined) return fallback
    if (typeof value === 'string' && value.trim() === '') return fallback
    const n = typeof value === 'number' ? value : Number(String(value).trim())
    if (!Number.isFinite(n)) return fallback
    if (n < min) return min
    if (n > max) return max
    return n
  }

  /** 整数裁剪；非法值返回 fallback。 */
  function clampInt(value, min, max, fallback) {
    return Math.round(clampNumber(value, min, max, fallback))
  }

  function formatDate(value) {
    const d = toDate(value)
    if (!d) return '—'
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  }

  function formatClock(value) {
    const d = toDate(value)
    if (!d) return '—'
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  }

  function formatDateTime(value) {
    const d = toDate(value)
    if (!d) return '—'
    return formatDate(d) + ' ' + formatClock(d) + ':' + pad2(d.getSeconds())
  }

  /** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
  function relativeTime(value, now) {
    const d = toDate(value)
    if (!d) return '—'
    const base = toDate(now) || new Date()
    const diff = base.getTime() - d.getTime()
    if (diff < 0) return '刚刚'
    if (diff < 5000) return '刚刚'
    if (diff < 60000) return Math.floor(diff / 1000) + ' 秒前'
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
    return Math.floor(diff / 86400000) + ' 天前'
  }

  /** 毫秒 → 中文时长（用于 uptime / 打字延迟等）。 */
  function formatDuration(ms) {
    const n = Number(ms)
    if (!Number.isFinite(n) || n < 0) return '—'
    if (n < 1000) return Math.round(n) + ' 毫秒'
    const totalSec = Math.round(n / 1000)
    if (totalSec < 60) return totalSec + ' 秒'
    const minutes = Math.floor(totalSec / 60)
    const sec = totalSec % 60
    if (minutes < 60) return sec ? minutes + ' 分 ' + sec + ' 秒' : minutes + ' 分钟'
    const hours = Math.floor(minutes / 60)
    const min = minutes % 60
    if (hours < 24) return min ? hours + ' 小时 ' + min + ' 分' : hours + ' 小时'
    const days = Math.floor(hours / 24)
    const hr = hours % 24
    return hr ? days + ' 天 ' + hr + ' 小时' : days + ' 天'
  }

  /** 秒 → 中文时长（用于 /health.uptime）。 */
  function formatUptime(seconds) {
    const n = Number(seconds)
    if (!Number.isFinite(n) || n < 0) return '—'
    return formatDuration(n * 1000)
  }

  /** token 数简称：1234 → 1.2k。 */
  function formatTokens(n) {
    const v = Number(n)
    if (!Number.isFinite(v) || v < 0) return '—'
    if (v < 1000) return String(Math.round(v))
    if (v < 10000) return trimFixed(v / 1000, 1) + 'k'
    if (v < 1000000) return Math.round(v / 1000) + 'k'
    return trimFixed(v / 1000000, 1) + 'M'
  }

  function trimFixed(value, digits) {
    return value.toFixed(digits).replace(/\.0+$/, '')
  }

  function formatBytes(n) {
    const v = Number(n)
    if (!Number.isFinite(v) || v < 0) return '—'
    if (v < 1024) return v + ' B'
    if (v < 1024 * 1024) return trimFixed(v / 1024, 1) + ' KB'
    return trimFixed(v / (1024 * 1024), 1) + ' MB'
  }

  /** 0.35 → "35%"。 */
  function formatPercent(ratio, digits) {
    const v = Number(ratio)
    if (!Number.isFinite(v)) return '—'
    return (v * 100).toFixed(digits === undefined ? 0 : digits) + '%'
  }

  /** 0.35 → "35"（给百分比输入框用）。 */
  function ratioToPercentText(ratio) {
    const v = Number(ratio)
    if (!Number.isFinite(v)) return ''
    return String(Math.round(v * 1000) / 10)
  }

  /** "35" → 0.35（非法值返回 fallback）。 */
  function percentTextToRatio(text, fallback) {
    const n = Number(String(text === undefined || text === null ? '' : text).trim())
    if (!Number.isFinite(n)) return fallback
    return Math.min(1, Math.max(0, n / 100))
  }

  // ---------------------------------------------------------------------------
  // 时间 / 在线时段
  // ---------------------------------------------------------------------------

  /** "08:30" → 510；非法返回 null。 */
  function parseTimeToMinutes(value) {
    if (typeof value !== 'string') return null
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
    if (!m) return null
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return null
    return h * 60 + min
  }

  /** "8:5" → "08:05"；非法返回 null。 */
  function normalizeTime(value) {
    const mins = parseTimeToMinutes(value)
    if (mins === null) return null
    return minutesToTime(mins)
  }

  function minutesToTime(mins) {
    const m = ((Number(mins) % 1440) + 1440) % 1440
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60)
  }

  function isWeekendDay(dayIndex) {
    return dayIndex === 0 || dayIndex === 6
  }

  /** 是否落在时段内；start === end 视为全天；支持跨零点（22:00–02:00）。 */
  function isWithinWindow(nowMinutes, startMinutes, endMinutes) {
    if (startMinutes === null || endMinutes === null) return true
    if (startMinutes === endMinutes) return true
    if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes
    return nowMinutes >= startMinutes || nowMinutes < endMinutes
  }

  /**
   * 解析某一天实际生效的在线时段：周末/工作日单独配置且两项都填了才生效，
   * 否则回退到 onlineStart / onlineEnd。
   */
  function resolveOnlineWindow(schedule, dayIndex) {
    const s = schedule || {}
    const pair = function (start, end) {
      if (typeof start === 'string' && start && typeof end === 'string' && end) {
        const sm = parseTimeToMinutes(start)
        const em = parseTimeToMinutes(end)
        if (sm !== null && em !== null) return { start: start, end: end }
      }
      return null
    }
    if (isWeekendDay(dayIndex)) {
      const weekend = pair(s.weekendStart, s.weekendEnd)
      if (weekend) return { start: weekend.start, end: weekend.end, source: 'weekend' }
    } else {
      const workday = pair(s.workdayStart, s.workdayEnd)
      if (workday) return { start: workday.start, end: workday.end, source: 'workday' }
    }
    return {
      start: typeof s.onlineStart === 'string' && s.onlineStart ? s.onlineStart : '08:30',
      end: typeof s.onlineEnd === 'string' && s.onlineEnd ? s.onlineEnd : '23:00',
      source: 'default',
    }
  }

  /** "工作时段 08:30–23:00"（含跨零点提示）。 */
  function describeOnlineWindow(schedule, dayIndex) {
    const win = resolveOnlineWindow(schedule, dayIndex)
    const sm = parseTimeToMinutes(win.start)
    const em = parseTimeToMinutes(win.end)
    const suffix = sm !== null && em !== null && em <= sm ? '（跨零点）' : ''
    const sourceLabel = win.source === 'workday' ? '工作日' : win.source === 'weekend' ? '周末' : '默认'
    return sourceLabel + ' ' + win.start + '–' + win.end + suffix
  }

  /** 当前是否处于在线时段内。 */
  function isOnlineNow(schedule, now) {
    const d = toDate(now) || new Date()
    const win = resolveOnlineWindow(schedule, d.getDay())
    return isWithinWindow(d.getHours() * 60 + d.getMinutes(), parseTimeToMinutes(win.start), parseTimeToMinutes(win.end))
  }

  /** 下一次进入在线时段的时间；已经开始（在线中）则返回当前时间；找不到返回 null。 */
  function nextOnlineAt(schedule, now) {
    const base = toDate(now) || new Date()
    const minutes = base.getHours() * 60 + base.getMinutes()
    const today = resolveOnlineWindow(schedule, base.getDay())
    if (isWithinWindow(minutes, parseTimeToMinutes(today.start), parseTimeToMinutes(today.end))) return base
    for (let i = 0; i < 8; i++) {
      const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)
      const win = resolveOnlineWindow(schedule, day.getDay())
      const sm = parseTimeToMinutes(win.start)
      if (sm === null) continue
      const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, sm, 0, 0)
      if (candidate.getTime() > base.getTime()) return candidate
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // 字符串 / 关键词 / 白名单
  // ---------------------------------------------------------------------------

  function trimText(value) {
    return typeof value === 'string' ? value.trim() : ''
  }

  function dedupe(list) {
    const seen = new Set()
    const out = []
    for (const item of list || []) {
      const key = String(item)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
    return out
  }

  /** 关键词文本（换行 / 中英文逗号 / 分号 / 顿号分隔）→ 去重数组。 */
  function splitKeywords(text) {
    if (Array.isArray(text)) {
      return dedupe(text.map(function (x) { return String(x).trim() }).filter(Boolean))
    }
    if (typeof text !== 'string') return []
    return dedupe(
      text
        .split(/[\n\r,，;；、]+/)
        .map(function (s) { return s.trim() })
        .filter(Boolean),
    )
  }

  function joinKeywords(list) {
    return Array.isArray(list) ? list.join('\n') : ''
  }

  /** 别名文本（| 、 / 中英文逗号等分隔）→ 去重数组。 */
  function parseAliases(text) {
    if (Array.isArray(text)) {
      return dedupe(text.map(function (x) { return String(x).trim() }).filter(Boolean))
    }
    if (typeof text !== 'string') return []
    return dedupe(
      text
        .split(/[|｜,，、;；/／]+/)
        .map(function (s) { return s.trim() })
        .filter(Boolean),
    )
  }

  function formatAliases(list) {
    return Array.isArray(list) ? list.join('、') : ''
  }

  /**
   * 粘贴名单 → WhitelistEntry[]。
   * 行格式：备注名, 昵称, 别名1|别名2, 备注
   * 返回 { entries, errors }，errors 是给人看的中文提示。
   */
  function parseWhitelistText(text) {
    const entries = []
    const errors = []
    const seen = new Set()
    const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const line = raw.trim()
      if (!line || line.charAt(0) === '#') continue
      const parts = line.split(/[,，\t]+/).map(function (s) { return s.trim() })
      const id = parts[0] || ''
      if (!id) {
        errors.push('第 ' + (i + 1) + ' 行：缺少备注名')
        continue
      }
      if (seen.has(id)) {
        errors.push('第 ' + (i + 1) + ' 行：备注名「' + id + '」重复')
        continue
      }
      seen.add(id)
      const entry = { id: id }
      if (parts[1]) entry.name = parts[1]
      const aliases = parts[2] ? parseAliases(parts[2]) : []
      if (aliases.length) entry.aliases = aliases
      if (parts[3]) entry.note = parts[3]
      entries.push(entry)
    }
    return { entries: entries, errors: errors }
  }

  /** WhitelistEntry[] → 文本（parseWhitelistText 的逆操作）。 */
  function whitelistToText(entries) {
    return (entries || [])
      .map(function (entry) {
        const aliases = Array.isArray(entry.aliases) ? entry.aliases.join('|') : ''
        return [entry.id || '', entry.name || '', aliases, entry.note || ''].join(', ')
      })
      .join('\n')
  }

  /** 名单过滤（备注名 / 昵称 / 别名 / 备注，忽略大小写）。 */
  function filterWhitelist(entries, query) {
    const q = trimText(query).toLowerCase()
    const list = entries || []
    if (!q) return list.slice()
    return list.filter(function (entry) {
      const haystack = [entry.id, entry.name, entry.note]
        .concat(Array.isArray(entry.aliases) ? entry.aliases : [])
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.indexOf(q) >= 0
    })
  }

  /** 白名单条目校验，返回错误数。 */
  function validateWhitelistEntries(entries) {
    const errors = []
    const seen = new Set()
    ;(entries || []).forEach(function (entry, index) {
      const id = trimText(entry && entry.id)
      if (!id) {
        errors.push('第 ' + (index + 1) + ' 条：备注名不能为空')
        return
      }
      if (seen.has(id)) errors.push('第 ' + (index + 1) + ' 条：备注名「' + id + '」重复')
      seen.add(id)
    })
    return errors
  }

  // ---------------------------------------------------------------------------
  // 人格包
  // ---------------------------------------------------------------------------

  function slugify(value) {
    const slug = String(value === undefined || value === null ? '' : value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return slug
  }

  /** 从人格名称生成 id；中文等无法转写时用时间戳兜底。 */
  function slugifyPersonaId(name) {
    const slug = slugify(name)
    if (/^[a-z0-9][a-z0-9-]*$/.test(slug) && slug.length >= 2) return slug.slice(0, 48)
    return 'persona-' + Date.now().toString(36)
  }

  /** 用 PersonaSummary 兜底构造一个可导出的 PersonaPackV2（服务端没有 export 接口时用）。 */
  function personaPackFromSummary(summary) {
    const s = summary || {}
    return {
      version: 2,
      id: s.id ? String(s.id) : slugifyPersonaId(s.name),
      name: s.name || s.id || '未命名人格',
      avatar: s.avatar || '',
      style: s.style || '',
      catchphrases: [],
      systemPrompt: '',
      examples: [],
      taboo: [],
      stickers: [],
      author: s.author || 'local',
      description: s.description || '',
      tags: Array.isArray(s.tags) ? s.tags.slice() : [],
      packVersion: s.packVersion || '1.0.0',
      source: 'local',
    }
  }

  /** 解析粘贴进来的强人格 JSON 文本。 */
  function parsePersonaPackText(text) {
    const t = trimText(text)
    if (!t) return { ok: false, error: '内容为空' }
    let data
    try {
      data = JSON.parse(t)
    } catch (error) {
      return { ok: false, error: 'JSON 解析失败：' + (error && error.message ? error.message : String(error)) }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'JSON 根节点必须是对象' }
    }
    if (Number(data.version) !== 2) return { ok: false, error: '人格包 version 必须为 2' }
    if (!trimText(data.id)) return { ok: false, error: '人格包缺少 id 字段' }
    if (!trimText(data.name)) return { ok: false, error: '人格包缺少 name 字段' }
    const pack = Object.assign({}, data)
    pack.tags = Array.isArray(pack.tags) ? pack.tags : []
    pack.catchphrases = Array.isArray(pack.catchphrases) ? pack.catchphrases : []
    pack.taboo = Array.isArray(pack.taboo) ? pack.taboo : []
    pack.examples = Array.isArray(pack.examples) ? pack.examples : []
    pack.stickers = Array.isArray(pack.stickers) ? pack.stickers : []
    return { ok: true, pack: pack }
  }

  function splitLines(text) {
    if (Array.isArray(text)) return dedupe(text.map(function (x) { return String(x).trim() }).filter(Boolean))
    if (typeof text !== 'string') return []
    return dedupe(
      text
        .split(/\r?\n/)
        .map(function (s) { return s.trim() })
        .filter(Boolean),
    )
  }

  /**
   * 示例文本 → PersonaPackV2.examples。
   * 每行一条：「用户内容 => 回复内容」也支持 → 、→、tab 分隔。
   */
  function parseExampleLines(text) {
    const examples = []
    const errors = []
    const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line || line.charAt(0) === '#') continue
      const m = /^(.+?)(?:\s*(?:=>|→|⇒)\s*|\t+)(.+)$/.exec(line)
      if (!m) {
        errors.push('第 ' + (i + 1) + ' 行：示例请用「用户 => 回复」格式')
        continue
      }
      examples.push({ user: m[1].trim(), reply: m[2].trim() })
    }
    return { examples: examples, errors: errors }
  }

  function formatExampleLines(examples) {
    return (examples || [])
      .map(function (e) { return (e && e.user ? e.user : '') + ' => ' + (e && e.reply ? e.reply : '') })
      .join('\n')
  }

  /** PersonaPackV2 → 表单草稿（字符串字段便于编辑）。 */
  function personaDraftFromPack(pack) {
    const p = pack || {}
    return {
      id: p.id || '',
      name: p.name || '',
      avatar: p.avatar || '',
      style: p.style || '',
      description: p.description || '',
      author: p.author || '',
      tags: Array.isArray(p.tags) ? p.tags.join(', ') : '',
      catchphrases: Array.isArray(p.catchphrases) ? p.catchphrases.join('\n') : '',
      taboo: Array.isArray(p.taboo) ? p.taboo.join('\n') : '',
      systemPrompt: p.systemPrompt || '',
      examples: formatExampleLines(p.examples),
    }
  }

  /** 表单草稿 → PersonaPackV2（base 用于保留 stickers / 版本号等）。 */
  function personaDraftToPack(draft, base) {
    const d = draft || {}
    const b = base || {}
    const tags = String(d.tags || '')
      .split(/[,，、]+/)
      .map(function (s) { return s.trim() })
      .filter(Boolean)
    return {
      version: 2,
      id: trimText(d.id) || trimText(b.id),
      name: trimText(d.name) || trimText(b.name),
      avatar: trimText(d.avatar),
      style: trimText(d.style),
      catchphrases: splitLines(d.catchphrases),
      systemPrompt: typeof d.systemPrompt === 'string' ? d.systemPrompt : b.systemPrompt || '',
      examples: parseExampleLines(d.examples).examples,
      taboo: splitLines(d.taboo),
      stickers: Array.isArray(b.stickers) ? b.stickers.slice() : [],
      author: trimText(d.author) || trimText(b.author) || 'local',
      description: trimText(d.description),
      tags: dedupe(tags),
      packVersion: trimText(b.packVersion) || '1.0.0',
      source: 'local',
    }
  }

  /** 人格草稿校验；errors 是 [{ field, message }]。 */
  function validatePersonaDraft(draft) {
    const d = draft || {}
    const errors = []
    const id = trimText(d.id)
    const name = trimText(d.name)
    if (!id) errors.push({ field: 'id', message: '请填写人格 id（小写字母 / 数字 / - / _）' })
    else if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) errors.push({ field: 'id', message: 'id 只能包含小写字母、数字、- 和 _' })
    else if (id.length > 64) errors.push({ field: 'id', message: 'id 不能超过 64 个字符' })
    if (!name) errors.push({ field: 'name', message: '请填写人格名称' })
    else if (name.length > 40) errors.push({ field: 'name', message: '人格名称不能超过 40 个字符' })
    else if (name.length < 1) errors.push({ field: 'name', message: '人格名称不能为空' })
    if (!trimText(d.systemPrompt)) errors.push({ field: 'systemPrompt', message: '系统提示词不能为空（它是人设的核心）' })
    const exampleResult = parseExampleLines(d.examples)
    for (const message of exampleResult.errors) errors.push({ field: 'examples', message: message })
    return { ok: errors.length === 0, errors: errors, examples: exampleResult.examples }
  }

  /** 导出文件名：dsh-persona-<id>-20261030-2312.json */
  function personaExportFilename(id, now) {
    const d = toDate(now) || new Date()
    const stamp =
      String(d.getFullYear()) +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) +
      '-' +
      pad2(d.getHours()) +
      pad2(d.getMinutes())
    return 'dsh-persona-' + (slugify(id) || 'pack') + '-' + stamp + '.json'
  }

  function isZipFilename(name) {
    return /\.zip$/i.test(trimText(name))
  }

  // ---------------------------------------------------------------------------
  // 表情包上传
  // ---------------------------------------------------------------------------

  function fileExt(name) {
    const m = /(\.[a-z0-9]+)$/i.exec(trimText(name))
    return m ? m[1].toLowerCase() : ''
  }

  /** 校验选中的表情文件（MIME 可能为空，此时看扩展名）。 */
  function validateStickerFile(file) {
    const f = file || {}
    const name = trimText(f.name)
    if (!name) return { ok: false, error: '请选择图片文件' }
    const mime = trimText(f.mime).toLowerCase()
    const ext = fileExt(name)
    if (mime && STICKER_MIME_ALLOWED.indexOf(mime) < 0) {
      return { ok: false, error: '只支持 PNG / GIF / WebP 图片' }
    }
    if (!mime && STICKER_EXT_ALLOWED.indexOf(ext) < 0) {
      return { ok: false, error: '只支持 PNG / GIF / WebP 图片' }
    }
    const size = Number(f.size)
    if (!Number.isFinite(size) || size <= 0) return { ok: false, error: '文件为空' }
    if (size > MAX_STICKER_BYTES) return { ok: false, error: '图片不能超过 2 MB（当前 ' + formatBytes(size) + '）' }
    return { ok: true, size: size }
  }

  /** base64 长度 → 原始字节数。 */
  function estimateBase64Bytes(base64) {
    const s = String(base64 === undefined || base64 === null ? '' : base64).replace(/\s+/g, '')
    if (!s) return 0
    const padding = s.slice(-2) === '==' ? 2 : s.slice(-1) === '=' ? 1 : 0
    return Math.floor((s.length * 3) / 4) - padding
  }

  /** data URL → { ok, mime, base64, byteLength }。 */
  function dataUrlToBase64(dataUrl) {
    const text = trimText(dataUrl)
    const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(text)
    if (!m) return { ok: false, error: '不是有效的 base64 图片数据' }
    const base64 = m[2].replace(/\s+/g, '')
    if (!base64) return { ok: false, error: '图片数据为空' }
    return { ok: true, mime: m[1], base64: base64, byteLength: estimateBase64Bytes(base64) }
  }

  // ---------------------------------------------------------------------------
  // 配置对比 / 引擎状态 / 审计事件
  // ---------------------------------------------------------------------------

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  /** 递归统计两版配置的差异叶子数（数组 / 原始值算叶子）。 */
  function countConfigChanges(prev, next) {
    function walk(a, b) {
      if (a === b) return 0
      if (!isPlainObject(a) || !isPlainObject(b)) {
        return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1
      }
      const keys = dedupe(Object.keys(a).concat(Object.keys(b)))
      let count = 0
      for (const key of keys) {
        count += walk(a[key], b[key])
      }
      return count
    }
    return walk(prev, next)
  }

  function configChanged(prev, next) {
    return countConfigChanges(prev, next) > 0
  }

  function channelStateLabel(state) {
    const map = { stopped: '已停止', starting: '启动中', running: '运行中', degraded: '降级', error: '异常' }
    return map[state] || (state ? String(state) : '未知')
  }

  function budgetPhaseLabel(phase) {
    const map = { ok: '正常', draft: '草稿模式', exhausted: '预算耗尽' }
    return map[phase] || (phase ? String(phase) : '正常')
  }

  function eventTypeLabel(type) {
    const map = {
      start: '启动',
      stop: '停止',
      resume: '恢复',
      channel: '通道',
      inbound: '收到消息',
      skip: '跳过',
      risk: '风控',
      llm: '模型调用',
      search: '搜索',
      draft: '草稿',
      send: '已发送',
      'send-fail': '发送失败',
      summary: '摘要',
      error: '错误',
      config: '配置',
    }
    return map[type] || (type ? String(type) : '事件')
  }

  function eventTone(type) {
    if (type === 'error' || type === 'risk' || type === 'send-fail') return 'error'
    if (type === 'send' || type === 'summary' || type === 'resume' || type === 'start') return 'success'
    if (type === 'skip' || type === 'stop') return 'warn'
    return 'neutral'
  }

  /** 跳过原因 → 中文。 */
  function humanizeSkipReason(reason) {
    const key = trimText(reason)
    const map = {
      'rate-limit': '触发频率限制',
      interval: '回复间隔太短',
      pause: '分身已暂停',
      offline: '不在线时段',
      'draft-mode': '预算进入草稿模式',
      budget: '预算不足',
      'no-persona': '未启用人格',
      group: '群聊已禁用',
      private: '私聊已禁用',
      ignored: '会话被忽略',
      'not-whitelist': '不在白名单',
      forbidden: '命中违禁词',
      sticker: '忽略纯表情',
      disabled: '总开关关闭',
    }
    return map[key] || key || '未知原因'
  }

  /** 审计事件摘要行（给日志表格用）。 */
  function formatEventSummary(event) {
    const e = event || {}
    if (e.type === 'llm' && e.llm) {
      const llm = e.llm
      const parts = []
      parts.push(llm.model || llm.provider || '模型')
      const tokens =
        typeof llm.totalTokens === 'number'
          ? llm.totalTokens
          : (Number(llm.inputTokens) || 0) + (Number(llm.outputTokens) || 0)
      if (Number.isFinite(tokens) && tokens) parts.push(formatTokens(tokens) + ' tokens')
      if (typeof llm.durationMs === 'number') parts.push(formatDuration(llm.durationMs))
      return parts.join(' · ')
    }
    if (e.type === 'inbound' || e.type === 'send' || e.type === 'draft') {
      const text = e.detail || (e.extra && (e.extra.text || e.extra.reply)) || ''
      if (typeof text === 'string' && text) return text.length > 60 ? text.slice(0, 60) + '…' : text
    }
    if (e.type === 'skip') return humanizeSkipReason(e.reason)
    if (e.type === 'risk') return e.reason ? humanizeSkipReason(e.reason) : '命中风控规则'
    if (e.reason) return humanizeSkipReason(e.reason)
    if (e.detail) return String(e.detail)
    return eventTypeLabel(e.type)
  }

  /** 事件按时间倒序，取前 limit 条。 */
  function decorateEvents(events, limit) {
    const list = Array.isArray(events) ? events.slice() : []
    list.sort(function (a, b) {
      return (toDate(b && b.ts) ? new Date(b.ts).getTime() : 0) - (toDate(a && a.ts) ? new Date(a.ts).getTime() : 0)
    })
    return limit ? list.slice(0, limit) : list
  }

  /** 构造「概览」页的引擎状态视图。 */
  function engineStatusView(status) {
    if (!status || typeof status !== 'object') return { label: '未知', tone: 'neutral', detail: '没有拿到引擎状态' }
    if (status.paused) {
      return {
        label: '已暂停',
        tone: 'warn',
        detail: status.pauseReason ? '原因：' + status.pauseReason : '可通过「继续运行」恢复',
      }
    }
    if (status.breaker && status.breaker.tripped) {
      return {
        label: '风控熔断',
        tone: 'error',
        detail: status.breaker.reason ? '原因：' + status.breaker.reason : '需要人工确认后恢复',
      }
    }
    const label = channelStateLabel(status.channelState)
    const map = { stopped: 'neutral', starting: 'warn', running: 'success', degraded: 'warn', error: 'error' }
    const detail = status.channelDetail || (status.channelId ? '通道：' + status.channelId : '')
    return { label: label, tone: map[status.channelState] || 'neutral', detail: detail }
  }

  /** /logs 的 summary → 统计卡片数据。 */
  function auditSummaryCards(summary) {
    const s = summary || {}
    const skips = s.skips && typeof s.skips === 'object' ? Object.keys(s.skips) : []
    let skipTotal = 0
    for (const key of skips) skipTotal += Number(s.skips[key]) || 0
    return [
      { key: 'llmCalls', label: '模型调用', value: String(Number(s.llmCalls) || 0) },
      { key: 'llmTokens', label: '消耗 token', value: formatTokens(Number(s.llmTokens) || 0) },
      { key: 'searches', label: '搜索', value: String(Number(s.searches) || 0) },
      { key: 'sends', label: '发送', value: String(Number(s.sends) || 0) },
      { key: 'drafts', label: '草稿', value: String(Number(s.drafts) || 0) },
      { key: 'skips', label: '跳过', value: String(skipTotal) },
    ]
  }

  return {
    TAB_IDS: TAB_IDS,
    EMOTIONS: EMOTIONS,
    EMOTION_IDS: EMOTION_IDS,
    EMOTION_LABELS: EMOTION_LABELS,
    REASONING_EFFORTS: REASONING_EFFORTS,
    CHANNELS: CHANNELS,
    WEEKDAY_OPTIONS: WEEKDAY_OPTIONS,
    WHITELIST_TEXT_HINT: WHITELIST_TEXT_HINT,
    MAX_STICKER_BYTES: MAX_STICKER_BYTES,
    STICKER_MIME_ALLOWED: STICKER_MIME_ALLOWED,
    pad2: pad2,
    toDate: toDate,
    clampNumber: clampNumber,
    clampInt: clampInt,
    formatDate: formatDate,
    formatClock: formatClock,
    formatDateTime: formatDateTime,
    relativeTime: relativeTime,
    formatDuration: formatDuration,
    formatUptime: formatUptime,
    formatTokens: formatTokens,
    formatBytes: formatBytes,
    formatPercent: formatPercent,
    ratioToPercentText: ratioToPercentText,
    percentTextToRatio: percentTextToRatio,
    parseTimeToMinutes: parseTimeToMinutes,
    normalizeTime: normalizeTime,
    minutesToTime: minutesToTime,
    isWeekendDay: isWeekendDay,
    isWithinWindow: isWithinWindow,
    resolveOnlineWindow: resolveOnlineWindow,
    describeOnlineWindow: describeOnlineWindow,
    isOnlineNow: isOnlineNow,
    nextOnlineAt: nextOnlineAt,
    trimText: trimText,
    dedupe: dedupe,
    splitKeywords: splitKeywords,
    joinKeywords: joinKeywords,
    parseAliases: parseAliases,
    formatAliases: formatAliases,
    parseWhitelistText: parseWhitelistText,
    whitelistToText: whitelistToText,
    filterWhitelist: filterWhitelist,
    validateWhitelistEntries: validateWhitelistEntries,
    slugify: slugify,
    slugifyPersonaId: slugifyPersonaId,
    personaPackFromSummary: personaPackFromSummary,
    parsePersonaPackText: parsePersonaPackText,
    splitLines: splitLines,
    parseExampleLines: parseExampleLines,
    formatExampleLines: formatExampleLines,
    personaDraftFromPack: personaDraftFromPack,
    personaDraftToPack: personaDraftToPack,
    validatePersonaDraft: validatePersonaDraft,
    personaExportFilename: personaExportFilename,
    isZipFilename: isZipFilename,
    validateStickerFile: validateStickerFile,
    estimateBase64Bytes: estimateBase64Bytes,
    dataUrlToBase64: dataUrlToBase64,
    countConfigChanges: countConfigChanges,
    configChanged: configChanged,
    channelStateLabel: channelStateLabel,
    budgetPhaseLabel: budgetPhaseLabel,
    eventTypeLabel: eventTypeLabel,
    eventTone: eventTone,
    humanizeSkipReason: humanizeSkipReason,
    formatEventSummary: formatEventSummary,
    decorateEvents: decorateEvents,
    engineStatusView: engineStatusView,
    auditSummaryCards: auditSummaryCards,
  }
})
