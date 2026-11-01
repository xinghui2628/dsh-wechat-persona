/**
 * dsh-wechat-persona · DSH Web 客户端设置界面
 * ============================================================================
 * 单文件、纯 JS、无构建：由 Host 的客户端模块加载器 `window.__ModuleLoader__` 直接加载。
 *
 * 注册两个入口（见文件底部 applyPlugin）：
 *   1) settings.section       —— 设置页左侧「微信分身」独立分区
 *   2) plugins.bundle.config  —— Plugins 页 bundle 详情里的配置页（view === 'summary' 时返回 null）
 *
 * 所有数据都走 Host HTTP API：相对路径 `dsh-wechat-persona/api/...`，并附带请求头
 * `x-dsh-wechat-persona: 1`（Host 用它做本地访问保护）。失败时页面顶部显示错误条，不 alert。
 *
 * 约束：不 import 任何 @deepseek-ai/* 包；React 来自 require('react')；不用 JSX；
 * 样式全部注入到这里 CSS 字符串中，只使用宿主 CSS 变量（--dsw-alias-* / --dsh-*）。
 *
 * 纯逻辑（时间 / 白名单解析 / 人格包 / 上传校验 / 配置对比）与 client/lib.js 保持同步，
 * lib.js 由 test/client/lib.test.ts 覆盖；本文件内联一份以满足「单文件」要求。
 */
;(function () {
  'use strict'

  const MODULE_ID = 'dsh-wechat-persona'
  const loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : undefined
  if (!loader || typeof loader.load !== 'function') {
    if (typeof console !== 'undefined') {
      console.warn('[dsh-wechat-persona] window.__ModuleLoader__ 不可用，跳过客户端插件注册')
    }
    return
  }

  loader.load({
    id: MODULE_ID,
    factory: function (require) {
      'use strict'

      const React = require('react')
      const h = React.createElement

      // =====================================================================
      // 常量
      // =====================================================================
      const API_PREFIX = MODULE_ID + '/api/'
      const HEADER_NAME = 'x-dsh-wechat-persona'
      const HEADER_VALUE = '1'
      const REQUEST_TIMEOUT_MS = 15000
      const SAVE_TIMEOUT_MS = 25000
      const MAX_STICKER_BYTES = 2 * 1024 * 1024
      // 与 Host 端一致：只接受 PNG / GIF / WebP（Host 校验文件头，JPEG 会被拒绝）。
      const STICKER_MIME_ALLOWED = ['image/png', 'image/gif', 'image/webp']
      const STICKER_EXT_ALLOWED = ['.png', '.gif', '.webp']
      const STICKER_ORIGIN_LABELS = { package: '内置', uploaded: '上传', persona: '人格包' }
      const WHITELIST_TEXT_HINT =
        '每行一个联系人：备注名, 昵称, 别名1|别名2, 备注（备注名必填，其余可留空；以 # 开头的行会被忽略）'

      const EMOTIONS = [
        { id: 'happy', label: '开心' },
        { id: 'playful', label: '俏皮' },
        { id: 'shy', label: '害羞' },
        { id: 'comfort', label: '安慰' },
        { id: 'curious', label: '好奇' },
        { id: 'neutral', label: '中性' },
      ]
      const EMOTION_LABELS = EMOTIONS.reduce(function (acc, e) {
        acc[e.id] = e.label
        return acc
      }, {})

      const REASONING_EFFORTS = [
        { value: 'low', label: '低（省 token，默认）' },
        { value: 'medium', label: '中' },
        { value: 'high', label: '高（更慢、更贵）' },
      ]

      const CHANNELS = [
        { value: 'mock', label: '模拟通道（本地调试，默认）' },
        { value: 'phone-adb', label: '安卓真机 · ADB' },
        { value: 'windows-vm', label: 'Windows 虚拟机 · 微信' },
        { value: 'desktop', label: '本机桌面微信' },
      ]

      const WEEKDAY_OPTIONS = (function () {
        const names = ['不启用', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
        const out = []
        for (let i = 0; i < names.length; i++) out.push({ value: i, label: names[i] })
        return out
      })()

      const TABS = [
        { id: 'overview', label: '概览', icon: '📊' },
        { id: 'persona', label: '人格', icon: '🎭' },
        { id: 'whitelist', label: '白名单', icon: '👥' },
        { id: 'schedule', label: '在线时段', icon: '⏰' },
        { id: 'reply', label: '回复策略', icon: '💬' },
        { id: 'stickers', label: '表情包', icon: '🖼️' },
        { id: 'budget', label: '预算与安全', icon: '🛡️' },
        { id: 'logs', label: '日志与测试', icon: '🧪' },
        { id: 'market', label: '人格广场', icon: '🛍️' },
        { id: 'help', label: '帮助', icon: '❓' },
      ]

      const ZH = {
        nav: '微信分身',
        title: '微信分身',
        subtitle: '让微信小号用你的口吻自动聊天：本地零 token 决策、拟人节奏、表情包、按需搜索、预算与风控',
        layerLabel: '插件设置',
      }
      const EN = {
        nav: 'WeChat Persona',
        title: 'WeChat Persona',
        subtitle: 'An AI persona that chats on your WeChat alt account with human-like pacing and built-in guardrails.',
        layerLabel: 'Plugin settings',
      }

      function makeTranslate(dict) {
        return function translate(key, fallback) {
          const value = dict[key]
          if (typeof value === 'string') return value
          return fallback !== undefined ? fallback : key
        }
      }
      const t = makeTranslate(ZH)

      // =====================================================================
      // 纯逻辑工具（与 client/lib.js 同步，修改时请两边一起改）
      // =====================================================================
      function pad2(n) {
        return n < 10 ? '0' + n : String(n)
      }

      function toDate(value) {
        if (value === null || value === undefined || value === '') return null
        const d = value instanceof Date ? value : new Date(value)
        return Number.isNaN(d.getTime()) ? null : d
      }

      function clampNumber(value, min, max, fallback) {
        if (value === null || value === undefined) return fallback
        if (typeof value === 'string' && value.trim() === '') return fallback
        const n = typeof value === 'number' ? value : Number(String(value).trim())
        if (!Number.isFinite(n)) return fallback
        if (n < min) return min
        if (n > max) return max
        return n
      }

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

      function relativeTime(value, now) {
        const d = toDate(value)
        if (!d) return '—'
        const base = toDate(now) || new Date()
        const diff = base.getTime() - d.getTime()
        if (diff < 5000) return '刚刚'
        if (diff < 60000) return Math.floor(diff / 1000) + ' 秒前'
        if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
        if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
        return Math.floor(diff / 86400000) + ' 天前'
      }

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

      function formatUptime(seconds) {
        const n = Number(seconds)
        if (!Number.isFinite(n) || n < 0) return '—'
        return formatDuration(n * 1000)
      }

      function trimFixed(value, digits) {
        return value.toFixed(digits).replace(/\.0+$/, '')
      }

      function formatTokens(n) {
        const v = Number(n)
        if (!Number.isFinite(v) || v < 0) return '—'
        if (v < 1000) return String(Math.round(v))
        if (v < 10000) return trimFixed(v / 1000, 1) + 'k'
        if (v < 1000000) return Math.round(v / 1000) + 'k'
        return trimFixed(v / 1000000, 1) + 'M'
      }

      function formatBytes(n) {
        const v = Number(n)
        if (!Number.isFinite(v) || v < 0) return '—'
        if (v < 1024) return v + ' B'
        if (v < 1024 * 1024) return trimFixed(v / 1024, 1) + ' KB'
        return trimFixed(v / (1024 * 1024), 1) + ' MB'
      }

      function formatPercent(ratio, digits) {
        const v = Number(ratio)
        if (!Number.isFinite(v)) return '—'
        return (v * 100).toFixed(digits === undefined ? 0 : digits) + '%'
      }

      function ratioToPercentText(ratio) {
        const v = Number(ratio)
        if (!Number.isFinite(v)) return ''
        return String(Math.round(v * 1000) / 10)
      }

      function percentTextToRatio(text, fallback) {
        const n = Number(String(text === undefined || text === null ? '' : text).trim())
        if (!Number.isFinite(n)) return fallback
        return Math.min(1, Math.max(0, n / 100))
      }

      function parseTimeToMinutes(value) {
        if (typeof value !== 'string') return null
        const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
        if (!m) return null
        const h = Number(m[1])
        const min = Number(m[2])
        if (h > 23 || min > 59) return null
        return h * 60 + min
      }

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

      function isWithinWindow(nowMinutes, startMinutes, endMinutes) {
        if (startMinutes === null || endMinutes === null) return true
        if (startMinutes === endMinutes) return true
        if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes
        return nowMinutes >= startMinutes || nowMinutes < endMinutes
      }

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

      function describeOnlineWindow(schedule, dayIndex) {
        const win = resolveOnlineWindow(schedule, dayIndex)
        const sm = parseTimeToMinutes(win.start)
        const em = parseTimeToMinutes(win.end)
        const suffix = sm !== null && em !== null && em <= sm ? '（跨零点）' : ''
        const sourceLabel = win.source === 'workday' ? '工作日' : win.source === 'weekend' ? '周末' : '默认'
        return sourceLabel + ' ' + win.start + '–' + win.end + suffix
      }

      function isOnlineNow(schedule, now) {
        const d = toDate(now) || new Date()
        const win = resolveOnlineWindow(schedule, d.getDay())
        return isWithinWindow(d.getHours() * 60 + d.getMinutes(), parseTimeToMinutes(win.start), parseTimeToMinutes(win.end))
      }

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

      function parseWhitelistText(text) {
        const entries = []
        const errors = []
        const seen = new Set()
        const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim()
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

      function whitelistToText(entries) {
        return (entries || [])
          .map(function (entry) {
            const aliases = Array.isArray(entry.aliases) ? entry.aliases.join('|') : ''
            return [entry.id || '', entry.name || '', aliases, entry.note || ''].join(', ')
          })
          .join('\n')
      }

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

      function slugify(value) {
        const slug = String(value === undefined || value === null ? '' : value)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
          .replace(/^-+|-+$/g, '')
        return slug
      }

      function slugifyPersonaId(name) {
        const slug = slugify(name)
        if (/^[a-z0-9][a-z0-9-]*$/.test(slug) && slug.length >= 2) return slug.slice(0, 48)
        return 'persona-' + Date.now().toString(36)
      }

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

      function parsePersonaPackText(text) {
        const trimmed = trimText(text)
        if (!trimmed) return { ok: false, error: '内容为空' }
        let data
        try {
          data = JSON.parse(trimmed)
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
        if (!trimText(d.systemPrompt)) errors.push({ field: 'systemPrompt', message: '系统提示词不能为空（它是人设的核心）' })
        const exampleResult = parseExampleLines(d.examples)
        for (const message of exampleResult.errors) errors.push({ field: 'examples', message: message })
        return { ok: errors.length === 0, errors: errors, examples: exampleResult.examples }
      }

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

      function fileExt(name) {
        const m = /(\.[a-z0-9]+)$/i.exec(trimText(name))
        return m ? m[1].toLowerCase() : ''
      }

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

      function estimateBase64Bytes(base64) {
        const s = String(base64 === undefined || base64 === null ? '' : base64).replace(/\s+/g, '')
        if (!s) return 0
        const padding = s.slice(-2) === '==' ? 2 : s.slice(-1) === '=' ? 1 : 0
        return Math.floor((s.length * 3) / 4) - padding
      }

      function dataUrlToBase64(dataUrl) {
        const text = trimText(dataUrl)
        const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(text)
        if (!m) return { ok: false, error: '不是有效的 base64 图片数据' }
        const base64 = m[2].replace(/\s+/g, '')
        if (!base64) return { ok: false, error: '图片数据为空' }
        return { ok: true, mime: m[1], base64: base64, byteLength: estimateBase64Bytes(base64) }
      }

      function isPlainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value)
      }

      function countConfigChanges(prev, next) {
        function walk(a, b) {
          if (a === b) return 0
          if (!isPlainObject(a) || !isPlainObject(b)) {
            return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1
          }
          const keys = dedupe(Object.keys(a).concat(Object.keys(b)))
          let count = 0
          for (const key of keys) count += walk(a[key], b[key])
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

      function decorateEvents(events, limit) {
        const list = Array.isArray(events) ? events.slice() : []
        list.sort(function (a, b) {
          return (toDate(b && b.ts) ? new Date(b.ts).getTime() : 0) - (toDate(a && a.ts) ? new Date(a.ts).getTime() : 0)
        })
        return limit ? list.slice(0, limit) : list
      }

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

      // =====================================================================
      // 样式（只使用宿主 CSS 变量，避免污染全局）
      // =====================================================================
      const CSS = `
.dwp-root {
  --dwp-radius: 12px;
  --dwp-gap: 14px;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 13px;
  line-height: 1.55;
  font-family: inherit;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 16px 20px 40px;
  box-sizing: border-box;
}
.dwp-root *,
.dwp-root *::before,
.dwp-root *::after { box-sizing: border-box; }
.dwp-head { display: flex; flex-direction: column; gap: 10px; padding: 2px 0 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
.dwp-headRow { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dwp-titleWrap { min-width: 0; }
.dwp-title { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: .2px; }
.dwp-sub { margin: 4px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; max-width: 720px; }
.dwp-meta { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; display: flex; gap: 6px 14px; flex-wrap: wrap; align-items: center; }
.dwp-meta code { font-family: var(--dsh-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11.5px; background: var(--dsw-alias-bg-skeleton, rgba(0,0,0,.05)); border-radius: 5px; padding: 1px 5px; }
.dwp-tabs { display: flex; gap: 4px; flex-wrap: wrap; padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); position: sticky; top: 0; z-index: 5; background: var(--dsw-alias-bg-layer-1, #fff); }
.dwp-tab { appearance: none; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #646a73); border-radius: 8px; padding: 5px 10px; font-size: 12.5px; cursor: pointer; font-family: inherit; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; transition: background .12s ease, color .12s ease; }
.dwp-tab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.045)); color: var(--dsw-alias-label-primary, #1f2329); }
.dwp-tab[aria-selected="true"] { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1e6fff)); color: var(--dsw-alias-label-primary-foreground, #fff); font-weight: 600; }
.dwp-body { padding-top: var(--dwp-gap); display: flex; flex-direction: column; gap: var(--dwp-gap); min-width: 0; }
.dwp-banner { display: flex; align-items: flex-start; gap: 8px; border-radius: 10px; border: 1px solid transparent; padding: 8px 12px; font-size: 12.5px; }
.dwp-banner--error { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(245,63,63,.08)); border-color: var(--dsw-alias-state-error-primary, #f53f3f); color: var(--dsw-alias-state-error-primary, #d32029); }
.dwp-banner--warn { background: var(--dsw-alias-state-warn-tertiary, rgba(255,125,0,.10)); border-color: var(--dsw-alias-state-warn-primary, #ff7d00); color: var(--dsw-alias-state-warn-label, #ad4e00); }
.dwp-banner--success { background: var(--dsw-alias-state-success-secondary, rgba(0,180,42,.10)); border-color: var(--dsw-alias-state-success-primary, #00b42a); color: var(--dsw-alias-state-success-primary, #009a29); }
.dwp-banner--neutral { background: var(--dsw-alias-bg-skeleton, rgba(0,0,0,.05)); border-color: var(--dsw-alias-border-l1, rgba(0,0,0,.08)); color: var(--dsw-alias-label-secondary, #646a73); }
.dwp-bannerText { flex: 1; min-width: 0; word-break: break-word; }
.dwp-bannerClose { appearance: none; border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0 2px; font-size: 14px; line-height: 1; opacity: .75; }
.dwp-bannerClose:hover { opacity: 1; }
.dwp-card { border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); border-radius: var(--dwp-radius); background: var(--dsw-alias-bg-layer-1, #fff); min-width: 0; }
.dwp-card--danger { border-color: var(--dsw-alias-state-error-primary, #f53f3f); }
.dwp-cardHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 13px 16px 0; flex-wrap: wrap; }
.dwp-cardTitles { min-width: 0; }
.dwp-cardTitle { margin: 0; font-size: 14px; font-weight: 620; }
.dwp-cardDesc { margin: 3px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; }
.dwp-cardExtra { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dwp-cardBody { padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dwp-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px 18px; }
.dwp-grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px 16px; }
.dwp-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dwp-label { font-size: 12.5px; font-weight: 560; color: var(--dsw-alias-label-primary, #1f2329); display: flex; align-items: baseline; gap: 6px; }
.dwp-unit { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dwp-hint { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dwp-errorText { font-size: 11.5px; color: var(--dsw-alias-state-error-primary, #f53f3f); }
.dwp-input, .dwp-textarea, .dwp-select {
  width: 100%;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-primary, #1f2329);
  border-radius: 8px;
  padding: 6px 9px;
  font-size: 12.5px;
  font-family: inherit;
  outline: none;
  transition: border-color .12s ease, box-shadow .12s ease;
  min-width: 0;
}
.dwp-input:focus, .dwp-textarea:focus, .dwp-select:focus {
  border-color: var(--dsw-alias-brand-primary, #1e6fff);
  box-shadow: 0 0 0 2px var(--dsw-alias-interactive-bg-hover, rgba(30,111,255,.12));
}
.dwp-input:disabled, .dwp-textarea:disabled, .dwp-select:disabled { opacity: .6; cursor: not-allowed; }
.dwp-textarea { resize: vertical; min-height: 76px; line-height: 1.6; }
.dwp-textarea--code { font-family: var(--dsh-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; }
.dwp-input--mono { font-family: var(--dsh-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
.dwp-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12.5px; user-select: none; }
.dwp-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.dwp-switchTrack { width: 34px; height: 20px; border-radius: 999px; background: var(--dsw-alias-border-l2, rgba(0,0,0,.2)); position: relative; transition: background .15s ease; flex: none; }
.dwp-switchThumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s ease; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.dwp-switch input:checked + .dwp-switchTrack { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1e6fff)); }
.dwp-switch input:checked + .dwp-switchTrack .dwp-switchThumb { transform: translateX(14px); }
.dwp-switch input:focus-visible + .dwp-switchTrack { box-shadow: 0 0 0 2px var(--dsw-alias-interactive-bg-hover, rgba(30,111,255,.2)); }
.dwp-switch.is-disabled { opacity: .55; cursor: not-allowed; }
.dwp-switchLabel { color: var(--dsw-alias-label-primary, #1f2329); }
.dwp-switchHint { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11.5px; }
.dwp-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #1f2329); border-radius: 8px; padding: 6px 12px; font-size: 12.5px; font-family: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; transition: background .12s ease, border-color .12s ease, opacity .12s ease; }
.dwp-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.045)); }
.dwp-btn:disabled { opacity: .5; cursor: not-allowed; }
.dwp-btn--primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1e6fff)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); font-weight: 600; }
.dwp-btn--primary:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #1e6fff)); }
.dwp-btn--danger { color: var(--dsw-alias-state-error-primary, #f53f3f); border-color: var(--dsw-alias-state-error-primary, rgba(245,63,63,.5)); }
.dwp-btn--danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(245,63,63,.08)); }
.dwp-btn--ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary, #646a73); }
.dwp-btn--sm { padding: 3px 8px; font-size: 11.5px; border-radius: 6px; }
.dwp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dwp-row--spread { justify-content: space-between; }
.dwp-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dwp-spacer { flex: 1; }
.dwp-chip { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 1px 8px; font-size: 11.5px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.02)); white-space: nowrap; }
.dwp-chip--button { cursor: pointer; font-family: inherit; }
.dwp-chip--active { border-color: var(--dsw-alias-brand-primary, #1e6fff); color: var(--dsw-alias-brand-primary, #1e6fff); background: var(--dsw-alias-interactive-bg-hover, rgba(30,111,255,.08)); }
.dwp-badge { display: inline-flex; align-items: center; gap: 4px; border-radius: 6px; padding: 1px 7px; font-size: 11px; font-weight: 600; border: 1px solid transparent; white-space: nowrap; }
.dwp-badge--success { color: var(--dsw-alias-state-success-primary, #00b42a); background: var(--dsw-alias-state-success-secondary, rgba(0,180,42,.10)); }
.dwp-badge--warn { color: var(--dsw-alias-state-warn-label, #ad4e00); background: var(--dsw-alias-state-warn-tertiary, rgba(255,125,0,.10)); }
.dwp-badge--error { color: var(--dsw-alias-state-error-primary, #f53f3f); background: var(--dsw-alias-interactive-bg-hover-danger, rgba(245,63,63,.08)); }
.dwp-badge--neutral { color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-skeleton, rgba(0,0,0,.05)); }
.dwp-badge--brand { color: var(--dsw-alias-brand-primary, #1e6fff); background: var(--dsw-alias-interactive-bg-hover, rgba(30,111,255,.10)); }
.dwp-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.dwp-saveBar { display: flex; align-items: center; gap: 10px; justify-content: space-between; flex-wrap: wrap; border-top: 1px dashed var(--dsw-alias-border-l1, rgba(0,0,0,.1)); padding-top: 10px; margin-top: 2px; }
.dwp-saveMsg { font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
.dwp-saveMsg--muted { color: var(--dsw-alias-label-tertiary, #8f959e); }
.dwp-saveMsg--success { color: var(--dsw-alias-state-success-primary, #00b42a); }
.dwp-saveMsg--error { color: var(--dsw-alias-state-error-primary, #f53f3f); }
.dwp-saveMsg--warn { color: var(--dsw-alias-state-warn-label, #ad4e00); }
.dwp-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12.5px; align-items: baseline; }
.dwp-kvKey { color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
.dwp-kvVal { color: var(--dsw-alias-label-primary, #1f2329); min-width: 0; word-break: break-word; }
.dwp-progress { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-skeleton, rgba(0,0,0,.08)); overflow: hidden; }
.dwp-progressFill { height: 100%; border-radius: 999px; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1e6fff)); transition: width .2s ease; }
.dwp-progressFill--warn { background: var(--dsw-alias-state-warn-primary, #ff7d00); }
.dwp-progressFill--error { background: var(--dsw-alias-state-error-primary, #f53f3f); }
.dwp-loading { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12.5px; padding: 18px 0; }
.dwp-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15)); border-top-color: var(--dsw-alias-brand-primary, #1e6fff); animation: dwp-spin .8s linear infinite; display: inline-block; flex: none; }
.dwp-spinner--sm { width: 11px; height: 11px; border-width: 1.5px; }
@keyframes dwp-spin { to { transform: rotate(360deg); } }
.dwp-empty { padding: 22px 12px; text-align: center; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12.5px; }
.dwp-errorBox { border: 1px solid var(--dsw-alias-state-error-primary, #f53f3f); border-radius: 10px; padding: 10px 12px; background: var(--dsw-alias-interactive-bg-hover-danger, rgba(245,63,63,.06)); color: var(--dsw-alias-state-error-primary, #d32029); font-size: 12.5px; word-break: break-word; }
.dwp-list { display: flex; flex-direction: column; gap: 8px; }
.dwp-listRow { display: grid; grid-template-columns: 1.1fr 1fr 1.1fr 1.3fr auto; gap: 8px; align-items: end; }
.dwp-listRowHead { display: grid; grid-template-columns: 1.1fr 1fr 1.1fr 1.3fr auto; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8f959e); padding: 0 1px; }
.dwp-tableWrap { overflow: auto; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); border-radius: 10px; }
.dwp-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dwp-table th, .dwp-table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); vertical-align: top; }
.dwp-table tr:last-child td { border-bottom: 0; }
.dwp-table th { position: sticky; top: 0; background: var(--dsw-alias-bg-layer-2, #f7f8fa); color: var(--dsw-alias-label-tertiary, #8f959e); font-weight: 560; font-size: 11.5px; z-index: 1; }
.dwp-table td.dwp-mono, .dwp-mono { font-family: var(--dsh-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11.5px; }
.dwp-logDetail { color: var(--dsw-alias-label-secondary, #646a73); word-break: break-word; }
.dwp-stickerGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px; }
.dwp-sticker { border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); border-radius: 10px; overflow: hidden; background: var(--dsw-alias-bg-layer-2, #f7f8fa); display: flex; flex-direction: column; }
.dwp-stickerImg { width: 100%; height: 96px; object-fit: contain; display: block; background: var(--dsw-alias-bg-layer-3, #fff); }
.dwp-stickerFallback { height: 96px; display: flex; align-items: center; justify-content: center; font-size: 28px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dwp-stickerMeta { padding: 6px 8px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dwp-stickerName { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dwp-stickerActions { display: flex; justify-content: flex-end; padding: 0 6px 6px; }
.dwp-marketGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.dwp-marketCard { border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; background: var(--dsw-alias-bg-layer-1, #fff); }
.dwp-marketHead { display: flex; gap: 10px; align-items: flex-start; }
.dwp-avatar { width: 38px; height: 38px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px; background: var(--dsw-alias-bg-skeleton, rgba(0,0,0,.06)); flex: none; overflow: hidden; }
.dwp-avatar img { width: 100%; height: 100%; object-fit: cover; }
.dwp-marketName { font-weight: 620; font-size: 13px; }
.dwp-marketDesc { color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dwp-marketMeta { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11.5px; display: flex; gap: 10px; flex-wrap: wrap; }
.dwp-tagRow { display: flex; gap: 6px; flex-wrap: wrap; }
.dwp-personaCard { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.dwp-personaAvatar { width: 52px; height: 52px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 26px; background: var(--dsw-alias-bg-skeleton, rgba(0,0,0,.06)); flex: none; overflow: hidden; }
.dwp-sectionTitle { margin: 2px 0 0; font-size: 12.5px; font-weight: 620; color: var(--dsw-alias-label-secondary, #646a73); }
.dwp-md { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #646a73); line-height: 1.7; word-break: break-word; }
.dwp-mdHead { color: var(--dsw-alias-label-primary, #1f2329); margin: 10px 0 2px; font-size: 13px; }
.dwp-mdP { margin: 0 0 2px; white-space: pre-wrap; }
.dwp-mdLi { margin: 0 0 1px; padding-left: 4px; }
.dwp-mdGap { height: 6px; }
.dwp-mdCode { font-family: var(--dsh-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11.5px; background: var(--dsw-alias-bg-skeleton, rgba(0,0,0,.05)); border-radius: 6px; padding: 4px 8px; white-space: pre-wrap; }
.dwp-crash { border: 1px solid var(--dsw-alias-state-error-primary, #f53f3f); border-radius: 12px; padding: 16px; margin: 12px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.dwp-divider { height: 1px; background: var(--dsw-alias-border-l1, rgba(0,0,0,.08)); margin: 2px 0; }
.dwp-nowrap { white-space: nowrap; }
.dwp-srOnly { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
`

      // =====================================================================
      // Host API 访问层
      // =====================================================================
      function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms) })
      }

      class ApiError extends Error {
        constructor(message, code, status) {
          super(message)
          this.name = 'ApiError'
          this.code = code
          this.status = status
          this.httpStatus = Number(status) || 0
          this.parsedBody = false
          this.payload = null
          this.network = false
        }
      }

      /** 把 API 相对路径解析成当前页面下的真实路径（带 Host 前缀）。 */
      function apiUrl(path) {
        const rel = API_PREFIX + String(path === undefined || path === null ? '' : path).replace(/^\/+/, '')
        // 宿主把插件 API 挂在站点根路径（/dsh-wechat-persona/api/...）；
        // 不能用 document.baseURI 相对解析——GUI 的路由可能带目录前缀，
        // 会把请求拼成 /会话路径/dsh-wechat-persona/api/... 导致 404。
        return '/' + rel
      }

      function errorMessage(error) {
        if (!error) return '未知错误'
        if (typeof error === 'string') return error
        return String(error.message || error.error || error)
      }

      async function request(method, path, body, options) {
        const opts = options || {}
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
        const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REQUEST_TIMEOUT_MS
        const timer = controller ? setTimeout(function () { controller.abort() }, timeoutMs) : null
        const headers = { Accept: 'application/json', [HEADER_NAME]: HEADER_VALUE }
        let payload
        if (body !== undefined) {
          headers['Content-Type'] = 'application/json'
          payload = JSON.stringify(body)
        }
        try {
          const response = await fetch(apiUrl(path), {
            method: method,
            headers: headers,
            body: payload,
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller ? controller.signal : undefined,
          })
          const text = await response.text()
          let data = null
          if (text) {
            try {
              data = JSON.parse(text)
            } catch (error) {
              data = null
            }
          }
          if (!response.ok) {
            const message =
              data && (data.error || data.message)
                ? String(data.error || data.message)
                : text
                  ? text.slice(0, 200)
                  : 'HTTP ' + response.status
            const failure = new ApiError(message, data && data.code, response.status)
            failure.parsedBody = !!(data && typeof data === 'object')
            failure.payload = data
            throw failure
          }
          if (data && data.ok === false) {
            const failure = new ApiError(data.error || data.message || '请求失败', data.code, response.status)
            failure.parsedBody = true
            failure.payload = data
            throw failure
          }
          if (data === null) {
            const failure = new ApiError('Host 返回了非 JSON 内容', undefined, response.status)
            failure.parsedBody = false
            throw failure
          }
          return data
        } catch (error) {
          if (error instanceof ApiError) throw error
          if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
            const timeout = new ApiError('请求超时：Host 可能正在重载，稍后再试')
            timeout.network = true
            throw timeout
          }
          const network = new ApiError('网络请求失败：' + errorMessage(error))
          network.network = true
          throw network
        } finally {
          if (timer) clearTimeout(timer)
        }
      }

      const api = {
        getHealth: function () {
          return request('GET', 'health')
        },
        getStatus: function () {
          return request('GET', 'status')
        },
        getConfig: function () {
          return request('GET', 'config')
        },
        saveConfig: function (config) {
          return request('POST', 'config', { config: config }, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        getPersonas: function () {
          return request('GET', 'personas')
        },
        installPersona: function (pack) {
          return request('POST', 'personas/install', { pack: pack }, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        installPersonaFromUrl: function (url) {
          return request('POST', 'personas/install', { url: url }, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        importPersona: function (json) {
          return request('POST', 'personas/import', { json: json }, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        activatePersona: function (id) {
          return request('POST', 'personas/activate', { id: id }, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        deletePersona: function (id) {
          return request('DELETE', 'personas/' + encodeURIComponent(id))
        },
        exportPersona: function (id) {
          return request('GET', 'personas/export?id=' + encodeURIComponent(id))
        },
        getMarket: function () {
          return request('GET', 'market')
        },
        installFromMarket: function (id) {
          return request('POST', 'market/install', { id: id }, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        getStickers: function () {
          return request('GET', 'stickers')
        },
        uploadSticker: function (payload) {
          return request('POST', 'stickers/upload', payload, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        deleteSticker: function (id) {
          // 服务端实现可能从 body 或 query 读 id，两边都带上更稳。
          return request('DELETE', 'stickers?id=' + encodeURIComponent(id), { id: id })
        },
        stickerFileUrl: function (id) {
          return apiUrl('sticker-file?id=' + encodeURIComponent(id))
        },
        getLogs: function (limit) {
          return request('GET', 'logs?limit=' + encodeURIComponent(String(limit || 50)))
        },
        testInbound: function (payload) {
          return request('POST', 'test/inbound', payload, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        testSend: function (payload) {
          return request('POST', 'test/send', payload, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        /** Phase F：人格模拟器——强制 mockOnly，服务端在非 mock 通道直接 409 拒绝。 */
        testMockSend: function (payload) {
          const body = Object.assign({ mockOnly: true }, payload || {})
          return request('POST', 'test/send', body, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        /** Phase F：OCR / 读屏诊断（只读；通道未提供时返回 available:false）。 */
        getOcrDiagnostics: function () {
          return request('GET', 'diagnostics/ocr')
        },
        /** task-12 / 13.4：待发送草稿队列。批准才会发送，unknown 的草稿不会被自动重发。 */
        getDrafts: function () {
          return request('GET', 'drafts')
        },
        approveDraft: function (id) {
          return request('POST', 'drafts/approve', { id: id }, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        rejectDraft: function (id) {
          return request('POST', 'drafts/reject', { id: id }, { timeoutMs: SAVE_TIMEOUT_MS })
        },
        pause: function (reason) {
          return request('POST', 'pause', reason ? { reason: reason } : {})
        },
        resume: function () {
          return request('POST', 'resume', {})
        },
        clearMemory: function (contactId) {
          return request('POST', 'memory/clear', contactId ? { contactId: contactId } : {})
        },
        clearAudit: function () {
          return request('POST', 'audit/clear', {})
        },
        getHelp: function () {
          return request('GET', 'help')
        },
      }

      // =====================================================================
      // React 小工具 / hooks
      // =====================================================================
      function cx() {
        const parts = []
        for (let i = 0; i < arguments.length; i++) {
          const value = arguments[i]
          if (value) parts.push(String(value))
        }
        return parts.join(' ')
      }

      function useLoad(loader, deps) {
        const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
        const [tick, setTick] = React.useState(0)
        const loaderRef = React.useRef(loader)
        loaderRef.current = loader
        React.useEffect(
          function () {
            let alive = true
            setState(function (prev) {
              return { status: prev.data ? 'refreshing' : 'loading', data: prev.data, error: null }
            })
            Promise.resolve()
              .then(function () { return loaderRef.current() })
              .then(function (data) {
                if (!alive) return
                setState({ status: 'ready', data: data, error: null })
              })
              .catch(function (error) {
                if (!alive) return
                setState(function (prev) { return { status: 'error', data: prev.data, error: error } })
              })
            return function () { alive = false }
          },
          (deps || []).concat([tick]),
        )
        const reload = React.useCallback(function () { setTick(function (x) { return x + 1 }) }, [])
        return [state, reload]
      }

      /**
       * 表单草稿：初始值来自 config；当父级「放弃修改」递增 resetToken 时重建草稿。
       * make 用当前 props 的最新配置构造草稿（effect 里调用的是最新渲染闭包）。
       */
      function useDraftState(make, resetToken) {
        const [draft, setDraft] = React.useState(make)
        const tokenRef = React.useRef(resetToken)
        React.useEffect(
          function () {
            if (tokenRef.current !== resetToken) {
              tokenRef.current = resetToken
              setDraft(make())
            }
          },
          [resetToken],
        )
        return [draft, setDraft]
      }

      function useMessage() {
        const [message, setMessage] = React.useState(null)
        React.useEffect(
          function () {
            if (!message || message.tone === 'error') return undefined
            const timer = setTimeout(function () { setMessage(null) }, 5000)
            return function () { clearTimeout(timer) }
          },
          [message],
        )
        return [message, setMessage]
      }

      function useAsyncAction() {
        const [busy, setBusy] = React.useState(false)
        const run = React.useCallback(function (action) {
          setBusy(true)
          return Promise.resolve()
            .then(action)
            .finally(function () { setBusy(false) })
        }, [])
        return [busy, run]
      }

      function useTick(intervalMs) {
        const [now, setNow] = React.useState(function () { return Date.now() })
        React.useEffect(
          function () {
            const timer = setInterval(function () { setNow(Date.now()) }, intervalMs)
            return function () { clearInterval(timer) }
          },
          [intervalMs],
        )
        return now
      }

      /**
       * Host 的 /sticker-file 等二进制接口需要自定义请求头，<img src> 无法携带，
       * 因此先用 fetch 取回 blob 生成 object URL，并在卸载 / 换图时 revoke。
       */
      function isExternalUrl(src) {
        const value = trimText(src)
        if (!value) return false
        if (/^data:/i.test(value)) return true
        if (/^https?:\/\//i.test(value)) {
          try {
            return typeof location === 'undefined' || new URL(value).origin !== location.origin
          } catch (error) {
            return true
          }
        }
        return false
      }

      function useBlobImage(src) {
        const [state, setState] = React.useState({ status: src ? 'loading' : 'idle', url: null, error: null })
        const source = src ? String(src) : ''
        React.useEffect(
          function () {
            if (!source) {
              setState({ status: 'idle', url: null, error: null })
              return undefined
            }
            let alive = true
            let objectUrl = null
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
            setState({ status: 'loading', url: null, error: null })
            fetch(source, {
              method: 'GET',
              headers: { [HEADER_NAME]: HEADER_VALUE },
              cache: 'no-store',
              credentials: 'same-origin',
              signal: controller ? controller.signal : undefined,
            })
              .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status)
                return response.blob()
              })
              .then(function (blob) {
                if (!alive) return
                if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
                  throw new Error('当前环境不支持 object URL')
                }
                objectUrl = URL.createObjectURL(blob)
                setState({ status: 'ready', url: objectUrl, error: null })
              })
              .catch(function (error) {
                if (!alive) return
                setState({ status: 'error', url: null, error: errorMessage(error) })
              })
            return function () {
              alive = false
              if (controller) controller.abort()
              if (objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                URL.revokeObjectURL(objectUrl)
              }
            }
          },
          [source],
        )
        return state
      }

      function StickerImage(props) {
        const external = isExternalUrl(props.src)
        const image = useBlobImage(external ? null : props.src)
        if (external) {
          return h('img', { className: 'dwp-stickerImg', src: String(props.src), alt: props.alt || '', title: props.title })
        }
        if (image.status === 'ready' && image.url) {
          return h('img', { className: 'dwp-stickerImg', src: image.url, alt: props.alt || '', title: props.title })
        }
        return h(
          'div',
          {
            className: 'dwp-stickerImg dwp-stickerFallback',
            title: image.status === 'error' ? image.error || '图片加载失败' : props.title || '图片加载中',
          },
          image.status === 'error' ? '加载失败' : image.status === 'loading' ? '…' : '无图',
        )
      }

      function readFileAsDataUrl(file) {
        return new Promise(function (resolve, reject) {
          if (typeof FileReader === 'undefined') {
            reject(new Error('当前环境不支持读取本地文件'))
            return
          }
          const reader = new FileReader()
          reader.onload = function () { resolve(String(reader.result || '')) }
          reader.onerror = function () { reject(new Error('读取文件失败')) }
          reader.readAsDataURL(file)
        })
      }

      function readFileAsText(file) {
        return new Promise(function (resolve, reject) {
          if (typeof FileReader === 'undefined') {
            reject(new Error('当前环境不支持读取本地文件'))
            return
          }
          const reader = new FileReader()
          reader.onload = function () { resolve(String(reader.result || '')) }
          reader.onerror = function () { reject(new Error('读取文件失败')) }
          reader.readAsText(file, 'utf-8')
        })
      }

      function downloadTextFile(filename, text) {
        const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        setTimeout(function () {
          URL.revokeObjectURL(url)
          if (a.parentNode) a.parentNode.removeChild(a)
        }, 1000)
      }

      // =====================================================================
      // 基础 UI 组件
      // =====================================================================
      function Spinner(props) {
        return h('span', { className: cx('dwp-spinner', props && props.small && 'dwp-spinner--sm'), 'aria-hidden': true })
      }

      function Loading(props) {
        return h(
          'div',
          { className: 'dwp-loading' },
          h(Spinner),
          h('span', null, (props && props.text) || '加载中…'),
        )
      }

      function EmptyState(props) {
        return h('div', { className: 'dwp-empty' }, (props && props.children) || '暂无数据')
      }

      function Badge(props) {
        const tone = props.tone || 'neutral'
        return h('span', { className: cx('dwp-badge', 'dwp-badge--' + tone), title: props.title }, props.children)
      }

      function Chip(props) {
        const cls = cx('dwp-chip', props.active && 'dwp-chip--active', props.onClick && 'dwp-chip--button')
        if (props.onClick) {
          return h(
            'button',
            { type: 'button', className: cls, onClick: props.onClick, title: props.title, 'aria-pressed': !!props.active },
            props.children,
          )
        }
        return h('span', { className: cls, title: props.title }, props.children)
      }

      function Banner(props) {
        if (!props || !props.message) return null
        const tone = props.message.tone || 'neutral'
        return h(
          'div',
          { className: 'dwp-banner dwp-banner--' + tone, role: tone === 'error' ? 'alert' : 'status' },
          h('span', { className: 'dwp-bannerText' }, props.message.text),
          props.onClose
            ? h('button', { type: 'button', className: 'dwp-bannerClose', title: '关闭', onClick: props.onClose }, '×')
            : null,
        )
      }

      function Card(props) {
        return h(
          'section',
          { className: cx('dwp-card', props.danger && 'dwp-card--danger') },
          props.title || props.desc || props.extra
            ? h(
                'header',
                { className: 'dwp-cardHead' },
                h(
                  'div',
                  { className: 'dwp-cardTitles' },
                  props.title ? h('h3', { className: 'dwp-cardTitle' }, props.title) : null,
                  props.desc ? h('p', { className: 'dwp-cardDesc' }, props.desc) : null,
                ),
                props.extra ? h('div', { className: 'dwp-cardExtra' }, props.extra) : null,
              )
            : null,
          h('div', { className: 'dwp-cardBody' }, props.children),
        )
      }

      function Field(props) {
        return h(
          'label',
          { className: 'dwp-field' },
          h(
            'span',
            { className: 'dwp-label' },
            props.label,
            props.unit ? h('span', { className: 'dwp-unit' }, props.unit) : null,
          ),
          props.control,
          props.hint ? h('span', { className: 'dwp-hint' }, props.hint) : null,
          props.error ? h('span', { className: 'dwp-errorText' }, props.error) : null,
        )
      }

      function TextInput(props) {
        return h('input', {
          className: cx('dwp-input', props.mono && 'dwp-input--mono'),
          type: props.type || 'text',
          value: props.value === undefined || props.value === null ? '' : props.value,
          placeholder: props.placeholder,
          disabled: props.disabled,
          spellCheck: false,
          autoComplete: 'off',
          title: props.title,
          onChange: function (event) { props.onChange(event.target.value) },
        })
      }

      function NumberInput(props) {
        return h('input', {
          className: 'dwp-input',
          type: 'number',
          value: props.value === undefined || props.value === null ? '' : props.value,
          placeholder: props.placeholder,
          min: props.min,
          max: props.max,
          step: props.step || 1,
          disabled: props.disabled,
          title: props.title,
          onChange: function (event) { props.onChange(event.target.value) },
        })
      }

      function TextArea(props) {
        return h('textarea', {
          className: cx('dwp-textarea', props.code && 'dwp-textarea--code'),
          value: props.value === undefined || props.value === null ? '' : props.value,
          placeholder: props.placeholder,
          rows: props.rows || 3,
          disabled: props.disabled,
          spellCheck: false,
          onChange: function (event) { props.onChange(event.target.value) },
        })
      }

      function Select(props) {
        const options = props.options || []
        return h(
          'select',
          {
            className: 'dwp-select',
            value: props.value === undefined || props.value === null ? '' : String(props.value),
            disabled: props.disabled,
            title: props.title,
            onChange: function (event) { props.onChange(event.target.value) },
          },
          options.map(function (option) {
            return h(
              'option',
              { key: String(option.value), value: String(option.value), disabled: option.disabled },
              option.label,
            )
          }),
        )
      }

      function Switch(props) {
        return h(
          'label',
          { className: cx('dwp-switch', props.disabled && 'is-disabled'), title: props.title },
          h('input', {
            type: 'checkbox',
            checked: !!props.checked,
            disabled: props.disabled,
            onChange: function (event) { props.onChange(event.target.checked) },
          }),
          h('span', { className: 'dwp-switchTrack', 'aria-hidden': true }, h('span', { className: 'dwp-switchThumb' })),
          h('span', { className: 'dwp-switchLabel' }, props.label),
          props.hint ? h('span', { className: 'dwp-switchHint' }, props.hint) : null,
        )
      }

      function Button(props) {
        return h(
          'button',
          {
            type: 'button',
            className: cx(
              'dwp-btn',
              props.variant === 'primary' && 'dwp-btn--primary',
              props.variant === 'danger' && 'dwp-btn--danger',
              props.variant === 'ghost' && 'dwp-btn--ghost',
              props.size === 'sm' && 'dwp-btn--sm',
              props.className,
            ),
            title: props.title,
            disabled: props.disabled || props.busy,
            onClick: props.onClick,
          },
          props.busy ? h(Spinner, { small: true }) : null,
          props.busy ? ' 处理中…' : props.children,
        )
      }

      function ConfirmButton(props) {
        const [armed, setArmed] = React.useState(false)
        React.useEffect(
          function () {
            if (!armed) return undefined
            const timer = setTimeout(function () { setArmed(false) }, 5000)
            return function () { clearTimeout(timer) }
          },
          [armed],
        )
        return h(
          Button,
          {
            variant: armed ? 'danger' : props.variant,
            size: props.size,
            busy: props.busy,
            disabled: props.disabled,
            title: props.title,
            onClick: function () {
              if (!armed) {
                setArmed(true)
                return
              }
              setArmed(false)
              props.onConfirm()
            },
          },
          armed ? (props.confirmLabel || '再点一次确认') : props.label,
        )
      }

      function ProgressBar(props) {
        const max = Number(props.max)
        const value = Number(props.value)
        const ratio = Number.isFinite(max) && max > 0 ? Math.max(0, Math.min(1, (Number.isFinite(value) ? value : 0) / max)) : 0
        const tone = ratio >= 1 ? 'error' : ratio >= 0.85 ? 'warn' : 'normal'
        return h(
          'div',
          {
            className: 'dwp-progress',
            title: props.title || (formatTokens(value) + ' / ' + formatTokens(max)),
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': Number.isFinite(max) ? max : 0,
            'aria-valuenow': Number.isFinite(value) ? value : 0,
          },
          h('div', {
            className: cx('dwp-progressFill', tone === 'warn' && 'dwp-progressFill--warn', tone === 'error' && 'dwp-progressFill--error'),
            style: { width: Math.round(ratio * 100) + '%' },
          }),
        )
      }

      function KeyValue(props) {
        return h(
          'div',
          { className: 'dwp-kv' },
          props.items.map(function (item) {
            return h(
              React.Fragment,
              { key: item.key },
              h('span', { className: 'dwp-kvKey' }, item.label),
              h('span', { className: 'dwp-kvVal' }, item.value === undefined || item.value === null || item.value === '' ? '—' : item.value),
            )
          }),
        )
      }

      function SaveBar(props) {
        const message = props.message
        return h(
          'div',
          { className: 'dwp-saveBar' },
          h(
            'span',
            {
              className: cx(
                'dwp-saveMsg',
                !message && 'dwp-saveMsg--muted',
                message && 'dwp-saveMsg--' + (message.tone || 'neutral'),
              ),
            },
            message ? message.text : props.dirty ? '有未保存的修改' : '没有未保存的修改',
          ),
          h(
            'div',
            { className: 'dwp-actions' },
            props.extra || null,
            h(
              Button,
              { variant: 'ghost', onClick: props.onDiscard, disabled: !props.dirty || props.saving },
              props.discardLabel || '放弃修改',
            ),
            h(
              Button,
              {
                variant: 'primary',
                onClick: props.onSave,
                disabled: !props.dirty || props.saving || props.readOnly,
                busy: props.saving,
                title: props.readOnly ? props.readOnlyReason || '配置当前不可写' : undefined,
              },
              props.saveLabel || '保存',
            ),
          ),
        )
      }

      function MarkdownLite(props) {
        const lines = String(props.text || '').split(/\r?\n/)
        const nodes = []
        let inCode = false
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i]
          const line = raw.trim()
          if (/^```/.test(line)) {
            inCode = !inCode
            continue
          }
          if (inCode) {
            nodes.push(h('div', { key: i, className: 'dwp-mdCode' }, raw))
            continue
          }
          if (!line) {
            nodes.push(h('div', { key: i, className: 'dwp-mdGap' }))
            continue
          }
          const heading = /^(#{1,4})\s+(.*)$/.exec(line)
          if (heading) {
            const level = Math.min(6, heading[1].length + 2)
            nodes.push(h('h' + level, { key: i, className: 'dwp-mdHead' }, heading[2]))
            continue
          }
          const bullet = /^[-*+]\s+(.*)$/.exec(line)
          if (bullet) {
            nodes.push(h('div', { key: i, className: 'dwp-mdLi' }, '• ' + bullet[1]))
            continue
          }
          const ordered = /^(\d+)[.)]\s+(.*)$/.exec(line)
          if (ordered) {
            nodes.push(h('div', { key: i, className: 'dwp-mdLi' }, ordered[1] + '. ' + ordered[2]))
            continue
          }
          nodes.push(h('div', { key: i, className: 'dwp-mdP' }, line))
        }
        return h('div', { className: 'dwp-md' }, nodes)
      }

      function Avatar(props) {
        const value = trimText(props.value)
        const isImage = /^(https?:|\/|data:)/.test(value)
        return h(
          'div',
          { className: cx('dwp-avatar', props.large && 'dwp-personaAvatar') },
          isImage ? h('img', { src: value, alt: props.alt || '' }) : value || '🙂',
        )
      }

      class ErrorBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }
        static getDerivedStateFromError(error) {
          return { error: error }
        }
        componentDidCatch(error, info) {
          if (typeof console !== 'undefined') {
            console.error('[dsh-wechat-persona] 设置界面渲染失败', error, info)
          }
        }
        render() {
          if (this.state.error) {
            return h(
              'div',
              { className: 'dwp-root' },
              h(
                'div',
                { className: 'dwp-crash' },
                h('h3', { className: 'dwp-title' }, (this.props && this.props.label) || '设置界面渲染失败'),
                h('div', { className: 'dwp-errorBox' }, errorMessage(this.state.error)),
                h(
                  Button,
                  { variant: 'primary', onClick: () => this.setState({ error: null }) },
                  '重试渲染',
                ),
              ),
            )
          }
          return this.props.children
        }
      }

      // =====================================================================
      // 概览
      // =====================================================================
      function Stats(props) {
        const items = props.items || []
        return h(
          'div',
          { className: 'dwp-grid3' },
          items.map(function (item) {
            return h(
              'div',
              { key: item.key, className: 'dwp-kv' },
              h('span', { className: 'dwp-kvKey' }, item.label),
              h(
                'span',
                { className: 'dwp-kvVal' },
                item.value === undefined || item.value === null || item.value === '' ? '—' : item.value,
              ),
            )
          }),
        )
      }

      function SectionTitle(props) {
        return h('div', { className: 'dwp-sectionTitle' }, props.children)
      }

      function OverviewTab(props) {
        const s = props.shared
        const now = useTick(30000)
        const [busy, run] = useAsyncAction()
        const status = s.status || null
        const config = s.config || {}
        const view = engineStatusView(status)
        const schedule = config.schedule || {}
        const online = isOnlineNow(schedule, now)
        const nextAt = isOnlineNow(schedule, now) ? null : nextOnlineAt(schedule, now)
        const health = s.health || null
        const budget = status && status.budget ? status.budget : null
        const dailyTokens = Number(config.budget && config.budget.dailyTokens) || 0
        const spent = Number(budget && budget.spentTokens) || 0
        const cards = status && status.today ? auditSummaryCards(status.today) : []
        const persist = s.persist || {}

        const togglePause = function () {
          run(async function () {
            try {
              if (status && status.paused) {
                await api.resume()
                s.showBanner({ text: '已恢复自动回复', tone: 'success' })
              } else {
                await api.pause('在设置面板手动暂停')
                s.showBanner({ text: '已暂停自动回复，点击「继续运行」恢复', tone: 'warn' })
              }
              await s.refreshAll()
            } catch (error) {
              s.fail(error)
            }
          })
        }

        const clearMemory = function () {
          run(async function () {
            try {
              await api.clearMemory()
              s.showBanner({ text: '已请求清空联系人记忆', tone: 'success' })
              await s.refreshAll()
            } catch (error) {
              s.fail(error)
            }
          })
        }

        return h(
          'div',
          null,
          h(
            Card,
            {
              title: '运行状态',
              desc: '引擎、通道与在线时段的实时状态（每 30 秒自动刷新一次时钟）。',
              extra: h(
                'div',
                { className: 'dwp-actions' },
                h(Badge, { tone: view.tone }, view.label),
                h(Button, { size: 'sm', onClick: function () { s.refreshAll() } }, '刷新'),
              ),
            },
            h(KeyValue, {
              items: [
                { key: 'state', label: '引擎状态', value: h(Badge, { tone: view.tone }, view.label) },
                { key: 'detail', label: '说明', value: view.detail || '—' },
                {
                  key: 'channel',
                  label: '消息通道',
                  value:
                    (status && status.channelId ? status.channelId : config.activeChannel || '—') +
                    (status && status.channelState ? ' · ' + channelStateLabel(status.channelState) : ''),
                },
                {
                  key: 'persona',
                  label: '当前人格',
                  value: status && status.personaName ? status.personaName : (config.persona && config.persona.activeId) || '未启用人格',
                },
                {
                  key: 'online',
                  label: '在线时段',
                  value:
                    (online ? '在线中' : '不在线时段') +
                    ' · ' +
                    describeOnlineWindow(schedule, new Date().getDay()) +
                    (nextAt ? ' · 下次 ' + formatDateTime(nextAt) : ''),
                },
                {
                  key: 'activity',
                  label: '最后活动',
                  value: status && status.lastActivityAt ? relativeTime(status.lastActivityAt, now) : '暂无活动',
                },
              ],
            }),
            h('div', { className: 'dwp-divider' }),
            h(
              'div',
              { className: 'dwp-row' },
              h('span', { className: 'dwp-label' }, '今日预算 ' + formatTokens(spent) + ' / ' + formatTokens(dailyTokens) + ' tokens'),
              h(Badge, { tone: status && status.budgetPhase ? (status.budgetPhase === 'ok' ? 'success' : 'warn') : 'neutral' }, budgetPhaseLabel(status && status.budgetPhase)),
            ),
            h(ProgressBar, { value: spent, max: dailyTokens, title: '今日 token 预算' }),
            status && status.breaker && status.breaker.tripped
              ? h('div', { className: 'dwp-errorBox' }, '风控熔断已触发：' + (status.breaker.reason || '需要人工确认后恢复'))
              : null,
            h(
              'div',
              { className: 'dwp-actions', style: { marginTop: '12px' } },
              h(
                Button,
                { variant: status && status.paused ? 'primary' : 'ghost', busy: busy, onClick: togglePause },
                status && status.paused ? '继续运行' : '暂停回复',
              ),
              h('span', { className: 'dwp-spacer' }),
              h(Button, { onClick: function () { s.setTab('logs') } }, '查看日志'),
            ),
          ),
          h(
            Card,
            { title: '今日概览', desc: '来自今天的审计日志汇总，每天 0 点自动重置。' },
            cards.length
              ? h(Stats, { items: cards })
              : h(EmptyState, null, '今天还没有记录。收到消息或发送回复后会出现在这里。'),
          ),
          h(
            Card,
            {
              title: '插件信息',
              extra: h(Badge, { tone: health ? 'success' : 'neutral' }, health ? 'Host 已连接' : 'Host 未连接'),
            },
            h(KeyValue, {
              items: [
                { key: 'version', label: '插件版本', value: health && health.version ? health.version : '—' },
                { key: 'uptime', label: 'Host 已运行', value: health ? formatUptime(health.uptime) : '—' },
                { key: 'pid', label: 'Host 进程号', value: health && health.pid ? String(health.pid) : '—' },
                { key: 'saved', label: '配置上次保存', value: persist.lastSavedAt ? relativeTime(persist.lastSavedAt, now) : '本次会话未保存过' },
                {
                  key: 'editable',
                  label: '配置可写',
                  value: persist.editable === false ? h(Badge, { tone: 'warn' }, '只读') : h(Badge, { tone: 'success' }, '可编辑'),
                },
              ],
            }),
            persist.lastError ? h('div', { className: 'dwp-errorBox' }, '上次保存失败：' + persist.lastError) : null,
          ),
          h(
            Card,
            { title: '快捷操作', desc: '危险操作需要连点两次确认。' },
            h(
              'div',
              { className: 'dwp-actions' },
              h(ConfirmButton, {
                label: '清空联系人记忆',
                confirmLabel: '确认清空全部记忆？',
                variant: 'danger',
                busy: busy,
                onConfirm: clearMemory,
              }),
              h(ConfirmButton, {
                label: '清空审计日志',
                confirmLabel: '确认清空审计日志？',
                variant: 'danger',
                busy: busy,
                onConfirm: function () {
                  run(async function () {
                    try {
                      await api.clearAudit()
                      s.showBanner({ text: '审计日志已清空', tone: 'success' })
                      await s.refreshAll()
                    } catch (error) {
                      s.fail(error)
                    }
                  })
                },
              }),
              h('span', { className: 'dwp-spacer' }),
              h(Button, { onClick: function () { s.setTab('persona') } }, '管理人格'),
              h(Button, { onClick: function () { s.setTab('whitelist') } }, '编辑白名单'),
            ),
          ),
        )
      }

      // =====================================================================
      // 人格
      // =====================================================================
      function cloneJson(value) {
        try {
          return JSON.parse(JSON.stringify(value === undefined ? null : value))
        } catch (error) {
          return value
        }
      }

      /** 不可变地设置 a.b.c 路径上的值（用于配置表单）。 */
      function setPath(object, path, value) {
        const keys = String(path).split('.')
        const root = cloneJson(object)
        let node = root
        for (let i = 0; i < keys.length - 1; i++) {
          const key = keys[i]
          if (!isPlainObject(node[key])) node[key] = {}
          node = node[key]
        }
        node[keys[keys.length - 1]] = value
        return root
      }

      function getPath(object, path) {
        const keys = String(path).split('.')
        let node = object
        for (let i = 0; i < keys.length; i++) {
          if (node === null || node === undefined) return undefined
          node = node[keys[i]]
        }
        return node
      }

      const PERSONA_SOURCE_LABELS = { builtin: '内置', market: '广场', local: '本地' }

      function PersonaTab(props) {
        const s = props.shared
        const personasData = s.personas || { personas: [], activeId: '' }
        const personas = Array.isArray(personasData.personas) ? personasData.personas : []
        const [busy, run] = useAsyncAction()
        const [draft, setDraft] = useDraftState(function () { return cloneJson(s.config || {}) }, s.resetToken)
        const [editor, setEditor] = React.useState(null)
        const [editorErrors, setEditorErrors] = React.useState({})
        const [importText, setImportText] = React.useState('')
        const [urlText, setUrlText] = React.useState('')
        const fileRef = React.useRef(null)
        const dirty = configChanged(s.config, draft)
        const personaConfig = (draft && draft.persona) || {}
        const setConfig = function (path, value) { setDraft(setPath(draft, path, value)) }

        const showErrors = function (result) {
          const map = {}
          ;(result.errors || []).forEach(function (item) {
            if (!map[item.field]) map[item.field] = item.message
          })
          setEditorErrors(map)
        }

        const openCreate = function () {
          setEditorErrors({})
          setEditor({ mode: 'create', base: null, draft: personaDraftFromPack({}) })
        }

        const openEdit = function (summary) {
          setEditorErrors({})
          run(async function () {
            let base = null
            let fallback = false
            try {
              const response = await api.exportPersona(summary.id)
              const candidate = response && (response.persona || response.pack || response)
              if (candidate && Number(candidate.version) === 2) base = candidate
            } catch (error) {
              base = null
            }
            if (!base) {
              base = personaPackFromSummary(summary)
              fallback = true
            }
            setEditor({ mode: 'edit', base: base, draft: personaDraftFromPack(base), fallback: fallback })
          })
        }

        const submitEditor = function () {
          if (!editor) return
          const result = validatePersonaDraft(editor.draft)
          if (!result.ok) {
            showErrors(result)
            return
          }
          setEditorErrors({})
          run(async function () {
            try {
              const pack = personaDraftToPack(editor.draft, editor.base)
              const response = await api.installPersona(pack)
              s.showBanner({
                text: (response && response.updated ? '已更新人格：' : '已安装人格：') + pack.name,
                tone: 'success',
              })
              setEditor(null)
              await s.refreshAll()
            } catch (error) {
              s.fail(error)
            }
          })
        }

        const importPack = function (text, label) {
          const parsed = parsePersonaPackText(text)
          if (!parsed.ok) {
            s.showBanner({ text: (label || '导入') + '失败：' + parsed.error, tone: 'error' })
            return
          }
          run(async function () {
            try {
              const response = await api.installPersona(parsed.pack)
              s.showBanner({
                text: (response && response.updated ? '已更新人格：' : '已导入人格：') + parsed.pack.name,
                tone: 'success',
              })
              setImportText('')
              await s.refreshAll()
            } catch (error) {
              s.fail(error)
            }
          })
        }

        const importFile = function (file) {
          if (!file) return
          if (isZipFilename(file.name)) {
            s.showBanner({ text: '暂不支持 .zip 人格包：请解压后导入其中的 persona.json', tone: 'warn' })
            return
          }
          run(async function () {
            try {
              const text = await readFileAsText(file)
              importPack(text, '文件导入')
            } catch (error) {
              s.fail(error)
            }
          })
        }

        const activate = function (summary) {
          run(async function () {
            try {
              await api.activatePersona(summary.id)
              s.showBanner({ text: '已启用人格：' + summary.name + '（Host 异步生效）', tone: 'success' })
            } catch (error) {
              // 启用会走 Host 配置保存 → 触发插件重载，连接可能在响应前被拆掉；
              // 只有服务端明确返回 JSON 错误才算失败，其余按「已提交、重载中」处理。
              if (saveFailureText(error) !== null) {
                s.fail(error)
                return
              }
              s.showBanner({ text: '已提交启用人格：' + summary.name + '，插件正在重载…', tone: 'warn' })
            }
            await sleep(1500)
            await s.refreshAll()
          })
        }

        const remove = function (summary) {
          run(async function () {
            try {
              await api.deletePersona(summary.id)
              s.showBanner({ text: '已删除人格：' + summary.name, tone: 'success' })
              await s.refreshAll()
            } catch (error) {
              s.fail(error)
            }
          })
        }

        const exportOne = function (summary) {
          run(async function () {
            let pack = null
            try {
              const response = await api.exportPersona(summary.id)
              const candidate = response && (response.persona || response.pack || response)
              if (candidate && Number(candidate.version) === 2) pack = candidate
            } catch (error) {
              pack = null
            }
            let note = ''
            if (!pack) {
              pack = personaPackFromSummary(summary)
              note = '（服务端没有导出接口，已根据摘要字段生成，可能缺少系统提示词）'
            }
            downloadTextFile(personaExportFilename(pack.id || summary.id), JSON.stringify(pack, null, 2))
            s.showBanner({ text: '已导出人格：' + (pack.name || summary.name) + note, tone: 'success' })
          })
        }

        const editorCard = editor
          ? h(
              Card,
              {
                title: editor.mode === 'create' ? '新建人格' : '编辑人格：' + (editor.draft.name || editor.base.name || ''),
                desc: '人格包会保存到 Host 的人格目录；保存后同名人格会被覆盖（updated）。',
                extra: h(Badge, { tone: 'brand' }, 'PersonaPackV2'),
              },
              editor.fallback
                ? h(
                    'div',
                    { className: 'dwp-banner dwp-banner--warn' },
                    h('span', { className: 'dwp-bannerText' }, '未取到完整人格包：已用摘要字段重建，「系统提示词、口头禅、示例、禁忌」可能为空，请补全后再保存。'),
                  )
                : null,
              h(
                'div',
                { className: 'dwp-grid2' },
                h(Field, {
                  label: '人格 id',
                  hint: '小写字母 / 数字 / - / _，安装后作为目录名，不建议随便改。',
                  error: editorErrors.id,
                  control: h(TextInput, {
                    value: editor.draft.id,
                    mono: true,
                    placeholder: '例如 xiaohao-1',
                    onChange: function (value) { setEditor(Object.assign({}, editor, { draft: Object.assign({}, editor.draft, { id: value }) })) },
                  }),
                }),
                h(Field, {
                  label: '人格名称',
                  hint: '显示在设置页和「当前人格」里。',
                  error: editorErrors.name,
                  control: h(TextInput, {
                    value: editor.draft.name,
                    placeholder: '例如 小号',
                    onChange: function (value) { setEditor(Object.assign({}, editor, { draft: Object.assign({}, editor.draft, { name: value }) })) },
                  }),
                }),
                h(Field, {
                  label: '头像',
                  hint: '图片 URL 或一个 emoji（例如 🌙）。',
                  control: h(TextInput, {
                    value: editor.draft.avatar,
                    placeholder: 'https://… 或 🙂',
                    onChange: function (value) { setEditor(Object.assign({}, editor, { draft: Object.assign({}, editor.draft, { avatar: value }) })) },
                  }),
                }),
                h(Field, {
                  label: '作者',
                  hint: '可留空，默认 local。',
                  control: h(TextInput, {
                    value: editor.draft.author,
                    placeholder: 'local',
                    onChange: function (value) { setEditor(Object.assign({}, editor, { draft: Object.assign({}, editor.draft, { author: value }) })) },
                  }),
                }),
                h(Field, {
                  label: '说话风格',
                  hint: '一句话描述语气，例如「温柔、话少、爱用波浪号」。',
                  control: h(TextInput, {
                    value: editor.draft.style,
                    placeholder: '温柔、话少、爱用波浪号',
                    onChange: function (value) { setEditor(Object.assign({}, editor, { draft: Object.assign({}, editor.draft, { style: value }) })) },
                  }),
                }),
                h(Field, {
                  label: '标签',
                  hint: '用逗号分隔，用于广场展示与搜索。',
                  control: h(TextInput, {
                    value: editor.draft.tags,
                    placeholder: '温柔, 话少, 学生',
                    onChange: function (value) { setEditor(Object.assign({}, editor, { draft: Object.assign({}, editor.draft, { tags: value }) })) },
                  }),
                }),
              ),
              h(Field, {
                label: '简介',
                control: h(TextArea, {
                  value: editor.draft.description,
                  rows: 2,
                  placeholder: '一句话介绍这个人格',
                  onChange: function (value) { setEditor(Object.assign({}, editor, { draft: Object.assign({}, editor.draft, { description: value }) })) },
                }),
              }),
              h(Field, {
                label: '系统提示词',
                hint: '人设的核心。会被拼进每次回复的提示词里，建议 100–800 字。',
                error: editorErrors.systemPrompt,
                control: h(TextArea, {
                  value: editor.draft.systemPrompt,
                  code: true,
                  rows: 6,
                  placeholder: '你叫小号，是一个……',
                  onChange: function (value) { setEditor(Object.assign({}, editor, { draft: Object.assign({}, editor.draft, { systemPrompt: value }) })) },
                }),
              }),
              h(
                'div',
                { className: 'dwp-grid2' },
                h(Field, {
                  label: '口头禅',
                  hint: '每行一句，回复时可自然带出。',
                  control: h(TextArea, {
                    value: editor.draft.catchphrases,
                    rows: 3,
                    placeholder: '好耶\n笑死',
                    onChange: function (value) { setEditor(Object.assign({}, editor, { draft: Object.assign({}, editor.draft, { catchphrases: value }) })) },
                  }),
                }),
                h(Field, {
                  label: '禁忌',
                  hint: '每行一条，绝不谈论的话题。',
                  control: h(TextArea, {
                    value: editor.draft.taboo,
                    rows: 3,
                    placeholder: '不谈钱\n不聊政治',
                    onChange: function (value) { setEditor(Object.assign({}, editor, { draft: Object.assign({}, editor.draft, { taboo: value }) })) },
                  }),
                }),
              ),
              h(Field, {
                label: '对话示例',
                hint: '每行一条，格式「用户 => 回复」，也支持 → 或 Tab 分隔。',
                error: editorErrors.examples,
                control: h(TextArea, {
                  value: editor.draft.examples,
                  code: true,
                  rows: 4,
                  placeholder: '你好呀 => 嗨~ 在忙吗\n晚安 => 晚安，做个好梦',
                  onChange: function (value) { setEditor(Object.assign({}, editor, { draft: Object.assign({}, editor.draft, { examples: value }) })) },
                }),
              }),
              h(
                'div',
                { className: 'dwp-actions' },
                editor.mode === 'create'
                  ? h(
                      Button,
                      {
                        onClick: function () {
                          const next = cloneJson(editor.draft)
                          next.id = slugifyPersonaId(next.name || '')
                          setEditor(Object.assign({}, editor, { draft: next }))
                        },
                      },
                      '按名称生成 id',
                    )
                  : null,
                h('span', { className: 'dwp-spacer' }),
                h(Button, { variant: 'ghost', onClick: function () { setEditor(null) } }, '取消'),
                h(Button, { variant: 'primary', busy: busy, onClick: submitEditor }, '保存人格'),
              ),
            )
          : null

        return h(
          'div',
          null,
          h(
            Card,
            {
              title: '人格总开关',
              desc: '关闭后不再生成人格回复；也可以在这里切换当前人格。',
              extra: h(SaveBar, {
                dirty: dirty,
                saving: s.saving,
                readOnly: s.readOnly,
                readOnlyReason: s.readOnlyReason,
                onSave: function () { s.saveConfig(draft) },
                onDiscard: s.discard,
              }),
            },
            h(
              'div',
              { className: 'dwp-grid2' },
              h(
                'div',
                { className: 'dwp-field' },
                h(Switch, {
                  checked: personaConfig.enabled !== false,
                  onChange: function (value) { setConfig('persona.enabled', value) },
                  label: '启用人格回复',
                  hint: '关闭后只保留通道与日志能力。',
                }),
              ),
              h(Select, {
                options: [{ value: '', label: '（不启用人格）' }].concat(
                  personas.map(function (item) {
                    return { value: item.id, label: item.name + (item.active ? '（当前）' : '') }
                  }),
                ),
                value: personaConfig.activeId || '',
                onChange: function (value) { setConfig('persona.activeId', value) },
              }),
            ),
            h('div', { className: 'dwp-hint' }, '提示：点下方人格卡片的「启用」按钮会调用 /personas/activate，异步生效后这里会自动同步。'),
          ),
          editorCard,
          h(
            Card,
            {
              title: '已安装人格',
              desc: '共 ' + personas.length + ' 个。内置人格来自插件包，广场人格来自市场。',
              extra: h(
                'div',
                { className: 'dwp-actions' },
                h(Button, { size: 'sm', onClick: function () { s.refreshPersonas() } }, '刷新'),
                h(Button, { variant: 'primary', size: 'sm', onClick: openCreate }, '新建人格'),
              ),
            },
            personas.length
              ? h(
                  'div',
                  { className: 'dwp-marketGrid' },
                  personas.map(function (item) {
                    return h(
                      'div',
                      { key: item.id, className: cx('dwp-personaCard', item.active && 'dwp-personaCard--active') },
                      h(
                        'div',
                        { className: 'dwp-marketHead' },
                        h(Avatar, { value: item.avatar, large: true, alt: item.name }),
                        h(
                          'div',
                          null,
                          h('div', { className: 'dwp-marketName' }, item.name || item.id),
                          h(
                            'div',
                            { className: 'dwp-marketMeta' },
                            h(Badge, { tone: item.active ? 'success' : 'neutral' }, item.active ? '使用中' : '未启用'),
                            h(Badge, { tone: 'neutral' }, PERSONA_SOURCE_LABELS[item.source] || item.source || '本地'),
                            item.packVersion ? h(Badge, { tone: 'neutral' }, 'v' + item.packVersion) : null,
                          ),
                        ),
                      ),
                      item.style ? h('div', { className: 'dwp-marketDesc' }, item.style) : null,
                      item.description ? h('div', { className: 'dwp-marketDesc' }, item.description) : null,
                      (item.tags || []).length
                        ? h(
                            'div',
                            { className: 'dwp-tagRow' },
                            item.tags.map(function (tag) {
                              return h(Chip, { key: tag }, tag)
                            }),
                          )
                        : null,
                      h(
                        'div',
                        { className: 'dwp-actions', style: { marginTop: '10px' } },
                        h(
                          Button,
                          { size: 'sm', variant: item.active ? 'ghost' : 'primary', disabled: item.active || busy, onClick: function () { activate(item) } },
                          item.active ? '已启用' : '启用',
                        ),
                        h(Button, { size: 'sm', onClick: function () { openEdit(item) }, disabled: busy }, '编辑'),
                        h(Button, { size: 'sm', onClick: function () { exportOne(item) }, disabled: busy }, '导出'),
                        h(ConfirmButton, {
                          size: 'sm',
                          variant: 'danger',
                          label: '删除',
                          confirmLabel: '确认删除？',
                          disabled: busy,
                          onConfirm: function () { remove(item) },
                        }),
                      ),
                    )
                  }),
                )
              : h(EmptyState, null, '还没有安装人格。可以在下方导入 JSON，或到「人格广场」安装。'),
          ),
          h(
            Card,
            {
              title: '导入人格',
              desc: '支持粘贴 PersonaPackV2 JSON、选择 .json 文件，或从 URL 安装。',
              extra: h(Badge, { tone: 'neutral' }, '不支持 .zip'),
            },
            h(Field, {
              label: '粘贴 JSON',
              control: h(TextArea, {
                value: importText,
                code: true,
                rows: 5,
                placeholder: '{ "version": 2, "id": "…", "name": "…", "systemPrompt": "…" }',
                onChange: setImportText,
              }),
            }),
            h(
              'div',
              { className: 'dwp-actions' },
              h(
                Button,
                { variant: 'primary', busy: busy, disabled: !trimText(importText), onClick: function () { importPack(importText, '导入') } },
                '导入粘贴的 JSON',
              ),
              h(
                Button,
                {
                  onClick: function () {
                    if (fileRef.current) fileRef.current.click()
                  },
                },
                '选择 JSON 文件',
              ),
              h('input', {
                ref: fileRef,
                type: 'file',
                accept: '.json,application/json',
                style: { display: 'none' },
                onChange: function (event) {
                  const file = event.target.files && event.target.files[0]
                  importFile(file)
                  event.target.value = ''
                },
              }),
            ),
            h('div', { className: 'dwp-divider' }),
            h(
              'div',
              { className: 'dwp-row' },
              h('div', { style: { flex: '1 1 auto' } },
                h(Field, {
                  label: '从 URL 安装',
                  hint: 'Host 会下载该 URL 的 JSON 人格包（需要网络）。',
                  control: h(TextInput, {
                    value: urlText,
                    placeholder: 'https://example.com/persona.json',
                    onChange: setUrlText,
                  }),
                }),
              ),
              h(
                Button,
                {
                  variant: 'primary',
                  busy: busy,
                  disabled: !trimText(urlText),
                  onClick: function () {
                    const url = trimText(urlText)
                    if (!url) return
                    run(async function () {
                      try {
                        const response = await api.installPersonaFromUrl(url)
                        const persona = response && response.persona ? response.persona : {}
                        s.showBanner({ text: '已从 URL 安装人格：' + (persona.name || url), tone: 'success' })
                        setUrlText('')
                        await s.refreshAll()
                      } catch (error) {
                        s.fail(error)
                      }
                    })
                  },
                },
                '从 URL 安装',
              ),
            ),
          ),
        )
      }

      // =====================================================================
      // 白名单
      // =====================================================================
      function WhitelistTab(props) {
        const s = props.shared
        const [draft, setDraft] = useDraftState(function () { return cloneJson(s.config || {}) }, s.resetToken)
        const [query, setQuery] = React.useState('')
        const [batch, setBatch] = React.useState(null)
        const [saveErrors, setSaveErrors] = React.useState([])
        const whitelist = Array.isArray(draft.whitelist) ? draft.whitelist : []
        const dirty = configChanged(s.config, draft)

        const updateEntry = function (index, patch) {
          const next = whitelist.map(function (entry, i) {
            return i === index ? Object.assign({}, entry, patch) : entry
          })
          setDraft(setPath(draft, 'whitelist', next))
        }

        const removeEntry = function (index) {
          const next = whitelist.filter(function (entry, i) { return i !== index })
          setDraft(setPath(draft, 'whitelist', next))
        }

        const addEntry = function () {
          setDraft(setPath(draft, 'whitelist', whitelist.concat([{ id: '', name: '', aliases: [], note: '' }])))
        }

        const save = function () {
          const errors = validateWhitelistEntries(whitelist)
          if (errors.length) {
            setSaveErrors(errors)
            s.showBanner({ text: '白名单有误：' + errors[0], tone: 'error' })
            return
          }
          setSaveErrors([])
          s.saveConfig(draft)
        }

        const openBatch = function () {
          setBatch({ text: whitelistToText(whitelist), errors: [] })
        }

        const applyBatch = function () {
          const parsed = parseWhitelistText(batch.text)
          setBatch({ text: batch.text, errors: parsed.errors })
          if (parsed.errors.length) {
            s.showBanner({ text: '文本解析有问题：' + parsed.errors[0], tone: 'error' })
            return
          }
          setDraft(setPath(draft, 'whitelist', parsed.entries))
          s.showBanner({ text: '已用文本内容替换白名单（共 ' + parsed.entries.length + ' 条），记得点保存', tone: 'success' })
        }

        const filtered = filterWhitelist(whitelist, query)

        return h(
          'div',
          null,
          h(
            Card,
            {
              title: '白名单设置',
              desc: '只回复名单内的联系人。备注名必须和微信里的「备注名」完全一致，否则永远匹配不上。',
              extra: h(SaveBar, {
                dirty: dirty,
                saving: s.saving,
                readOnly: s.readOnly,
                readOnlyReason: s.readOnlyReason,
                onSave: save,
                onDiscard: s.discard,
              }),
            },
            h(
              'div',
              { className: 'dwp-grid2' },
              h(Switch, {
                checked: draft.whitelistOnly !== false,
                onChange: function (value) { setDraft(setPath(draft, 'whitelistOnly', value)) },
                label: '只回复白名单联系人',
                hint: '关闭后理论上会回复所有人，不建议。',
              }),
              h(Field, {
                label: '主人称呼',
                hint: '回复里提到你时用的称呼。',
                control: h(TextInput, {
                  value: draft.ownerName || '',
                  placeholder: '主人',
                  onChange: function (value) { setDraft(setPath(draft, 'ownerName', value)) },
                }),
              }),
            ),
          ),
          h(
            Card,
            {
              title: '名单成员',
              desc: '共 ' + whitelist.length + ' 条。别名用于匹配联系人的其它可能显示名。',
              extra: h(
                'div',
                { className: 'dwp-actions' },
                h(Button, { size: 'sm', onClick: openBatch }, '批量编辑'),
                h(Button, { variant: 'primary', size: 'sm', onClick: addEntry }, '添加成员'),
              ),
            },
            whitelist.length
              ? h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'dwp-row' },
                    h('div', { style: { width: '260px' } },
                      h(TextInput, { value: query, placeholder: '搜索备注名 / 昵称 / 别名 / 备注', onChange: setQuery }),
                    ),
                    h('span', { className: 'dwp-spacer' }),
                    query ? h(Badge, { tone: 'neutral' }, '匹配 ' + filtered.length + ' 条') : null,
                  ),
                  h(
                    'div',
                    { className: 'dwp-tableWrap' },
                    h(
                      'div',
                      { className: 'dwp-listRow dwp-listRowHead' },
                      h('span', null, '备注名（必填）'),
                      h('span', null, '昵称'),
                      h('span', null, '别名'),
                      h('span', null, '备注'),
                      h('span', null, '操作'),
                    ),
                    filtered.map(function (entry) {
                      const index = whitelist.indexOf(entry)
                      return h(
                        'div',
                        { key: 'entry-' + index, className: 'dwp-listRow' },
                        h(TextInput, {
                          value: entry.id || '',
                          placeholder: '微信备注名',
                          onChange: function (value) { updateEntry(index, { id: value }) },
                        }),
                        h(TextInput, {
                          value: entry.name || '',
                          placeholder: '昵称（可选）',
                          onChange: function (value) { updateEntry(index, { name: value }) },
                        }),
                        h(TextInput, {
                          value: Array.isArray(entry.aliases) ? entry.aliases.join('、') : '',
                          placeholder: '别名，用、分隔',
                          onChange: function (value) { updateEntry(index, { aliases: parseAliases(value) }) },
                        }),
                        h(TextInput, {
                          value: entry.note || '',
                          placeholder: '备注（可选）',
                          onChange: function (value) { updateEntry(index, { note: value }) },
                        }),
                        h(
                          Button,
                          { size: 'sm', variant: 'danger', onClick: function () { removeEntry(index) } },
                          '删除',
                        ),
                      )
                    }),
                  ),
                )
              : h(EmptyState, null, '白名单为空。点「添加成员」或「批量编辑」开始。'),
            saveErrors.length
              ? h('div', { className: 'dwp-errorBox' }, saveErrors.join('；'))
              : null,
          ),
          batch
            ? h(
                Card,
                {
                  title: '批量编辑白名单',
                  desc: '每行一条：备注名, 昵称, 别名1|别名2, 备注（逗号分隔，昵称/别名/备注可省略）。',
                  extra: h(Button, { size: 'sm', variant: 'ghost', onClick: function () { setBatch(null) } }, '关闭'),
                },
                h(Field, {
                  label: '名单文本',
                  hint: WHITELIST_TEXT_HINT,
                  control: h(TextArea, {
                    value: batch.text,
                    code: true,
                    rows: 8,
                    placeholder: '小明, 小明同学, 明明|小明明, 大学室友\n老妈\n老板',
                    onChange: function (value) { setBatch(Object.assign({}, batch, { text: value })) },
                  }),
                }),
                batch.errors.length ? h('div', { className: 'dwp-errorBox' }, batch.errors.join('；')) : null,
                h(
                  'div',
                  { className: 'dwp-actions' },
                  h(Button, { variant: 'primary', onClick: applyBatch }, '解析并替换'),
                  h(Button, {
                    onClick: function () { setBatch({ text: whitelistToText(whitelist), errors: [] }) },
                  }, '重新载入当前名单'),
                ),
              )
            : null,
        )
      }

      // =====================================================================
      // 在线时段
      // =====================================================================
      function ScheduleTab(props) {
        const s = props.shared
        const [draft, setDraft] = useDraftState(function () { return cloneJson(s.config || {}) }, s.resetToken)
        const schedule = draft.schedule || {}
        const dirty = configChanged(s.config, draft)
        const now = new Date()
        const online = isOnlineNow(schedule, now)
        const next = nextOnlineAt(schedule, now)
        const timeError = function (label, value) {
          const text = trimText(value)
          if (!text) return null
          return parseTimeToMinutes(text) === null ? label + '格式应为 HH:mm，例如 08:30' : null
        }
        const errors = [
          timeError('在线开始时间', schedule.onlineStart),
          timeError('在线结束时间', schedule.onlineEnd),
          timeError('工作日开始时间', schedule.workdayStart),
          timeError('工作日结束时间', schedule.workdayEnd),
          timeError('周末开始时间', schedule.weekendStart),
          timeError('周末结束时间', schedule.weekendEnd),
        ].filter(Boolean)
        const setSchedule = function (key, value) { setDraft(setPath(draft, 'schedule.' + key, value)) }
        const timeControl = function (key, placeholder) {
          return h(TextInput, {
            type: 'time',
            value: schedule[key] || '',
            placeholder: placeholder,
            onChange: function (value) { setSchedule(key, value) },
          })
        }

        const save = function () {
          if (errors.length) {
            s.showBanner({ text: errors[0], tone: 'error' })
            return
          }
          s.saveConfig(draft)
        }

        return h(
          'div',
          null,
          h(
            Card,
            {
              title: '在线时段',
              desc: '只在时段内自动回复，避免半夜打扰。时间使用本机时区，支持跨零点（例如 22:00–02:00）。',
              extra: h(SaveBar, {
                dirty: dirty,
                saving: s.saving,
                readOnly: s.readOnly,
                readOnlyReason: s.readOnlyReason,
                onSave: save,
                onDiscard: s.discard,
              }),
            },
            h(
              'div',
              { className: 'dwp-grid2' },
              h(Field, { label: '默认开始时间', control: timeControl('onlineStart') }),
              h(Field, { label: '默认结束时间', control: timeControl('onlineEnd') }),
            ),
            h(
              'div',
              { className: 'dwp-grid2' },
              h(Field, {
                label: '工作日开始时间',
                hint: '留空则使用默认时段（周一至周五）。',
                control: timeControl('workdayStart'),
              }),
              h(Field, {
                label: '工作日结束时间',
                hint: '开始与结束都填了才生效。',
                control: timeControl('workdayEnd'),
              }),
            ),
            h(
              'div',
              { className: 'dwp-grid2' },
              h(Field, {
                label: '周末开始时间',
                hint: '留空则使用默认时段（周六、周日）。',
                control: timeControl('weekendStart'),
              }),
              h(Field, {
                label: '周末结束时间',
                hint: '开始与结束都填了才生效。',
                control: timeControl('weekendEnd'),
              }),
            ),
            h(Switch, {
              checked: schedule.pauseOutsideHours !== false,
              onChange: function (value) { setSchedule('pauseOutsideHours', value) },
              label: '时段外暂停回复',
              hint: '关掉后时段只用于判断「在线状态」，仍会回复消息。',
            }),
            errors.length ? h('div', { className: 'dwp-errorBox' }, errors.join('；')) : null,
          ),
          h(
            Card,
            { title: '低活跃日', desc: '这一天降低回复频率与每日上限，避免天天聊得太密。' },
            h(
              'div',
              { className: 'dwp-grid2' },
              h(Field, {
                label: '低活跃星期',
                hint: '选择「不启用」则不设置低活跃日。',
                control: h(Select, {
                  options: WEEKDAY_OPTIONS.map(function (option) {
                    return { value: option.value, label: option.label }
                  }),
                  value: String(Number(schedule.lowActivityWeekday) || 0),
                  onChange: function (value) {
                    setSchedule('lowActivityWeekday', Number(value) || 0)
                  },
                }),
              }),
              h(Field, {
                label: '低活跃日每日上限',
                unit: '条',
                hint: '对应 rateLimit.lowActivityDailyLimit（在「回复策略」页调整）。',
                control: h(NumberInput, {
                  value: (draft.rateLimit && draft.rateLimit.lowActivityDailyLimit) || 0,
                  min: 0,
                  max: 200,
                  onChange: function (value) {
                    setDraft(setPath(draft, 'rateLimit.lowActivityDailyLimit', clampInt(value, 0, 200, 5)))
                  },
                }),
              }),
            ),
          ),
          h(
            Card,
            { title: '时段预览', desc: '按你当前填写的内容实时计算（未保存也会预览）。' },
            h(KeyValue, {
              items: [
                { key: 'today', label: '今天', value: describeOnlineWindow(schedule, now.getDay()) },
                { key: 'weekday', label: '工作日', value: describeOnlineWindow(schedule, 3) },
                { key: 'weekend', label: '周末', value: describeOnlineWindow(schedule, 6) },
                {
                  key: 'now',
                  label: '当前状态',
                  value: online ? h(Badge, { tone: 'success' }, '在线时段内') : h(Badge, { tone: 'warn' }, '不在线时段'),
                },
                {
                  key: 'next',
                  label: '下次上线',
                  value: online ? '现在就在线' : next ? formatDateTime(next) : '计算不出，请检查时间格式',
                },
              ],
            }),
          ),
        )
      }

      // =====================================================================
      // 回复策略
      // =====================================================================
      function ReplyTab(props) {
        const s = props.shared
        const [draft, setDraft] = useDraftState(function () { return cloneJson(s.config || {}) }, s.resetToken)
        const reply = draft.reply || {}
        const rate = draft.rateLimit || {}
        const memory = draft.memory || {}
        const search = draft.search || {}
        const dirty = configChanged(s.config, draft)
        const set = function (path, value) { setDraft(setPath(draft, path, value)) }
        const setInt = function (path, value, min, max, fallback) { set(path, clampInt(value, min, max, fallback)) }
        const setNum = function (path, value, min, max, fallback) { set(path, clampNumber(value, min, max, fallback)) }
        const ratioField = function (path, value, fallback) {
          return h(NumberInput, {
            value: ratioToPercentText(value),
            min: 0,
            max: 100,
            step: 5,
            onChange: function (next) { set(path, percentTextToRatio(next, fallback)) },
          })
        }
        const warnings = []
        if (Number(reply.typingMaxMs) < Number(reply.typingMinMs)) warnings.push('打字延迟上限小于下限，会自动按较小值处理')
        if (Number(reply.maxContextTurns) === 0) warnings.push('上下文轮数设为 0：将使用「记忆与上下文」里的 contextMessages')
        const contextTurns = Number(reply.maxContextTurns) > 0 ? Number(reply.maxContextTurns) : Number(memory.contextMessages) || 0

        return h(
          'div',
          null,
          h(
            Card,
            {
              title: '回复内容',
              desc: '控制单条回复的长度、模型参数与适用范围。默认值适合「话少、口语化」的人设。',
              extra: h(SaveBar, {
                dirty: dirty,
                saving: s.saving,
                readOnly: s.readOnly,
                readOnlyReason: s.readOnlyReason,
                onSave: function () { s.saveConfig(draft) },
                onDiscard: s.discard,
              }),
            },
            h(
              'div',
              { className: 'dwp-grid3' },
              h(Field, {
                label: '单条最多字数',
                hint: '超过就会被截断，建议 30–80。',
                control: h(NumberInput, {
                  value: reply.maxChars,
                  min: 1,
                  max: 500,
                  onChange: function (value) { setInt('reply.maxChars', value, 1, 500, 60) },
                }),
              }),
              h(Field, {
                label: 'temperature',
                hint: '越高越发散，1.1 左右比较自然。',
                control: h(NumberInput, {
                  value: reply.temperature,
                  min: 0,
                  max: 2,
                  step: 0.1,
                  onChange: function (value) { setNum('reply.temperature', value, 0, 2, 1.1) },
                }),
              }),
              h(Field, {
                label: '最大输出 tokens',
                hint: '与字数配合限制成本。',
                control: h(NumberInput, {
                  value: reply.maxTokens,
                  min: 16,
                  max: 4096,
                  step: 16,
                  onChange: function (value) { setInt('reply.maxTokens', value, 16, 4096, 160) },
                }),
              }),
              h(Field, {
                label: '推理强度',
                hint: 'low 最省 token；medium/high 更聪明但更慢更贵。',
                control: h(Select, {
                  options: REASONING_EFFORTS,
                  value: reply.reasoningEffort || 'low',
                  onChange: function (value) { set('reply.reasoningEffort', value) },
                }),
              }),
              h(Field, {
                label: '上下文轮数',
                hint: '0 = 使用记忆设置里的 contextMessages（当前 ' + (memory.contextMessages || 10) + '）。',
                control: h(NumberInput, {
                  value: reply.maxContextTurns,
                  min: 0,
                  max: 50,
                  onChange: function (value) { setInt('reply.maxContextTurns', value, 0, 50, 6) },
                }),
              }),
            ),
            h('div', { className: 'dwp-divider' }),
            h(
              'div',
              { className: 'dwp-grid3' },
              h(Switch, {
                checked: reply.privateChatEnabled !== false,
                onChange: function (value) { set('reply.privateChatEnabled', value) },
                label: '回复私聊',
              }),
              h(Switch, {
                checked: reply.groupChatEnabled === true,
                onChange: function (value) { set('reply.groupChatEnabled', value) },
                label: '回复群聊',
                hint: '不建议开启。',
              }),
              h(Switch, {
                checked: reply.ignorePureSticker !== false,
                onChange: function (value) { set('reply.ignorePureSticker', value) },
                label: '忽略纯表情消息',
                hint: '只发表情不配文字时不再回复。',
              }),
            ),
            h('div', { className: 'dwp-hint' }, '当前实际带入 ' + contextTurns + ' 轮上下文。'),
          ),
          h(
            Card,
            { title: '拟人节奏', desc: '打字延迟、拆条与表情概率，让回复更像真人而不是连珠炮。' },
            h(
              'div',
              { className: 'dwp-grid2' },
              h(Field, {
                label: '打字延迟下限',
                unit: '毫秒',
                control: h(NumberInput, {
                  value: reply.typingMinMs,
                  min: 0,
                  max: 60000,
                  step: 100,
                  onChange: function (value) { setInt('reply.typingMinMs', value, 0, 60000, 800) },
                }),
              }),
              h(Field, {
                label: '打字延迟上限',
                unit: '毫秒',
                control: h(NumberInput, {
                  value: reply.typingMaxMs,
                  min: 0,
                  max: 120000,
                  step: 100,
                  onChange: function (value) { setInt('reply.typingMaxMs', value, 0, 120000, 5000) },
                }),
              }),
              h(Field, {
                label: '拆条概率',
                unit: '%',
                hint: '一条回复拆成多条发送的概率。',
                control: ratioField('reply.splitProbability', reply.splitProbability, 0.35),
              }),
              h(Field, {
                label: '最多拆几条',
                control: h(NumberInput, {
                  value: reply.maxSplitParts,
                  min: 1,
                  max: 10,
                  onChange: function (value) { setInt('reply.maxSplitParts', value, 1, 10, 3) },
                }),
              }),
              h(Field, {
                label: '带表情概率',
                unit: '%',
                control: ratioField('reply.stickerProbability', reply.stickerProbability, 0.25),
              }),
              h(Field, {
                label: '表情不重复条数',
                hint: '最近 N 条已用过的表情不再用。',
                control: h(NumberInput, {
                  value: reply.stickerNoRepeatCount,
                  min: 0,
                  max: 100,
                  onChange: function (value) { setInt('reply.stickerNoRepeatCount', value, 0, 100, 8) },
                }),
              }),
            ),
            warnings.length ? h('div', { className: 'dwp-banner dwp-banner--warn' }, h('span', { className: 'dwp-bannerText' }, warnings.join('；'))) : null,
          ),
          h(
            Card,
            { title: '频率限制', desc: '按联系人统计，避免一句话被连续轰炸。' },
            h(
              'div',
              { className: 'dwp-grid3' },
              h(Field, {
                label: '每联系人每小时',
                unit: '条',
                control: h(NumberInput, {
                  value: rate.perContactPerHour,
                  min: 1,
                  max: 500,
                  onChange: function (value) { setInt('rateLimit.perContactPerHour', value, 1, 500, 10) },
                }),
              }),
              h(Field, {
                label: '每联系人每天',
                unit: '条',
                control: h(NumberInput, {
                  value: rate.perContactPerDay,
                  min: 1,
                  max: 2000,
                  onChange: function (value) { setInt('rateLimit.perContactPerDay', value, 1, 2000, 60) },
                }),
              }),
              h(Field, {
                label: '最小回复间隔',
                unit: '秒',
                control: h(NumberInput, {
                  value: rate.minReplyIntervalSec,
                  min: 0,
                  max: 3600,
                  onChange: function (value) { setInt('rateLimit.minReplyIntervalSec', value, 0, 3600, 30) },
                }),
              }),
            ),
          ),
          h(
            Card,
            { title: '记忆与上下文', desc: '本地记忆：最近消息保留、上下文轮数与自动摘要，控制 token 成本。' },
            h(
              'div',
              { className: 'dwp-grid3' },
              h(Field, {
                label: '带入上下文条数',
                unit: '条',
                control: h(NumberInput, {
                  value: memory.contextMessages,
                  min: 0,
                  max: 100,
                  onChange: function (value) { setInt('memory.contextMessages', value, 0, 100, 10) },
                }),
              }),
              h(Field, {
                label: '最近消息保留',
                unit: '条',
                control: h(NumberInput, {
                  value: memory.recentKeep,
                  min: 0,
                  max: 500,
                  onChange: function (value) { setInt('memory.recentKeep', value, 0, 500, 30) },
                }),
              }),
              h(Field, {
                label: '每隔几轮摘要',
                control: h(NumberInput, {
                  value: memory.summaryEveryTurns,
                  min: 0,
                  max: 500,
                  onChange: function (value) { setInt('memory.summaryEveryTurns', value, 0, 500, 50) },
                }),
              }),
              h(Field, {
                label: '摘要最大字数',
                control: h(NumberInput, {
                  value: memory.maxSummaryChars,
                  min: 50,
                  max: 4000,
                  step: 50,
                  onChange: function (value) { setInt('memory.maxSummaryChars', value, 50, 4000, 400) },
                }),
              }),
              h(Switch, {
                checked: memory.autoSummary !== false,
                onChange: function (value) { set('memory.autoSummary', value) },
                label: '自动生成摘要',
              }),
            ),
            h('div', { className: 'dwp-divider' }),
            h(
              'div',
              { className: 'dwp-actions' },
              h(ConfirmButton, {
                label: '清空全部联系人记忆',
                confirmLabel: '确认清空记忆？',
                variant: 'danger',
                onConfirm: function () {
                  Promise.resolve()
                    .then(function () { return api.clearMemory() })
                    .then(function () { s.showBanner({ text: '已请求清空联系人记忆', tone: 'success' }) })
                    .catch(s.fail)
                },
              }),
            ),
          ),
          h(
            Card,
            { title: '按需搜索', desc: '遇到不懂的梗或事实时，先本地判断是否值得搜；关闭后完全离线。' },
            h(
              'div',
              { className: 'dwp-grid3' },
              h(Switch, {
                checked: search.enabled !== false,
                onChange: function (value) { set('search.enabled', value) },
                label: '启用搜索',
              }),
              h(Field, {
                label: '每天最多搜索',
                unit: '次',
                control: h(NumberInput, {
                  value: search.maxPerDay,
                  min: 0,
                  max: 500,
                  onChange: function (value) { setInt('search.maxPerDay', value, 0, 500, 20) },
                }),
              }),
              h(Field, {
                label: '每次结果条数',
                control: h(NumberInput, {
                  value: search.maxResults,
                  min: 1,
                  max: 10,
                  onChange: function (value) { setInt('search.maxResults', value, 1, 10, 3) },
                }),
              }),
            ),
            h(Field, {
              label: '追加搜索关键词',
              hint: '每行一个，会附加到搜索请求里，例如「梗」「出处」。',
              control: h(TextArea, {
                value: joinKeywords(search.extraKeywords),
                rows: 3,
                onChange: function (value) { set('search.extraKeywords', splitKeywords(value)) },
              }),
            }),
            h(SaveBar, {
              dirty: dirty,
              saving: s.saving,
              readOnly: s.readOnly,
              readOnlyReason: s.readOnlyReason,
              onSave: function () { s.saveConfig(draft) },
              onDiscard: s.discard,
              saveLabel: '保存全部回复设置',
            }),
          ),
        )
      }

      // =====================================================================
      // 表情包
      // =====================================================================
      function StickersTab(props) {
        const s = props.shared
        const [draft, setDraft] = useDraftState(function () { return cloneJson(s.config || {}) }, s.resetToken)
        const [stickers, reloadStickers] = useLoad(function () { return api.getStickers() }, [])
        const [busy, run] = useAsyncAction()
        const [emotion, setEmotion] = React.useState('happy')
        const [uploadError, setUploadError] = React.useState('')
        const fileRef = React.useRef(null)
        const dirty = configChanged(s.config, draft)
        const items = stickers.data && Array.isArray(stickers.data.items) ? stickers.data.items : []

        const upload = function (file) {
          setUploadError('')
          const check = validateStickerFile(file)
          if (!check.ok) {
            setUploadError(check.error)
            return
          }
          run(async function () {
            try {
              const dataUrl = await readFileAsDataUrl(file)
              const parsed = dataUrlToBase64(dataUrl)
              if (!parsed.ok) throw new Error(parsed.error)
              if (parsed.byteLength > MAX_STICKER_BYTES) throw new Error('图片不能超过 2 MB')
              await api.uploadSticker({ emotion: emotion, filename: file.name, dataBase64: parsed.base64 })
              s.showBanner({ text: '已上传表情：' + file.name, tone: 'success' })
              reloadStickers()
            } catch (error) {
              s.fail(error)
            }
          })
        }

        return h(
          'div',
          null,
          h(
            Card,
            {
              title: '表情包开关',
              desc: '回复时按概率带一个表情，增加真实感。',
              extra: h(SaveBar, {
                dirty: dirty,
                saving: s.saving,
                readOnly: s.readOnly,
                readOnlyReason: s.readOnlyReason,
                onSave: function () { s.saveConfig(draft) },
                onDiscard: s.discard,
              }),
            },
            h(
              'div',
              { className: 'dwp-grid3' },
              h(Switch, {
                checked: draft.stickers ? draft.stickers.enabled !== false : true,
                onChange: function (value) { setDraft(setPath(draft, 'stickers.enabled', value)) },
                label: '启用表情包',
              }),
              h(Field, {
                label: '每条最多表情',
                unit: '个',
                control: h(NumberInput, {
                  value: (draft.stickers && draft.stickers.maxPerReply) || 1,
                  min: 0,
                  max: 5,
                  onChange: function (value) {
                    setDraft(setPath(draft, 'stickers.maxPerReply', clampInt(value, 0, 5, 1)))
                  },
                }),
              }),
              h(Field, {
                label: '自定义表情目录',
                hint: '留空则使用默认目录；填相对工作区的路径。',
                control: h(TextInput, {
                  value: (draft.stickers && draft.stickers.dir) || '',
                  placeholder: '留空即默认',
                  onChange: function (value) { setDraft(setPath(draft, 'stickers.dir', value)) },
                }),
              }),
            ),
            h('div', { className: 'dwp-hint' }, '表情不重复条数与带表情概率在「回复策略」页调整。'),
          ),
          h(
            Card,
            {
              title: '表情列表',
              desc: '共 ' + items.length + ' 个。来自人格包、内置或本地上传。',
              extra: h(
                'div',
                { className: 'dwp-actions' },
                h(Button, { size: 'sm', onClick: reloadStickers }, '刷新'),
              ),
            },
            stickers.status === 'loading' ? h(Loading, { text: '读取表情列表…' }) : null,
            stickers.error ? h('div', { className: 'dwp-errorBox' }, '读取失败：' + errorMessage(stickers.error)) : null,
            items.length
              ? h(
                  'div',
                  { className: 'dwp-stickerGrid' },
                  items.map(function (item) {
                    return h(
                      'div',
                      { key: item.id, className: 'dwp-sticker' },
                      h(StickerImage, {
                        src: item.url || api.stickerFileUrl(item.id),
                        alt: item.name || item.id,
                        title: item.name || item.id,
                      }),
                      h(
                        'div',
                        { className: 'dwp-stickerMeta' },
                        h('span', { className: 'dwp-stickerName', title: item.name }, item.name || item.id),
                        h(
                          'span',
                          null,
                          h(Badge, { tone: 'neutral' }, EMOTION_LABELS[item.category] || EMOTION_LABELS[item.emotion] || item.category || '其它'),
                          h(Badge, { tone: 'neutral' }, STICKER_ORIGIN_LABELS[item.origin] || item.origin || '本地'),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'dwp-stickerActions' },
                        h(ConfirmButton, {
                          size: 'sm',
                          variant: 'danger',
                          label: '删除',
                          confirmLabel: '确认删除？',
                          disabled: item.origin === 'package' || item.origin === 'persona',
                          title: item.origin === 'package' || item.origin === 'persona' ? '内置 / 人格包自带的表情不能单独删除' : undefined,
                          onConfirm: function () {
                            run(async function () {
                              try {
                                await api.deleteSticker(item.id)
                                s.showBanner({ text: '已删除表情：' + (item.name || item.id), tone: 'success' })
                                reloadStickers()
                              } catch (error) {
                                s.fail(error)
                              }
                            })
                          },
                        }),
                      ),
                    )
                  }),
                )
              : stickers.status === 'ready'
                ? h(EmptyState, null, '还没有表情包，上传几张试试。')
                : null,
          ),
          h(
            Card,
            { title: '上传表情', desc: '支持 PNG / GIF / WebP，单张不超过 2 MB。' },
            h(
              'div',
              { className: 'dwp-grid2' },
              h(Field, {
                label: '情绪分类',
                hint: '回复时会按情绪挑表情。',
                control: h(Select, {
                  options: EMOTIONS.map(function (item) {
                    return { value: item.id, label: item.label }
                  }),
                  value: emotion,
                  onChange: setEmotion,
                }),
              }),
              h(
                'div',
                { className: 'dwp-field' },
                h('span', { className: 'dwp-label' }, '选择图片'),
                h(
                  Button,
                  {
                    onClick: function () {
                      if (fileRef.current) fileRef.current.click()
                    },
                    busy: busy,
                  },
                  '选择图片文件',
                ),
                h('input', {
                  ref: fileRef,
                  type: 'file',
                  accept: 'image/png,image/gif,image/webp',
                  style: { display: 'none' },
                  onChange: function (event) {
                    const file = event.target.files && event.target.files[0]
                    upload(file)
                    event.target.value = ''
                  },
                }),
                uploadError ? h('span', { className: 'dwp-errorText' }, uploadError) : null,
              ),
            ),
          ),
        )
      }

      // =====================================================================
      // 预算与安全
      // =====================================================================
      function BudgetTab(props) {
        const s = props.shared
        const [draft, setDraft] = useDraftState(function () { return cloneJson(s.config || {}) }, s.resetToken)
        const budget = draft.budget || {}
        const safety = draft.safety || {}
        const logging = draft.logging || {}
        const dirty = configChanged(s.config, draft)
        const set = function (path, value) { setDraft(setPath(draft, path, value)) }
        const setInt = function (path, value, min, max, fallback) { set(path, clampInt(value, min, max, fallback)) }
        const status = s.status || null
        const spent = status && status.budget ? Number(status.budget.spentTokens) || 0 : 0
        const daily = Number(budget.dailyTokens) || 0
        const [busy, run] = useAsyncAction()

        return h(
          'div',
          null,
          h(
            Card,
            {
              title: '每日预算',
              desc: '按天统计 LLM token。超过草稿阈值后只生成草稿不真发；超过上限后完全停止调用。',
              extra: h(SaveBar, {
                dirty: dirty,
                saving: s.saving,
                readOnly: s.readOnly,
                readOnlyReason: s.readOnlyReason,
                onSave: function () { s.saveConfig(draft) },
                onDiscard: s.discard,
              }),
            },
            h(
              'div',
              { className: 'dwp-grid3' },
              h(Field, {
                label: '每日 token 上限',
                hint: '0 表示不限制（不建议）。',
                control: h(NumberInput, {
                  value: budget.dailyTokens,
                  min: 0,
                  max: 10000000,
                  step: 1000,
                  onChange: function (value) { setInt('budget.dailyTokens', value, 0, 10000000, 50000) },
                }),
              }),
              h(Field, {
                label: '草稿模式阈值',
                unit: '%',
                hint: '用到上限的这个比例后，只生成草稿让你确认，不自动发送。',
                control: h(NumberInput, {
                  value: ratioToPercentText(budget.draftModeRatio),
                  min: 0,
                  max: 100,
                  step: 5,
                  onChange: function (value) { set('budget.draftModeRatio', percentTextToRatio(value, 0.85)) },
                }),
              }),
              h(Field, {
                label: '每天最多摘要次数',
                hint: '自动摘要也消耗 token，这里单独限额。',
                control: h(NumberInput, {
                  value: budget.maxSummaryCallsPerDay,
                  min: 0,
                  max: 100,
                  onChange: function (value) { setInt('budget.maxSummaryCallsPerDay', value, 0, 100, 4) },
                }),
              }),
            ),
            h('div', { className: 'dwp-divider' }),
            h(
              'div',
              { className: 'dwp-row' },
              h('span', { className: 'dwp-label' }, '今天已用 ' + formatTokens(spent) + ' / ' + formatTokens(daily) + ' tokens'),
              h('span', { className: 'dwp-spacer' }),
              h(Badge, { tone: status && status.budgetPhase === 'ok' ? 'success' : status && status.budgetPhase === 'draft' ? 'warn' : 'error' }, budgetPhaseLabel(status && status.budgetPhase)),
            ),
            h(ProgressBar, { value: spent, max: daily }),
            status && status.breaker && status.breaker.tripped
              ? h(
                  'div',
                  { className: 'dwp-errorBox' },
                  h('div', null, '风控熔断已触发：' + (status.breaker.reason || '未知原因')),
                  h(Button, { size: 'sm', variant: 'primary', busy: busy, onClick: function () {
                    run(async function () {
                      try {
                        await api.resume()
                        s.showBanner({ text: '已恢复运行', tone: 'success' })
                        await s.refreshAll()
                      } catch (error) {
                        s.fail(error)
                      }
                    })
                  } }, '人工确认并恢复'),
                )
              : null,
          ),
          h(
            Card,
            {
              title: '安全红线',
              desc: '命中违禁词会暂停回复并记录风控事件；建议保留默认开关。',
            },
            // 发布前验收（任务书第五部分）：只读测试模式展示。开启后本页不提供关闭按钮（防止误操作绕过），
            // 关闭需经配置文件/二次确认；未开启时允许在这里开启，便于验收前准备。
            draft.readOnlyTestMode === true
              ? h(
                  'div',
                  { className: 'dwp-row' },
                  h(Badge, { tone: 'warn' }, '只读测试模式已开启'),
                  h(
                    'span',
                    { className: 'dwp-hint' },
                    '代码层已禁止一切真实通道发送：自动回复、手动测试、草稿批准都会被拒绝；mock 通道仍可空转。该模式是持久化配置，重启后仍生效，不能在本页关闭（需修改配置文件并重启插件）。',
                  ),
                )
              : h(
                  'div',
                  { className: 'dwp-row' },
                  h(
                    Button,
                    { size: 'sm', onClick: function () { set('readOnlyTestMode', true) } },
                    '开启只读测试模式',
                  ),
                  h(
                    'span',
                    { className: 'dwp-hint' },
                    '发布前验收用：开启并保存后，引擎/通道/API/PS1 四层都会拒绝一切真实发送（自动回复、测试发送、草稿批准、键盘回车/粘贴提交），仍可读取与诊断；开启后本页不提供关闭按钮。',
                  ),
                ),
            h('div', { className: 'dwp-divider' }),
            // task-12 / 13.4：发送模式（auto / draft / confirm）。draft/confirm 只生成草稿，
            // 必须在「日志与测试 → 待发送草稿」里人工批准后才会真正发送。
            h(Field, {
              label: '发送模式（13.4 人工确认）',
              hint: 'auto=自动发送（默认）；draft=只生成草稿，人工批准后才发送；confirm=人工确认后发送。safeMode 优先级更高（安全模式下只生成草稿）。修改后点下方「保存预算与安全设置」生效。',
              control: h(Select, {
                options: [
                  { value: 'auto', label: '自动发送（默认）' },
                  { value: 'draft', label: '只生成草稿，人工批准' },
                  { value: 'confirm', label: '人工确认后发送' },
                ],
                value: draft.sendMode || 'auto',
                onChange: function (value) { set('sendMode', value) },
              }),
            }),
            h('div', { className: 'dwp-divider' }),
            h(
              'div',
              { className: 'dwp-row' },
              h(Switch, {
                checked: draft.safeMode === true,
                onChange: function (value) { set('safeMode', value) },
                label: '安全运行模式（禁止真实发送）',
              }),
              h(Badge, { tone: draft.safeMode === true ? 'success' : 'neutral' }, draft.safeMode === true ? '已开启' : '未开启'),
            ),
            h(
              'div',
              { className: 'dwp-hint' },
              '开启后：只要当前通道不是 mock，引擎就拒绝一切真实发送（自动回复与手动测试都返回「已拒绝发送：…安全模式…」），只允许 mock 空转。默认关闭以保持升级兼容，首次配置向导会建议开启；修改后点下方「保存预算与安全设置」生效。',
            ),
            h('div', { className: 'dwp-divider' }),
            h(
              'div',
              { className: 'dwp-grid2' },
              h(Field, {
                label: '违禁词',
                hint: '每行一个；命中后暂停该会话并记录。',
                control: h(TextArea, {
                  value: joinKeywords(safety.forbiddenKeywords),
                  code: true,
                  rows: 8,
                  onChange: function (value) { set('safety.forbiddenKeywords', splitKeywords(value)) },
                }),
              }),
              h(Field, {
                label: '额外风险词',
                hint: '每行一个；命中只提示风险，可继续回复。',
                control: h(TextArea, {
                  value: joinKeywords(safety.riskKeywords),
                  code: true,
                  rows: 8,
                  onChange: function (value) { set('safety.riskKeywords', splitKeywords(value)) },
                }),
              }),
            ),
            h(
              'div',
              { className: 'dwp-grid2' },
              h(Switch, {
                checked: safety.pauseOnForbiddenInbound !== false,
                onChange: function (value) { set('safety.pauseOnForbiddenInbound', value) },
                label: '收到违禁词时暂停',
              }),
              h(Switch, {
                checked: safety.blockTransfers !== false,
                onChange: function (value) { set('safety.blockTransfers', value) },
                label: '拒绝转账 / 红包类请求',
              }),
              h(Switch, {
                checked: safety.blockSuspiciousLinks !== false,
                onChange: function (value) { set('safety.blockSuspiciousLinks', value) },
                label: '拦截可疑链接',
              }),
              h(Switch, {
                checked: safety.circuitBreakerEnabled !== false,
                onChange: function (value) { set('safety.circuitBreakerEnabled', value) },
                label: '启用自动熔断',
              }),
            ),
          ),
          h(
            Card,
            { title: '日志与审计', desc: '审计日志用于排查「为什么没回 / 为什么回了这句」。' },
            h(
              'div',
              { className: 'dwp-grid3' },
              h(Switch, {
                checked: logging.auditEnabled !== false,
                onChange: function (value) { set('logging.auditEnabled', value) },
                label: '记录审计日志',
              }),
              h(Field, {
                label: '日志上限',
                unit: 'MB',
                control: h(NumberInput, {
                  value: logging.maxAuditMb,
                  min: 1,
                  max: 500,
                  onChange: function (value) { setInt('logging.maxAuditMb', value, 1, 500, 10) },
                }),
              }),
              h(Field, {
                label: '日志级别',
                control: h(Select, {
                  options: [
                    { value: 'debug', label: 'debug（最详细）' },
                    { value: 'info', label: 'info（默认）' },
                    { value: 'warn', label: 'warn' },
                    { value: 'error', label: 'error（只记错误）' },
                  ],
                  value: logging.level || 'info',
                  onChange: function (value) { set('logging.level', value) },
                }),
              }),
              h(Field, {
                label: '界面上显示最近几条',
                control: h(NumberInput, {
                  value: logging.recentLimit,
                  min: 10,
                  max: 500,
                  step: 10,
                  onChange: function (value) { setInt('logging.recentLimit', value, 10, 500, 50) },
                }),
              }),
            ),
            h(SaveBar, {
              dirty: dirty,
              saving: s.saving,
              readOnly: s.readOnly,
              readOnlyReason: s.readOnlyReason,
              onSave: function () { s.saveConfig(draft) },
              onDiscard: s.discard,
              saveLabel: '保存预算与安全设置',
            }),
          ),
        )
      }

      // =====================================================================
      // 日志与测试
      // =====================================================================
      // task-12 / 13.4：草稿状态与内容预览（纯展示，不做任何发送动作）。
      function draftStatusLabel(status) {
        if (status === 'pending') return '待处理'
        if (status === 'approved') return '已批准'
        if (status === 'rejected') return '已拒绝'
        if (status === 'expired') return '已过期'
        return status || '—'
      }

      function previewText(text, max) {
        const value = String(text == null ? '' : text)
        return value.length > max ? value.slice(0, max) + '…' : value
      }

      function LogsTab(props) {
        const s = props.shared
        const [limit, setLimit] = React.useState(50)
        const [auto, setAuto] = React.useState(false)
        const [logs, reloadLogs] = useLoad(function () { return api.getLogs(limit) }, [limit])
        const [busy, run] = useAsyncAction()
        const [inboundText, setInboundText] = React.useState('在吗？')
        const [inboundContact, setInboundContact] = React.useState('')
        const [sendContact, setSendContact] = React.useState('')
        const [sendText, setSendText] = React.useState('')
        React.useEffect(
          function () {
            if (!auto) return undefined
            const timer = setInterval(reloadLogs, 5000)
            return function () { clearInterval(timer) }
          },
          [auto, reloadLogs],
        )
        const events = decorateEvents(logs.data && logs.data.events, limit)
        const summary = logs.data && logs.data.summary ? logs.data.summary : null
        const status = s.status || null
        // 发布前验收（任务书第五部分）：只读测试模式（配置真源，重启后仍生效）。
        const readOnlyTestMode = s.config && s.config.readOnlyTestMode === true

        // Phase F：OCR / 读屏诊断（只读，不触发截图；通道未提供时显示原因）。
        const [ocr, setOcr] = React.useState(null)
        const [ocrBusy, setOcrBusy] = React.useState(false)
        const [ocrError, setOcrError] = React.useState('')
        const refreshOcr = React.useCallback(function () {
          setOcrBusy(true)
          setOcrError('')
          api.getOcrDiagnostics()
            .then(function (response) {
              setOcr(response && response.diagnostics ? response.diagnostics : null)
            })
            .catch(function (error) {
              setOcrError(errorMessage(error))
            })
            .finally(function () {
              setOcrBusy(false)
            })
        }, [])
        React.useEffect(function () { refreshOcr() }, [refreshOcr])

        // task-12 / 13.4：待发送草稿（draft / confirm 模式）。批准会重新走服务端全部门禁，
        // 结果 unknown 的草稿不会被自动重发。
        const [drafts, setDrafts] = React.useState(null)
        const [draftBusy, setDraftBusy] = React.useState(false)
        const [draftError, setDraftError] = React.useState('')
        const refreshDrafts = React.useCallback(function () {
          setDraftBusy(true)
          setDraftError('')
          api.getDrafts()
            .then(function (response) {
              const list = response && Array.isArray(response.drafts) ? response.drafts : []
              setDrafts(list)
            })
            .catch(function (error) {
              setDraftError(errorMessage(error))
            })
            .finally(function () {
              setDraftBusy(false)
            })
        }, [])
        React.useEffect(function () { refreshDrafts() }, [refreshDrafts])
        const decideDraft = function (action, id) {
          run(async function () {
            try {
              const response = action === 'approve' ? await api.approveDraft(id) : await api.rejectDraft(id)
              const result = response && response.result ? response.result : {}
              const sent = result.delivery === 'sent'
              s.showBanner({
                text: action === 'approve'
                  ? sent ? '草稿已批准并发送' : '草稿已批准，发送结果见审计日志'
                  : '草稿已拒绝，不会发送',
                tone: 'success',
              })
              refreshDrafts()
              reloadLogs()
              s.refreshStatus()
            } catch (error) {
              s.showBanner({
                text: (action === 'approve' ? '批准草稿失败：' : '拒绝草稿失败：') + errorMessage(error),
                tone: 'error',
              })
            }
          })
        }

        return h(
          'div',
          null,
          h(
            Card,
            { title: '测试工具', desc: '不连微信通道，直接验证人格与回复链路。' },
            h(
              'div',
              { className: 'dwp-grid2' },
              h(
                'div',
                null,
                h(SectionTitle, null, '模拟收到一条消息'),
                h(Field, {
                  label: '联系人（可留空）',
                  control: h(TextInput, {
                    value: inboundContact,
                    placeholder: '白名单里的备注名',
                    onChange: setInboundContact,
                  }),
                }),
                h(Field, {
                  label: '消息内容',
                  control: h(TextArea, { value: inboundText, rows: 3, onChange: setInboundText }),
                }),
                h(
                  Button,
                  {
                    variant: 'primary',
                    busy: busy,
                    onClick: function () {
                      run(async function () {
                        try {
                          const payload = { text: inboundText }
                          if (trimText(inboundContact)) payload.contactId = trimText(inboundContact)
                          const response = await api.testInbound(payload)
                          s.showBanner({ text: '已注入模拟消息，结果会出现在下方日志里', tone: response && response.error ? 'warn' : 'success' })
                          reloadLogs()
                          await s.refreshAll()
                        } catch (error) {
                          s.fail(error)
                        }
                      })
                    },
                  },
                  '注入模拟消息',
                ),
              ),
              h(
                'div',
                null,
                h(SectionTitle, null, '直接发送一条消息'),
                h(Field, {
                  label: '联系人（必填）',
                  control: h(TextInput, {
                    value: sendContact,
                    placeholder: '白名单里的备注名',
                    onChange: setSendContact,
                  }),
                }),
                h(Field, {
                  label: '要发送的内容',
                  control: h(TextArea, { value: sendText, rows: 3, onChange: setSendText }),
                }),
                h(
                  Button,
                  {
                    variant: 'primary',
                    busy: busy,
                    disabled: !trimText(sendContact) || !trimText(sendText),
                    onClick: function () {
                      run(async function () {
                        try {
                          const response = await api.testSend({ contactId: trimText(sendContact), text: sendText })
                          const result = response && response.result ? response.result : response
                          if (result && result.ok) {
                            s.showBanner({ text: '已请求发送，结果见日志', tone: 'success' })
                          } else {
                            s.showBanner({ text: '发送失败：' + errorMessage((result && result.error) || '未知原因'), tone: 'error' })
                          }
                          reloadLogs()
                        } catch (error) {
                          s.fail(error)
                        }
                      })
                    },
                  },
                  '发送测试消息',
                ),
              ),
            ),
            h(
              'div',
              null,
              h(SectionTitle, null, '人格模拟器（仅 mock 通道）'),
              h(
                'div',
                { className: 'dwp-hint' },
                '用「直接发送一条消息」里的联系人与内容，以 mockOnly 发到 mock 通道：服务端在非 mock 通道会直接 409 拒绝，保证绝不触达真实微信。',
              ),
              h(
                Button,
                {
                  variant: 'ghost',
                  busy: busy,
                  disabled: !trimText(sendContact) || !trimText(sendText) || !(status && status.channelId === 'mock'),
                  onClick: function () {
                    run(async function () {
                      try {
                        const response = await api.testMockSend({ contactId: trimText(sendContact), text: sendText })
                        const result = response && response.result ? response.result : response
                        if (result && result.ok) {
                          s.showBanner({ text: '模拟器已发送到 mock 通道，结果见下方日志', tone: 'success' })
                        } else {
                          s.showBanner({ text: '模拟器发送失败：' + errorMessage((result && result.error) || '未知原因'), tone: 'error' })
                        }
                        reloadLogs()
                      } catch (error) {
                        s.fail(error)
                      }
                    })
                  },
                },
                status && status.channelId === 'mock' ? '发送到 mock 通道' : '当前通道不是 mock，模拟器已禁用',
              ),
            ),
            h('div', { className: 'dwp-divider' }),
            h(
              'div',
              { className: 'dwp-actions' },
              h(
                Button,
                {
                  variant: status && status.paused ? 'primary' : 'ghost',
                  busy: busy,
                  onClick: function () {
                    run(async function () {
                      try {
                        if (status && status.paused) {
                          await api.resume()
                          s.showBanner({ text: '已恢复运行', tone: 'success' })
                        } else {
                          await api.pause('在日志页手动暂停')
                          s.showBanner({ text: '已暂停', tone: 'warn' })
                        }
                        await s.refreshAll()
                      } catch (error) {
                        s.fail(error)
                      }
                    })
                  },
                },
                status && status.paused ? '继续运行' : '暂停回复',
              ),
              h(ConfirmButton, {
                label: '清空审计日志',
                confirmLabel: '确认清空？',
                variant: 'danger',
                onConfirm: function () {
                  run(async function () {
                    try {
                      await api.clearAudit()
                      s.showBanner({ text: '审计日志已清空', tone: 'success' })
                      reloadLogs()
                    } catch (error) {
                      s.fail(error)
                    }
                  })
                },
              }),
            ),
          ),
          h(
            Card,
            {
              title: '待发送草稿',
              desc: 'draft / confirm 模式下引擎只生成草稿，点「批准」才会发送（批准会重新通过暂停/熔断/预算/白名单/频控/安全模式全部门禁）。unknown 的发送结果不会自动重发。',
              extra: h(
                'div',
                { className: 'dwp-actions' },
                drafts && drafts.length ? h(Badge, { tone: 'warn' }, '待处理 ' + drafts.filter(function (item) { return item.status === 'pending' }).length + ' 条') : null,
                h(Button, { size: 'sm', busy: draftBusy, onClick: refreshDrafts }, '刷新'),
              ),
            },
            readOnlyTestMode
              ? h(
                  'div',
                  { className: 'dwp-row' },
                  h(Badge, { tone: 'warn' }, '只读测试模式已开启'),
                  h('span', { className: 'dwp-hint' }, '「批准」会触发真实发送，已被代码层禁用（API 返回 409，detail=read-only-mode）；「拒绝」仍可用。'),
                )
              : null,
            draftError ? h('div', { className: 'dwp-errorBox' }, '读取草稿失败：' + draftError) : null,
            !drafts && !draftError ? h('div', { className: 'dwp-hint' }, '正在读取草稿…') : null,
            drafts && drafts.length === 0 ? h(EmptyState, null, '暂无待发送草稿（当前是自动发送模式，或还没有生成过草稿）。') : null,
            drafts && drafts.length
              ? h(
                  'div',
                  { className: 'dwp-list' },
                  h(
                    'div',
                    { className: 'dwp-listRowHead' },
                    h('span', null, '创建时间'),
                    h('span', null, '联系人'),
                    h('span', null, '内容'),
                    h('span', null, '状态'),
                    h('span', null, '操作'),
                  ),
                  drafts.map(function (draft) {
                    const statusLabel = draftStatusLabel(draft.status)
                    const tone = draft.status === 'pending' ? 'warn' : draft.status === 'approved' ? 'success' : 'neutral'
                    return h(
                      'div',
                      { key: draft.id, className: 'dwp-listRow' },
                      h('span', null, formatDateTime(draft.createdAt)),
                      h('span', null, draft.contactName || draft.contactId || '—'),
                      h('span', { className: 'dwp-nowrap', title: draft.text || '' }, previewText(draft.text || '', 60)),
                      h('span', { title: draft.reason || '' }, h(Badge, { tone: tone }, statusLabel)),
                      h(
                        'div',
                        { className: 'dwp-actions' },
                        draft.status === 'pending'
                          ? h(Button, { size: 'sm', variant: 'primary', busy: busy, disabled: readOnlyTestMode, title: readOnlyTestMode ? '只读测试模式下禁止批准发送' : '', onClick: function () { decideDraft('approve', draft.id) } }, '批准')
                          : null,
                        draft.status === 'pending'
                          ? h(Button, { size: 'sm', busy: busy, onClick: function () { decideDraft('reject', draft.id) } }, '拒绝')
                          : null,
                      ),
                    )
                  }),
                )
              : null,
          ),
          h(
            Card,
            {
              title: 'OCR 诊断（只读）',
              desc: '最近一次读屏结果的结构化摘要（只读，不触发截图；不含截图与聊天原文）。',
              extra: h(Button, { size: 'sm', busy: ocrBusy, onClick: refreshOcr }, '刷新'),
            },
            ocrError ? h('div', { className: 'dwp-errorBox' }, '读取 OCR 诊断失败：' + ocrError) : null,
            !ocr && !ocrError ? h('div', { className: 'dwp-hint' }, '正在读取 OCR 诊断…') : null,
            ocr && !ocr.available
              ? h(
                  'div',
                  { className: 'dwp-row' },
                  h(Badge, { tone: 'warn' }, '不可用'),
                  h('span', { className: 'dwp-hint' }, ocr.reason || '通道未提供 OCR 诊断数据'),
                )
              : null,
            ocr && ocr.available
              ? h(
                  'div',
                  { className: 'dwp-grid2' },
                  h(KeyValue, null, '通道', (ocr.channelId || '—') + (ocr.channelState ? ' · ' + ocr.channelState : '')),
                  h(KeyValue, null, '双引擎', ocr.dualEngine ? '是' : '否'),
                  h(KeyValue, null, '采集批次', ocr.captureId || '—'),
                  h(KeyValue, null, '引擎', ocr.engines && ocr.engines.length ? ocr.engines.join(' / ') : '—'),
                  h(KeyValue, null, '识别行数', ocr.lines === undefined ? '—' : String(ocr.lines)),
                  h(KeyValue, null, 'uncertain 行数', ocr.uncertainCount === undefined ? '—' : String(ocr.uncertainCount)),
                  h(KeyValue, null, '耗时', ocr.durationMs === undefined ? '—' : formatDuration(ocr.durationMs)),
                  h(KeyValue, null, '最后读取', ocr.lastReadAt === undefined ? '—' : formatDateTime(ocr.lastReadAt)),
                  // task-12：pipeline-fixer 在通道 status().ocr 新增的只读字段（缺失时显示 —）
                  h(KeyValue, null, 'DPI', ocr.dpi === undefined ? '—' : String(ocr.dpi)),
                  h(KeyValue, null, '缩放', ocr.scale === undefined ? '—' : String(ocr.scale)),
                  h(KeyValue, null, '截图模式', ocr.screenshotMode || '—'),
                  h(KeyValue, null, '引擎版本', ocr.engineVersion || '—'),
                  h(KeyValue, null, '质量', ocr.qualityStatus || '—'),
                  // 发布前验收（任务书 4.3）：受控流水线 flag（legacy=回退 v0.2.8 行为；v3=归属/融合/置信度门禁）。
                  h(KeyValue, null, 'OCR 流水线', ocr.pipelineMode || '—'),
                  h(KeyValue, null, '二次 OCR', ocr.secondOcrUsed ? '是' : '否'),
                  h(KeyValue, null, 'reject 行数', ocr.rejectCount === undefined ? '—' : String(ocr.rejectCount)),
                  h(KeyValue, null, '冲突数', ocr.conflictCount === undefined ? '—' : String(ocr.conflictCount)),
                  ocr.lastError ? h(KeyValue, null, '最后错误', ocr.lastError) : null,
                )
              : null,
          ),
          h(
            Card,
            {
              title: '审计日志',
              desc: summary ? '今天是 ' + summary.dayKey + '，共 ' + (summary.llmCalls || 0) + ' 次模型调用。' : '最近事件。',
              extra: h(
                'div',
                { className: 'dwp-actions' },
                h(Select, {
                  options: [
                    { value: 50, label: '最近 50 条' },
                    { value: 100, label: '最近 100 条' },
                    { value: 200, label: '最近 200 条' },
                  ],
                  value: String(limit),
                  onChange: function (value) { setLimit(Number(value) || 50) },
                }),
                h(Switch, { checked: auto, onChange: setAuto, label: '自动刷新（5 秒）' }),
                h(Button, { size: 'sm', onClick: reloadLogs }, '刷新'),
              ),
            },
            summary ? h(Stats, { items: auditSummaryCards(summary) }) : null,
            logs.status === 'loading' ? h(Loading, { text: '读取日志…' }) : null,
            logs.error ? h('div', { className: 'dwp-errorBox' }, '读取日志失败：' + errorMessage(logs.error)) : null,
            events.length
              ? h(
                  'div',
                  { className: 'dwp-tableWrap' },
                  h(
                    'div',
                    { className: 'dwp-listRow dwp-listRowHead' },
                    h('span', null, '时间'),
                    h('span', null, '类型'),
                    h('span', null, '详情'),
                    h('span', null, '联系人'),
                  ),
                  events.map(function (event, index) {
                    const detail = formatEventSummary(event)
                    return h(
                      'div',
                      {
                        key: 'event-' + index,
                        className: 'dwp-listRow',
                        title: JSON.stringify(event, null, 2).slice(0, 2000),
                      },
                      h('span', null, formatDateTime(event.ts)),
                      h('span', null, h(Badge, { tone: eventTone(event.type) }, eventTypeLabel(event.type))),
                      h('span', { className: 'dwp-nowrap' }, detail || '—'),
                      h('span', null, event.contactName || event.contactId || '—'),
                    )
                  }),
                )
              : logs.status === 'ready'
                ? h(EmptyState, null, '还没有日志事件。')
                : null,
          ),
        )
      }

      // =====================================================================
      // 人格广场
      // =====================================================================
      function MarketTab(props) {
        const s = props.shared
        const [draft, setDraft] = useDraftState(function () { return cloneJson(s.config || {}) }, s.resetToken)
        const marketConfig = draft.market || {}
        const [marketData, reloadMarket] = useLoad(function () { return api.getMarket() }, [])
        const [busy, run] = useAsyncAction()
        const dirty = configChanged(s.config, draft)
        const data = marketData.data || {}
        const entries = Array.isArray(data.entries) ? data.entries : []

        const install = function (entry) {
          run(async function () {
            try {
              const response = await api.installFromMarket(entry.id)
              const persona = response && response.persona ? response.persona : {}
              s.showBanner({ text: '已安装人格：' + (persona.name || entry.name), tone: 'success' })
              reloadMarket()
              await s.refreshAll()
            } catch (error) {
              s.fail(error)
            }
          })
        }

        return h(
          'div',
          null,
          h(
            Card,
            {
              title: '市场设置',
              desc: '远程索引可随时关闭；关闭后只用插件内置人格。',
              extra: h(SaveBar, {
                dirty: dirty,
                saving: s.saving,
                readOnly: s.readOnly,
                readOnlyReason: s.readOnlyReason,
                onSave: function () { s.saveConfig(draft) },
                onDiscard: s.discard,
              }),
            },
            h(
              'div',
              { className: 'dwp-grid2' },
              h(Field, {
                label: '人格市场索引 URL',
                hint: '留空则只显示内置目录。索引应返回 MarketEntry[] 或 { entries: [...] }。',
                control: h(TextInput, {
                  value: marketConfig.indexUrl || '',
                  placeholder: 'https://example.com/personas/index.json',
                  onChange: function (value) { setDraft(setPath(draft, 'market.indexUrl', value)) },
                }),
              }),
              h(
                'div',
                null,
                h(Switch, {
                  checked: marketConfig.builtinOnly === true,
                  onChange: function (value) { setDraft(setPath(draft, 'market.builtinOnly', value)) },
                  label: '仅使用内置人格',
                  hint: '开启后不访问远程索引。',
                }),
                h(Field, {
                  label: '远程请求超时',
                  unit: '毫秒',
                  control: h(NumberInput, {
                    value: marketConfig.timeoutMs,
                    min: 1000,
                    max: 60000,
                    step: 500,
                    onChange: function (value) {
                      setDraft(setPath(draft, 'market.timeoutMs', clampInt(value, 1000, 60000, 8000)))
                    },
                  }),
                }),
              ),
            ),
          ),
          h(
            Card,
            {
              title: '人格广场',
              desc: '共 ' + entries.length + ' 个条目。安装后到「人格」页启用。',
              extra: h(
                'div',
                { className: 'dwp-actions' },
                h(
                  Badge,
                  { tone: data.source === 'remote' ? 'success' : 'neutral' },
                  data.source === 'remote' ? '远程索引' : '内置目录',
                ),
                h(Button, { size: 'sm', onClick: reloadMarket, busy: marketData.status === 'loading' }, '刷新'),
              ),
            },
            data.warning ? h('div', { className: 'dwp-banner dwp-banner--warn' }, h('span', { className: 'dwp-bannerText' }, data.warning)) : null,
            marketData.status === 'loading' ? h(Loading, { text: '读取人格广场…' }) : null,
            marketData.error ? h('div', { className: 'dwp-errorBox' }, '读取失败：' + errorMessage(marketData.error)) : null,
            entries.length
              ? h(
                  'div',
                  { className: 'dwp-marketGrid' },
                  entries.map(function (entry) {
                    return h(
                      'div',
                      { key: entry.id, className: 'dwp-marketCard' },
                      h(
                        'div',
                        { className: 'dwp-marketHead' },
                        h(Avatar, { value: entry.avatar, large: true, alt: entry.name }),
                        h(
                          'div',
                          null,
                          h('div', { className: 'dwp-marketName' }, entry.name || entry.id),
                          h(
                            'div',
                            { className: 'dwp-marketMeta' },
                            entry.author ? h('span', null, entry.author) : null,
                            entry.version ? h(Badge, { tone: 'neutral' }, 'v' + entry.version) : null,
                            typeof entry.downloads === 'number' ? h(Badge, { tone: 'neutral' }, '下载 ' + entry.downloads) : null,
                          ),
                        ),
                      ),
                      entry.description ? h('div', { className: 'dwp-marketDesc' }, entry.description) : null,
                      (entry.tags || []).length
                        ? h(
                            'div',
                            { className: 'dwp-tagRow' },
                            entry.tags.map(function (tag) {
                              return h(Chip, { key: tag }, tag)
                            }),
                          )
                        : null,
                      h(
                        'div',
                        { className: 'dwp-actions', style: { marginTop: 'auto' } },
                        entry.installed
                          ? h(Badge, { tone: 'success' }, '已安装')
                          : h(
                              Button,
                              { size: 'sm', variant: 'primary', busy: busy, onClick: function () { install(entry) } },
                              '安装',
                            ),
                      ),
                    )
                  }),
                )
              : marketData.status === 'ready'
                ? h(EmptyState, null, '市场里还没有条目。可以配置远程索引，或手动导入人格 JSON。')
                : null,
          ),
        )
      }

      // =====================================================================
      // 帮助
      // =====================================================================
      function HelpTab(props) {
        const s = props.shared
        const [help] = useLoad(function () { return api.getHelp() }, [])
        const data = help.data || {}
        const config = s.config || {}

        return h(
          'div',
          null,
          h(
            Card,
            { title: '快速开始', desc: '五步把微信分身跑起来。' },
            h(
              'ol',
              { className: 'dwp-md' },
              h('li', { className: 'dwp-mdLi' }, '在「白名单」里填上允许回复的联系人备注名（必须和微信备注一致）。'),
              h('li', { className: 'dwp-mdLi' }, '在「人格」里选择或导入一个人格，并确认「启用人格回复」打开。'),
              h('li', { className: 'dwp-mdLi' }, '在「在线时段」里设置允许回复的时间段。'),
              h('li', { className: 'dwp-mdLi' }, '在「回复策略」里调好字数、频率与拆条节奏（默认值可直接用）。'),
              h('li', { className: 'dwp-mdLi' }, '在「日志与测试」里注入一条模拟消息，确认链路通了再连真实通道。'),
            ),
          ),
          h(
            Card,
            { title: '使用说明', desc: help.status === 'error' ? '未能从 Host 读取帮助文本，下面是内置说明。' : 'Host 提供的完整用法说明。' },
            help.status === 'loading'
              ? h(Loading, { text: '读取帮助…' })
              : data.usage
                ? h(MarkdownLite, { text: data.usage })
                : h(
                    'div',
                    { className: 'dwp-md' },
                    h('div', { className: 'dwp-mdP' }, '插件通过 DSH 插件设置页管理，配置保存在工作区 .dsh-wechat-persona 目录（可在配置 dataDir 中修改）。'),
                    h('div', { className: 'dwp-mdP' }, '回复完全由本地决策 + 当前 DSH 模型完成；除模型调用与可选搜索外，数据不出本机。'),
                    h('div', { className: 'dwp-mdP' }, '遇到「为什么没回复」：先看「日志与测试」的 skip / risk 事件，再检查暂停状态、在线时段、白名单与预算。'),
                  ),
          ),
          h(
            Card,
            { title: '常见问题', desc: '按出现频率排序。' },
            h(
              'div',
              { className: 'dwp-md' },
              h('div', { className: 'dwp-mdP' }, 'Q：消息匹配上了但没回复？A：检查总开关 enabled、白名单白名单只回复模式、暂停状态、在线时段与预算阶段。'),
              h('div', { className: 'dwp-mdP' }, 'Q：回复太频繁/太少？A：调「回复策略 → 频率限制」的每小时/每天上限，以及「拟人节奏」的拆条概率。'),
              h('div', { className: 'dwp-mdP' }, 'Q：怎么让 Ta 说话更像某个人？A：编辑人格的「系统提示词」「口头禅」「对话示例」，示例最影响语气。'),
              h('div', { className: 'dwp-mdP' }, 'Q：不小心点了暂停或熔断？A：到「日志与测试」或「预算与安全」点「继续运行 / 人工确认并恢复」。'),
              h('div', { className: 'dwp-mdP' }, 'Q：.zip 人格包能直接导入吗？A：暂不支持，解压后导入其中的 persona.json。'),
            ),
          ),
          h(
            Card,
            { title: '数据与隐私' },
            h(KeyValue, {
              items: [
                { key: 'datadir', label: '数据目录', value: String(config.dataDir || '工作区/.dsh-wechat-persona') },
                { key: 'provider', label: '模型来源', value: '当前 DSH 会话配置的模型（可在 DSH 设置里切换）' },
                { key: 'search', label: '搜索', value: config.search && config.search.enabled === false ? '已关闭' : '按需开启，每日限额' },
                { key: 'version', label: '插件版本', value: s.health && s.health.version ? s.health.version : '未知' },
              ],
            }),
            h('div', { className: 'dwp-hint' }, '建议定期在「预算与安全」里检查审计日志大小，必要时清空。'),
          ),
          h(
            Card,
            { title: '更新日志' },
            data.changelog
              ? h(MarkdownLite, { text: data.changelog })
              : h(EmptyState, null, help.status === 'error' ? 'Host 未提供更新日志。' : '暂无更新日志。'),
          ),
        )
      }

      // =====================================================================
      // 首次配置向导（Phase F）：未完成首次配置时显示；全程默认不真实发送
      // =====================================================================
      const ONBOARDING_STEPS = [
        {
          title: '确认插件已加载',
          body: '插件已在 DSH 中加载成功；版本与运行状态见页面顶部。没加载成功时请先到 DSH → 插件里开启本插件。',
        },
        {
          title: '选择通道',
          body: '建议先用 mock 模拟通道验证人格与回复链路；确认无误后再切到真实通道（手机 ADB / Windows 虚拟机 / 本机桌面）。',
        },
        {
          title: '开启安全模式',
          body: '安全模式开启后，只要通道不是 mock，引擎就拒绝一切真实发送（自动回复与手动测试都会被拒），只允许 mock 空转。首次配置强烈建议开启。',
        },
        {
          title: '白名单与在线时段',
          body: '只回复白名单里的联系人，在线时段外完全静默。保存完成后可在左侧「白名单」「在线时段」标签页继续完善。',
        },
      ]

      function OnboardingWizard(props) {
        const s = props.shared
        const base = s.config || {}
        const [step, setStep] = React.useState(0)
        const [channel, setChannel] = React.useState(base.activeChannel === 'desktop' ? 'desktop' : 'mock')
        const [safeMode, setSafeMode] = React.useState(true)
        const [saving, setSaving] = React.useState(false)
        const [error, setError] = React.useState('')
        const total = ONBOARDING_STEPS.length
        const current = ONBOARDING_STEPS[step]

        function finish() {
          setSaving(true)
          setError('')
          const next = Object.assign({}, base, { activeChannel: channel, safeMode: safeMode, onboardingDone: true })
          s.saveConfig(next)
            .then(function () {
              setSaving(false)
              s.showBanner({
                text: safeMode ? '首次配置完成，安全模式已开启（可随时在「预算与安全」中关闭）' : '首次配置完成（安全模式未开启，请确认通道设置）',
                tone: safeMode ? 'success' : 'warn',
              })
              s.setTab('overview')
            })
            .catch(function (failure) {
              setSaving(false)
              setError(errorMessage(failure))
              s.fail(failure)
            })
        }

        return h(
          Card,
          {
            title: '首次配置向导（' + (step + 1) + '/' + total + '）',
            desc: '按步骤确认后开始使用；向导全程不会发送任何真实消息。',
            extra: s.readOnly ? h(Badge, { tone: 'warn' }, '配置只读') : null,
          },
          h(SectionTitle, null, current.title),
          h('div', { className: 'dwp-hint' }, current.body),
          step === 1
            ? h(Field, {
                label: '运行通道',
                hint: '先用 mock 验证；之后在「概览」或配置里切换真实通道。',
                control: h(Select, {
                  options: CHANNELS,
                  value: channel,
                  onChange: function (value) { setChannel(value) },
                }),
              })
            : null,
          step === 2
            ? h(Switch, {
                checked: safeMode === true,
                onChange: function (value) { setSafeMode(value) },
                label: '开启安全运行模式（禁止真实发送，仅 mock 空转）',
              })
            : null,
          error ? h('div', { className: 'dwp-errorBox' }, '保存失败：' + error) : null,
          h(
            'div',
            { className: 'dwp-actions' },
            step > 0 ? h(Button, { variant: 'ghost', disabled: saving, onClick: function () { setStep(step - 1) } }, '上一步') : null,
            step < total - 1
              ? h(Button, { variant: 'primary', onClick: function () { setStep(step + 1) } }, '下一步')
              : null,
            step === total - 1
              ? h(Button, { variant: 'primary', busy: saving, disabled: s.readOnly, onClick: finish }, '完成配置')
              : null,
            h(
              Button,
              {
                variant: 'ghost',
                disabled: saving || s.readOnly,
                onClick: function () {
                  setSaving(true)
                  setError('')
                  const next = Object.assign({}, base, { onboardingDone: true })
                  s.saveConfig(next)
                    .then(function () {
                      setSaving(false)
                      s.showBanner({ text: '已跳过首次配置向导，可随时在标签页里继续配置', tone: 'warn' })
                    })
                    .catch(function (failure) {
                      setSaving(false)
                      setError(errorMessage(failure))
                      s.fail(failure)
                    })
                },
              },
              '跳过向导',
            ),
          ),
        )
      }

      // =====================================================================
      // 设置面板：settings.section 与 plugins.bundle.config 共用同一套界面
      // =====================================================================
      const TAB_COMPONENTS = {
        overview: OverviewTab,
        persona: PersonaTab,
        whitelist: WhitelistTab,
        schedule: ScheduleTab,
        reply: ReplyTab,
        stickers: StickersTab,
        budget: BudgetTab,
        logs: LogsTab,
        market: MarketTab,
        help: HelpTab,
      }

      const STYLE_ELEMENT_ID = MODULE_ID + ':style'

      /** 注入样式（幂等）；返回清理函数。 */
      function installStyleSheet() {
        if (typeof document === 'undefined' || !document.head) return function () {}
        let node = document.getElementById(STYLE_ELEMENT_ID)
        if (node) return function () {}
        node = document.createElement('style')
        node.id = STYLE_ELEMENT_ID
        node.setAttribute('data-plugin', MODULE_ID)
        node.textContent = CSS
        document.head.appendChild(node)
        return function () {
          if (node && node.parentNode) node.parentNode.removeChild(node)
        }
      }

      /**
       * 保存结果判定：只有 Host 明确返回 JSON `{ok:false,error}` 才算保存失败。
       * POST /config 走宿主 configEditor.edit，会触发本插件重载，HTTP 连接可能被一起拆掉；
       * 此时 fetch 得到网络错误属于正常现象，绝不能显示成红色「保存失败」。
       */
      function saveFailureText(error) {
        if (!error) return null
        // 非 ApiError（网络层/代码异常）一律按「不确定」处理：随后会用 GET /config 确认。
        if (!(error instanceof ApiError)) return null
        const payload = error.payload
        const explicit =
          error.parsedBody === true && payload && typeof payload === 'object' && (payload.ok === false || payload.error)
        return explicit ? errorMessage(error) : null
      }

      function Panel(props) {
        const tt = props && typeof props.t === 'function' ? props.t : t
        const embedded = !!(props && props.embedded)
        const [tabId, setTabId] = React.useState('overview')
        const [mounted, setMounted] = React.useState(function () { return { overview: true } })
        const [message, setMessage] = useMessage()
        const [config, setConfig] = React.useState(null)
        const [persist, setPersist] = React.useState({})
        const [health, setHealth] = React.useState(null)
        const [status, setStatus] = React.useState(null)
        const [personas, setPersonas] = React.useState(null)
        const [loading, setLoading] = React.useState(true)
        const [loadError, setLoadError] = React.useState(null)
        const [saving, setSaving] = React.useState(false)
        const [resetToken, setResetToken] = React.useState(0)

        const persistRef = React.useRef(persist)
        persistRef.current = persist

        // 四个接口用 allSettled 并行读取：一个失败不影响其它区块渲染。
        const load = React.useCallback(function (quiet) {
          if (!quiet) setLoading(true)
          return Promise.allSettled([api.getHealth(), api.getStatus(), api.getConfig(), api.getPersonas()]).then(function (results) {
            const errors = []
            if (results[0].status === 'fulfilled') setHealth(results[0].value)
            else errors.push('健康状态：' + errorMessage(results[0].reason))
            if (results[1].status === 'fulfilled') setStatus(results[1].value)
            else errors.push('运行状态：' + errorMessage(results[1].reason))
            let configResponse = null
            if (results[2].status === 'fulfilled') {
              configResponse = results[2].value || {}
              setConfig(configResponse.config || {})
              setPersist(configResponse.persist || {})
            } else {
              errors.push('配置：' + errorMessage(results[2].reason))
            }
            if (results[3].status === 'fulfilled') setPersonas(results[3].value)
            else errors.push('人格：' + errorMessage(results[3].reason))
            setLoadError(errors.length ? errors.join('；') : null)
            if (!quiet) setLoading(false)
            return configResponse
          })
        }, [])

        React.useEffect(
          function () {
            load(false)
          },
          [load],
        )

        // 懒挂载 + keep-alive：标签页第一次打开后保持挂载，切换不丢失未保存草稿。
        React.useEffect(
          function () {
            setMounted(function (prev) {
              if (prev[tabId]) return prev
              const next = Object.assign({}, prev)
              next[tabId] = true
              return next
            })
          },
          [tabId],
        )

        const showBanner = React.useCallback(function (next) {
          setMessage(next || null)
        }, [])
        const fail = React.useCallback(function (error) {
          setMessage({ text: errorMessage(error), tone: 'error' })
        }, [])
        const refreshAll = React.useCallback(function () {
          return load(true)
        }, [load])
        const refreshPersonas = React.useCallback(function () {
          return api.getPersonas().then(setPersonas).catch(fail)
        }, [fail])
        const refreshStatus = React.useCallback(function () {
          return api.getStatus().then(setStatus).catch(fail)
        }, [fail])

        const discard = React.useCallback(function () {
          setSaving(true)
          return api
            .getConfig()
            .then(function (res) {
              setConfig((res && res.config) || {})
              setPersist((res && res.persist) || {})
              setResetToken(function (value) { return value + 1 })
              setMessage({ text: '已放弃修改并重新载入配置', tone: 'neutral' })
            })
            .catch(function (error) {
              setMessage({ text: '重新载入配置失败：' + errorMessage(error), tone: 'error' })
            })
            .finally(function () {
              setSaving(false)
            })
        }, [])

        const saveConfig = React.useCallback(function (next) {
          if (!next) return Promise.resolve()
          const current = persistRef.current || {}
          if (current.editable === false) {
            setMessage({ text: '配置当前只读：' + (current.reason || 'Host 未启用配置写入'), tone: 'warn' })
            return Promise.resolve()
          }
          setSaving(true)
          return (async function () {
            let accepted = false
            try {
              await api.saveConfig(next)
              accepted = true
            } catch (error) {
              const failureText = saveFailureText(error)
              if (failureText !== null) {
                setMessage({ text: '保存失败：' + failureText, tone: 'error' })
                setSaving(false)
                return
              }
              // 网络错误 / 非 JSON 响应：重载已发生，按「已提交」继续等待即可。
            }
            setMessage({
              text: accepted ? '已保存，插件重载中…' : '已保存（插件重载导致连接瞬断），正在确认…',
              tone: 'warn',
            })
            // Host 的 configEditor.edit 是异步的：等重载窗口过去后再拉一次配置与状态。
            await sleep(1500)
            try {
              const res = await api.getConfig()
              setConfig((res && res.config) || {})
              setPersist((res && res.persist) || {})
              const lastError = res && res.persist && res.persist.lastError
              if (lastError) {
                setMessage({ text: 'Host 应用配置失败：' + String(lastError), tone: 'error' })
              } else if (!configChanged(next, res && res.config)) {
                setMessage({ text: '已保存并生效', tone: 'success' })
              } else {
                setMessage({ text: '已保存，配置仍在异步应用，稍后点「刷新」确认', tone: 'warn' })
              }
            } catch (error) {
              setMessage({ text: '已保存，但暂时读不到新配置（插件可能仍在重载），请稍后点「刷新」', tone: 'warn' })
            }
            try {
              const nextStatus = await api.getStatus()
              setStatus(nextStatus)
            } catch (error) {
              // 重载窗口内拿不到状态属于正常现象，忽略。
            }
            setSaving(false)
          })()
        }, [])

        const readOnly = !!(persist && persist.editable === false)
        const readOnlyReason = persist && persist.reason ? String(persist.reason) : ''
        const shared = {
          t: tt,
          config: config || {},
          persist: persist || {},
          health: health,
          status: status,
          personas: personas,
          saving: saving,
          readOnly: readOnly,
          readOnlyReason: readOnlyReason,
          resetToken: resetToken,
          refreshAll: refreshAll,
          refreshPersonas: refreshPersonas,
          refreshStatus: refreshStatus,
          saveConfig: saveConfig,
          discard: discard,
          showBanner: showBanner,
          fail: fail,
          setTab: setTabId,
        }

        const view = engineStatusView(status)
        const bannerMessage = message || (loadError ? { text: '部分数据读取失败：' + loadError, tone: 'error' } : null)
        const readOnlyMessage = readOnly
          ? {
              text:
                '配置当前只读：' +
                (readOnlyReason || 'Host 未启用配置写入') +
                '。仍可浏览配置、查看日志、测试消息与暂停/恢复。',
              tone: 'warn',
            }
          : null
        // 发布前验收（任务书第五部分）：只读测试模式（持久化配置）全局提示。
        // 该提示只做展示，页面上不提供任何绕过发送门禁的开关。
        const readOnlyTestModeOn = !!(config && config.readOnlyTestMode === true)
        const readOnlyTestModeMessage = readOnlyTestModeOn
          ? {
              text:
                '只读测试模式已开启（持久化配置，重启后仍生效）：代码层已禁止一切真实发送——自动回复、/test/send、/drafts/approve、desktop 发送以及 PS1 的键盘回车/粘贴提交都会被拒绝；当前仅允许读取、诊断与 mock 空转。',
              tone: 'warn',
            }
          : null

        const titleNode = h(
          'div',
          null,
          h('h2', { className: 'dwp-title' }, tt('title', '微信分身设置')),
          embedded
            ? null
            : h('p', { className: 'dwp-sub' }, tt('subtitle', '让一个小号替你在微信里自然地聊天：白名单、在线时段、人格、预算与安全都在这里配置。')),
        )

        let content
        if (!config && loading) {
          content = h('div', { className: 'dwp-root' }, h(Loading, { text: '正在读取插件配置…' }))
        } else if (!config) {
          content = h(
            'div',
            { className: 'dwp-root' },
            h('header', { className: 'dwp-head' }, h('div', { className: 'dwp-headRow' }, titleNode)),
            h('div', { className: 'dwp-errorBox' }, loadError || '未能读取插件配置，Host 可能尚未启动。'),
            h(
              'div',
              { className: 'dwp-actions', style: { marginTop: '12px' } },
              h(Button, { variant: 'primary', onClick: function () { load(false) } }, '重试'),
            ),
          )
        } else {
          content = h(
            'div',
            { className: 'dwp-root' },
            h(
              'header',
              { className: 'dwp-head' },
              h(
                'div',
                { className: 'dwp-headRow' },
                titleNode,
                h(
                  'div',
                  { className: 'dwp-actions' },
                  h(Badge, { tone: view.tone }, view.label),
                  health && health.version ? h(Badge, { tone: 'neutral' }, 'v' + health.version) : null,
                  readOnly ? h(Badge, { tone: 'warn', title: readOnlyReason || '配置当前不可写' }, '只读') : null,
                  readOnlyTestModeOn ? h(Badge, { tone: 'warn', title: '只读测试模式：代码层禁止一切真实发送' }, '只读测试模式') : null,
                  h(Button, { size: 'sm', onClick: function () { load(true) } }, '刷新'),
                ),
              ),
              h(
                'div',
                { className: 'dwp-meta' },
                h('span', null, '通道：' + (status && status.channelId ? String(status.channelId) : '—')),
                view.detail ? h('span', null, view.detail) : null,
                health && health.uptime ? h('span', null, '已运行 ' + formatUptime(health.uptime)) : null,
                readOnly && readOnlyReason ? h('span', null, '只读原因：' + readOnlyReason) : null,
              ),
            ),
            h(
              'div',
              { className: 'dwp-tabs', role: 'tablist', 'aria-label': '微信分身设置分区' },
              TABS.map(function (tab) {
                const active = tabId === tab.id
                return h(
                  'button',
                  {
                    key: tab.id,
                    type: 'button',
                    role: 'tab',
                    className: 'dwp-tab',
                    'aria-selected': active,
                    'aria-controls': 'dwp-panel-' + tab.id,
                    onClick: function () { setTabId(tab.id) },
                  },
                  h('span', { 'aria-hidden': true }, tab.icon),
                  tab.label,
                )
              }),
            ),
            bannerMessage
              ? h(Banner, {
                  message: bannerMessage,
                  onClose: function () {
                    setMessage(null)
                    setLoadError(null)
                  },
                })
              : null,
            readOnlyMessage ? h(Banner, { message: readOnlyMessage }) : null,
            readOnlyTestModeMessage ? h(Banner, { message: readOnlyTestModeMessage }) : null,
            config && config.onboardingDone !== true ? h(OnboardingWizard, { shared: shared }) : null,
            h(
              'div',
              { className: 'dwp-body' },
              TABS.map(function (tab) {
                if (!mounted[tab.id]) return null
                const TabComponent = TAB_COMPONENTS[tab.id]
                if (!TabComponent) return null
                const active = tabId === tab.id
                return h(
                  'div',
                  {
                    key: tab.id,
                    id: 'dwp-panel-' + tab.id,
                    role: 'tabpanel',
                    'aria-hidden': !active,
                    style: active ? undefined : { display: 'none' },
                  },
                  h(TabComponent, { shared: shared }),
                )
              }),
            ),
          )
        }

        return h(ErrorBoundary, { label: '微信分身设置' }, content)
      }

      // =====================================================================
      // 插件 apply：注入样式 + 注册文案 + 注册两个设置入口
      // =====================================================================
      function applyPlugin(ctx) {
        try {
          if (!ctx) return undefined
          const disposers = []
          const push = function (dispose) {
            if (typeof dispose === 'function') disposers.push(dispose)
          }

          if (typeof ctx.effect === 'function') {
            push(ctx.effect(installStyleSheet, MODULE_ID + ':style'))
          } else {
            push(installStyleSheet())
          }

          let translate = t
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            const registerDictionary = function () {
              return ctx.locale.register(MODULE_ID, { zh: ZH, en: EN })
            }
            if (typeof ctx.effect === 'function') {
              push(ctx.effect(registerDictionary, MODULE_ID + ':locale'))
            } else {
              push(registerDictionary())
            }
            if (typeof ctx.locale.bind === 'function') {
              try {
                const bound = ctx.locale.bind(MODULE_ID)
                if (typeof bound === 'function') {
                  translate = function (key, fallback) {
                    try {
                      const value = bound(key, fallback)
                      return typeof value === 'string' ? value : fallback !== undefined ? fallback : key
                    } catch (error) {
                      return fallback !== undefined ? fallback : key
                    }
                  }
                }
              } catch (error) {
                console.warn('[dsh-wechat-persona] locale.bind 失败，使用内置中文文案', error)
              }
            }
          }

          if (!ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
            console.warn('[dsh-wechat-persona] 当前 Host 缺少 slots 服务，设置界面未注册')
            return function () {
              for (const dispose of disposers) {
                try {
                  dispose()
                } catch (error) {
                  console.warn('[dsh-wechat-persona] 清理失败', error)
                }
              }
            }
          }

          const panelFor = function (embedded) {
            return function () {
              return h(ErrorBoundary, { label: '微信分身设置' }, h(Panel, { embedded: embedded, t: translate }))
            }
          }

          const registerSlots = function () {
            const inner = []
            const bundleDispose = ctx.slots.inject('plugins.bundle.config', function () {
              const dispose = ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: MODULE_ID,
                  locale: MODULE_ID,
                  inject: function () { return { t: translate } },
                },
                function (ownerProps) {
                  // summary 视图显示 bundle 摘要，不重复渲染整页设置。
                  if (ownerProps && ownerProps.view === 'summary') return null
                  return panelFor(true)()
                },
              )
              return typeof dispose === 'function' ? dispose : undefined
            })
            if (typeof bundleDispose === 'function') inner.push(bundleDispose)

            const settingsDispose = ctx.slots.inject('settings.section', function () {
              const dispose = ctx.slots.register(
                {
                  name: 'settings.section',
                  id: MODULE_ID,
                  order: 45,
                  label: function () { return translate('nav', '微信分身') },
                  locale: MODULE_ID,
                  inject: function () { return { t: translate } },
                },
                panelFor(false),
              )
              return typeof dispose === 'function' ? dispose : undefined
            })
            if (typeof settingsDispose === 'function') inner.push(settingsDispose)

            return function () {
              for (const dispose of inner) {
                try {
                  dispose()
                } catch (error) {
                  console.warn('[dsh-wechat-persona] 注销设置入口失败', error)
                }
              }
            }
          }

          if (typeof ctx.effect === 'function') {
            push(ctx.effect(registerSlots, MODULE_ID + ':slots'))
          } else {
            push(registerSlots())
          }

          return function () {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch (error) {
                console.warn('[dsh-wechat-persona] 清理插件资源失败', error)
              }
            }
          }
        } catch (error) {
          console.error('[dsh-wechat-persona] 客户端插件注册失败（设置界面可能不可用）', error)
          return undefined
        }
      }

      return {
        name: MODULE_ID,
        inject: ['slots', 'locale'],
        apply: applyPlugin,
        // 仅供 test/client/smoke.test.ts 断言关键纯逻辑；模块加载器只读取 name/inject/apply。
        __test: Object.freeze({
          ApiError: ApiError,
          saveFailureText: saveFailureText,
          isExternalUrl: isExternalUrl,
        }),
      }
    },
  })
})()
