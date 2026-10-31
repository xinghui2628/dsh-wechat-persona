#!/usr/bin/env node
/**
 * check-sensitive.mjs — 公开仓库敏感信息扫描门禁（v3.0.0 引入）
 *
 * 用途：发布/提交前扫描 **git 受跟踪文件**，发现真实姓名、wxid、手机号、
 * 真实邮箱、API key、本机绝对路径等疑似隐私数据即失败（exit 1）。
 * 输出只含**打码后的片段**（敏感值中间字符替换为 *），不会把原始敏感值
 * 打印到终端/CI 日志。
 *
 * 用法：
 *   node scripts/check-sensitive.mjs     # 直接运行
 *   npm run check:sensitive              # package.json 脚本别名
 *
 * 退出码：
 *   0 = 未发现敏感信息
 *   1 = 有命中（需脱敏后重跑）
 *   2 = 环境错误（git 不可用 / 不在 git 仓库内）
 *
 * 扫描范围：
 *   `git ls-files` 的全部受跟踪文件；跳过二进制文件、node_modules/、dist/、
 *   test/fixtures/ocr-corpus/images/（OCR 合成语料截图，不含文本）。
 *
 * 规则（新增规则请同步更新本文件头部的规则清单）：
 *   [wxid]         wxid_<id>：白名单虚构值（alice/bob/zhangsan/stranger…）放行
 *   [本机路径]      X:\Users\<真实用户名>\...：<你>/<用户名>/<username>、[正则片段] 等占位放行
 *   [手机号]        中国大陆手机号 1[3-9]\d{9}（前后须是边界，避免命中时间戳）
 *   [真实邮箱]      排除 GitHub noreply 与 example.com/org/net 等保留域名
 *   [密钥/Token]   sk- / ghp_ / github_pat_ / AKIA / PRIVATE KEY
 *   [疑似真实姓名]  启发式三路（宁可多报）：
 *                  ① 中文引号内的 2-3 字候选，且以常见姓氏开头、所在行含姓名语境词；
 *                  ② `read` / `-Contact` 行内代码中紧跟的 2-3 字候选（以常见姓氏开头）；
 *                  ③ 好友/联系人/昵称 等关键词紧邻的中文引号名或「关键词：姓名」形式。
 *                  虚构测试名/测试语料（张三、李四、张伟、测试甲、测试乙、微信团队、
 *                  文件传输助手…）与常见非人名词放行（NAME_ALLOW 白名单）。
 *
 * 说明：姓名规则是启发式兜底，白名单在文件内维护；宁可多报也不放过真实姓名。
 * 本脚本零依赖，只用 Node 内置模块（node >= 22）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = resolveRepoRoot(scriptDir)

/* ------------------------------------------------------------------ */
/* 白名单（虚构值 / 占位符 / 常见非姓名词）                              */
/* ------------------------------------------------------------------ */

/** 允许出现在仓库里的虚构 wxid 后缀（test/ 与文档里的示例） */
const WXID_ALLOW = new Set([
  'a', 'b', 'c', 'x', 'y', 'z', 'demo', 'foo', 'bar', 'test', 'tester', 'sample',
  'mock', 'fake', 'user', 'unknown', 'stranger', 'placeholder', 'redacted', 'masked',
  'alice', 'bob', 'carol', 'dave', 'eve', 'zhangsan', 'lisi', 'wangwu',
])

/** 允许的邮箱域名（GitHub noreply 与 IANA 保留示例域名） */
const EMAIL_DOMAIN_ALLOW = [
  'users.noreply.github.com',
  'noreply.github.com',
  'example.com', 'example.org', 'example.net',
]

/** 允许的姓名 / 昵称（虚构测试名 + 微信官方账号 + 常见非姓名短词） */
const NAME_ALLOW = new Set([
  // 文档/测试里长期使用的虚构名（0.2.x 起沿用，均为示例化名）
  '张三', '张四', '张五', '张伟', '张磊', '张玮', '李四', '王五', '赵六',
  '小王', '老王', '老张', '老周', '老王吧',
  '测试甲', '测试乙', '测试丙', '测试丁', '测试群',
  '微信团队', '文件传输助手', '项目群',
  // 内置人格的虚构昵称
  '大肥鱼', '大吧鱼', '阿码',
  // 常见非人名的 2-3 字中文词（避免「」引用普通词时误报）
  '好友', '联系人', '昵称', '备注', '聊天', '消息', '窗口', '微信', '文件',
  '传输', '助手', '今天', '明天', '默认', '温度', '文档', '文本', '方法', '方式',
  '方案', '方向', '用户', '项目', '数据', '发送', '读取', '截图', '中文', '测试',
  '搜索', '人格', '表情', '语音', '图片', '时间', '状态', '配置', '端口', '路径',
  '日志', '网络', '内容', '问题', '功能', '接口', '服务', '系统', '模型', '提示',
  '回复', '白名单', '熔断', '预算', '记忆', '草稿', '审计', '安全', '隐私',
  '敏感', '脱敏', '虚构', '占位', '示例', '真实', '随机', '自动', '手动', '在线',
  '离线', '异常', '失败', '成功', '拒绝', '允许', '跳过', '命中', '规则', '扫描',
  '单文件', '概览', '客户', '帮助', '现状', '兜底', '完整', '启发', '备用',
  '备注名', '联系人名', '微信名', '微信备注',
])

/** 常见中文姓氏（用于「疑似姓名」启发式；覆盖常见单姓） */
const SURNAMES = new Set(
  (
    '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻' +
    '柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕' +
    '殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米' +
    '贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅' +
    '盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪解应宗丁宣邓郁单杭' +
    '洪包诸左石崔吉龚程邢裴陆荣翁荀羊惠甄曲封储靳汲邴松井段富巫乌焦巴弓牧隗山' +
    '谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄' +
    '印宿白怀蒲邰鄂索咸籍赖卓蔺屠蒙池乔阴胥苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦' +
    '雍桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈' +
    '廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩聂晁勾敖融冷訾' +
    '辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公'
  ).split(''),
)

/** 姓名语境词：出现在同一行时才把「姓氏开头的中文引号词」当姓名（降误报） */
const NAME_CONTEXT = /(好友|联系人|昵称|姓名|名字|备注名|称呼|实测|真实微信|OCR|识别出|微信名)/u

/** 中文引号内的候选（2-3 个连续汉字） */
const QUOTED_NAME = /[「“]([\u4e00-\u9fa5]{2,3})[」”]/gu

/** 好友/联系人/昵称 等关键词紧邻的中文引号名或「关键词：姓名」 */
const KW_QUOTED_NAME = /(?:好友|联系人|昵称|微信名|微信备注|备注名|联系人名)\s*[「“]([\u4e00-\u9fa5]{2,3})[」”]/gu
const KW_COLON_NAME = /(?:好友|联系人|昵称|微信名|微信备注|备注名|联系人名)\s*[：:]\s*([\u4e00-\u9fa5]{2,3})(?![\u4e00-\u9fa5])/gu

/** `read 张三` / `-Contact 张三`：只认行内代码（`...`）里的命令示例 */
const CMD_NAME = /\b(?:read|-Contact)\s*[：:=]?\s*[「“]?([\u4e00-\u9fa5]{2,3})(?![」”]?[\u4e00-\u9fa5A-Za-z0-9])/gu

/* ------------------------------------------------------------------ */
/* 扫描规则                                                            */
/* ------------------------------------------------------------------ */

/**
 * 每条规则：
 *   { id, category, test(line) -> [{ index, length, masked }] }
 * 规则只需在一行内工作；输出时统一做位置排序与片段裁剪。
 */
const RULES = [
  {
    id: 'wxid',
    category: 'wxid',
    test(line) {
      const out = []
      for (const m of line.matchAll(/\bwxid_([A-Za-z0-9_]+)/gu)) {
        if (WXID_ALLOW.has(m[1].toLowerCase())) continue
        out.push({ index: m.index, length: m[0].length, masked: maskSecret(m[0]) })
      }
      return out
    },
  },
  {
    id: 'users-path',
    category: '本机路径',
    test(line) {
      const out = []
      // 匹配 X:\Users\<用户名>；用户名段必须以路径分隔符/空白/引号等结束
      for (const m of line.matchAll(/\b[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`()<>，。；、）]+)/gu)) {
        const user = m[1]
        // 占位符/正则片段放行：<你>、<用户名>、<username>、%USERNAME%、{{USER}}、[^<] 等
        if (/^[<{%[(]/u.test(user)) continue
        out.push({ index: m.index, length: m[0].length, masked: maskSecret(m[0]) })
      }
      return out
    },
  },
  {
    id: 'phone',
    category: '手机号',
    test(line) {
      const out = []
      for (const m of line.matchAll(/(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])/gu)) {
        out.push({ index: m.index, length: m[0].length, masked: maskSecret(m[0]) })
      }
      return out
    },
  },
  {
    id: 'email',
    category: '真实邮箱',
    test(line) {
      const out = []
      for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu)) {
        const domain = m[0].slice(m[0].lastIndexOf('@') + 1).toLowerCase()
        if (EMAIL_DOMAIN_ALLOW.some((d) => domain === d || domain.endsWith('.' + d))) continue
        out.push({ index: m.index, length: m[0].length, masked: maskSecret(m[0]) })
      }
      return out
    },
  },
  {
    id: 'secret',
    category: '密钥/Token',
    test(line) {
      const out = []
      const patterns = [
        /\bsk-[A-Za-z0-9_-]{16,}/gu,
        /\bghp_[A-Za-z0-9]{20,}/gu,
        /\bgithub_pat_[A-Za-z0-9_]{20,}/gu,
        /\bAKIA[0-9A-Z]{16}\b/gu,
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu,
      ]
      for (const re of patterns) {
        for (const m of line.matchAll(re)) {
          // 纯占位符（sk-xxxxxxxx / 含 ... / 含 <>）放行
          if (/[<>]|\.\.\./.test(m[0]) || /^sk-[x*X_]+$/u.test(m[0])) continue
          out.push({ index: m.index, length: m[0].length, masked: maskSecret(m[0]) })
        }
      }
      return out
    },
  },
  {
    id: 'name-quoted',
    category: '疑似真实姓名',
    test(line) {
      const out = []
      // 「张伟」/“张伟” 这类中文引号内的 2-3 个纯中文字符；须以常见姓氏开头且行内有姓名语境
      if (!NAME_CONTEXT.test(line)) return out
      for (const m of line.matchAll(QUOTED_NAME)) {
        const candidate = m[1]
        if (NAME_ALLOW.has(candidate)) continue
        if (!SURNAMES.has(candidate[0])) continue
        out.push({ index: m.index, length: m[0].length, masked: maskSecret(candidate) })
      }
      return out
    },
  },
  {
    id: 'name-command',
    category: '疑似真实姓名',
    test(line) {
      const out = []
      // `read 张伟` / `-Contact 张伟` 这类命令示例（行内代码）里的 2-3 个中文字符
      for (const m of line.matchAll(CMD_NAME)) {
        if (!inCodeSpan(line, m.index)) continue
        const candidate = m[1]
        if (NAME_ALLOW.has(candidate)) continue
        if (!SURNAMES.has(candidate[0])) continue
        out.push({ index: m.index, length: m[0].length, masked: maskSecret(candidate) })
      }
      return out
    },
  },
  {
    id: 'name-keyword',
    category: '疑似真实姓名',
    test(line) {
      const out = []
      // 好友/联系人/昵称 等关键词紧邻的名字：`好友「张三」` 或 `联系人：张三`
      for (const m of line.matchAll(KW_QUOTED_NAME)) {
        const candidate = m[1]
        if (NAME_ALLOW.has(candidate)) continue
        out.push({ index: m.index, length: m[0].length, masked: maskSecret(candidate) })
      }
      for (const m of line.matchAll(KW_COLON_NAME)) {
        const candidate = m[1]
        if (NAME_ALLOW.has(candidate)) continue
        // 冒号后是无引号的普通文字，误报多，只在「像姓名」（常见姓氏开头）时报告
        if (!SURNAMES.has(candidate[0])) continue
        out.push({ index: m.index, length: m[0].length, masked: maskSecret(candidate) })
      }
      return out
    },
  },
]

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 中间字符打码：1 字→*；2 字→首字+*；≥3 字→首字+***+末字 */
function maskSecret(value) {
  const chars = [...value]
  const n = chars.length
  if (n <= 1) return '*'
  if (n === 2) return chars[0] + '*'
  return chars[0] + '*'.repeat(n - 2) + chars[n - 1]
}

/** index 是否位于 Markdown 行内代码 `` `...` `` 内（按反引号奇偶判断） */
function inCodeSpan(line, index) {
  let ticks = 0
  for (let i = 0; i < index; i++) if (line[i] === '`') ticks++
  return ticks % 2 === 1
}

function resolveRepoRoot(startDir) {
  const r = spawnSync('git', ['-C', startDir, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  return path.resolve(startDir, '..')
}

function listTrackedFiles() {
  const r = spawnSync('git', ['-C', repoRoot, 'ls-files', '-z'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error || r.status !== 0) {
    console.error('[check-sensitive] 无法执行 git ls-files，请在 git 仓库内运行。')
    if (r.error) console.error(String(r.error.message ?? r.error))
    if (r.stderr) console.error(String(r.stderr).trim())
    process.exit(2)
  }
  return r.stdout.split('\0').filter(Boolean)
}

/** 应跳过的路径（相对仓库根，正斜杠） */
function shouldSkip(rel) {
  const skipPrefixes = [
    'node_modules/',
    'dist/',
    'test/fixtures/ocr-corpus/images/',
  ]
  if (skipPrefixes.some((p) => rel.startsWith(p))) return true
  const ext = path.extname(rel).toLowerCase()
  const skipExts = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tif', '.tiff',
    '.zip', '.7z', '.gz', '.tar', '.pdf', '.woff', '.woff2', '.ttf', '.otf',
    '.mp3', '.wav', '.mp4', '.mov', '.onnx', '.bin', '.exe', '.dll', '.pyc',
  ])
  return skipExts.has(ext)
}

function isBinary(buf) {
  const end = Math.min(buf.length, 8192)
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true
  return false
}

/** 裁剪片段：以命中处为中心，最多 140 字符，超出用 … 截断 */
function clip(line, hit) {
  const maskedLine = line.slice(0, hit.index) + hit.masked + line.slice(hit.index + hit.length)
  const limit = 140
  if (maskedLine.length <= limit) return maskedLine
  const center = hit.index + Math.floor(hit.length / 2)
  const start = Math.max(0, center - Math.floor(limit / 2))
  const end = Math.min(maskedLine.length, start + limit)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < maskedLine.length ? '…' : ''
  // 注意：命中位置本身打码后才进入裁剪，避免任何原始敏感值泄漏
  const safe = maskedLine.slice(start, end)
  return prefix + safe + suffix
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const files = listTrackedFiles()
const hits = []
const hitKeys = new Set() // 去重：同一行同一打码值可能被多条规则同时命中（如「好友「张三」」）
let scanned = 0

for (const rel of files) {
  if (shouldSkip(rel)) continue
  const abs = path.join(repoRoot, ...rel.split('/'))
  let buf
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size > 8 * 1024 * 1024) continue
    buf = readFileSync(abs)
  } catch {
    continue // 受跟踪但本地不存在的文件（稀疏检出等）直接跳过
  }
  if (isBinary(buf)) continue
  scanned++

  const lines = buf.toString('utf8').split(/\r?\n/u)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    for (const rule of RULES) {
      for (const hit of rule.test(line)) {
        const key = `${rel}:${i + 1}:${rule.category}:${hit.masked}`
        if (hitKeys.has(key)) continue
        hitKeys.add(key)
        hits.push({
          file: rel,
          line: i + 1,
          column: hit.index + 1,
          category: rule.category,
          snippet: clip(line.trimEnd(), hit),
        })
      }
    }
  }
}

hits.sort((a, b) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line || a.column - b.column))

console.log(`[check-sensitive] 扫描 ${scanned} 个受跟踪文本文件（git ls-files，已跳过二进制/构建产物/OCR 语料截图）`)

if (hits.length === 0) {
  console.log('未发现敏感信息（exit 0）')
  process.exit(0)
}

for (const h of hits) {
  console.log(`${h.file}:${h.line}: [${h.category}] ${h.snippet}`)
}

const hitFiles = new Set(hits.map((h) => h.file))
console.log('')
console.log(`发现 ${hits.length} 处疑似敏感信息（${hitFiles.size} 个文件），已打码显示。`)
console.log('请替换为虚构值/占位符后重跑：node scripts/check-sensitive.mjs')
process.exit(1)
