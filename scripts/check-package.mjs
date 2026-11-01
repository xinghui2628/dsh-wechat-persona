#!/usr/bin/env node
/**
 * 发布包内容检查（release package content check）
 *
 * 用途：在 CI（14.4 第十项「发布包内容检查」）与本地打包前，断言「干净 checkout +
 * dist 构建产物」里会随包分发的文件不含垃圾数据、聊天数据、截图、备份与敏感串。
 *
 * 口径：
 *   - 发布包 = git 受跟踪文件 ∩ package.json `files` 字段 + 本地构建出的 dist/。
 *     理由：从干净 checkout 安装/bundle 时只会带受跟踪文件；dist 由 `npm run build`
 *     在安装流程中生成（本仓库不提交 dist）。本地被 .gitignore 忽略的调试垃圾
 *     （*.bak、__pycache__、日志等）不会进入发布包，只打印警告提醒清理。
 *   - 本仓库 `private: true`，不发布到 npm；本脚本不改任何文件，只读检查。
 *
 * 检查项：
 *   1. package.json 元信息：private:true、无 publishConfig、files 非空、
 *      main/types 产物存在。
 *   2. 发布包路径黑名单：运行时数据（state.json / audit*.jsonl / memory/ 等）、
 *      备份/临时文件（*.bak-*、*.log、*.zip、*.pyc）、敏感目录
 *      （.dsh-tmp/、backups/、dev-notes/、__pycache__/）、截图（图片只允许
 *      stickers/、personas/、persona/ 与根 icon.svg）。
 *   3. 文本文件敏感串扫描：本机绝对路径、真实手机号、真实邮箱、明文 wxid、
 *      密钥/Token 特征（sk-/ghp_/github_pat_/AKIA/PRIVATE KEY/JWT 等）。
 *      规则与 scripts/check-sensitive.mjs 对齐并使用同一组合成白名单；
 *      姓名启发式由 check-sensitive.mjs 负责，本脚本不重复实现，避免误报。
 *   4. 输出待检查文件清单（按目录分组）与失败/警告明细，敏感值打码输出。
 *
 * 退出码：
 *   0 = 通过（可能有警告）
 *   1 = 发现违规内容（发布阻断）
 *   2 = 环境错误（git 不可用、package.json 读不到等）
 *
 * 用法：
 *   node scripts/check-package.mjs            # 检查并输出清单
 *   node scripts/check-package.mjs --help     # 查看说明
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const failures = []
const warnings = []

function fail(message) {
  failures.push(message)
}

function warn(message) {
  warnings.push(message)
}

/** 掩码输出敏感命中，避免日志二次泄露 */
function mask(text) {
  const value = String(text)
  if (value.length <= 8) return value.slice(0, 2) + '***'
  return value.slice(0, 4) + '***' + value.slice(-4)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`[check-package] 无法读取 ${file}：${error.message}`)
    process.exit(2)
  }
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : (result.stderr || '').trim()
    console.error(`[check-package] git ${args.join(' ')} 失败：${detail}`)
    process.exit(2)
  }
  return result.stdout
}

/** 递归列出目录下所有文件（相对路径用 posix 分隔符） */
function walk(relativeDir, out = []) {
  const absolute = path.join(ROOT, relativeDir)
  let entries
  try {
    entries = readdirSync(absolute, { withFileTypes: true })
  } catch (error) {
    warn(`无法读取目录 ${relativeDir}：${error.message}`)
    return out
  }
  for (const entry of entries) {
    const relative = `${relativeDir}/${entry.name}`
    if (entry.isDirectory()) {
      walk(relative, out)
    } else if (entry.isFile()) {
      out.push(relative)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. package.json 元信息
// ---------------------------------------------------------------------------

const pkg = readJson(path.join(ROOT, 'package.json'))

if (pkg.private !== true) {
  fail('package.json 的 "private" 必须保持 true（本仓库不公开发布到 npm）')
}
if (pkg.publishConfig !== undefined) {
  fail('package.json 不应包含 publishConfig（private 仓库不发布 npm）')
}
if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
  fail('package.json 缺少 name')
}
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
  fail(`package.json 的 version 非法：${String(pkg.version)}`)
}
const filesEntries = Array.isArray(pkg.files) ? pkg.files : []
if (filesEntries.length === 0) {
  fail('package.json 的 "files" 字段为空，发布包内容无法界定')
}

function normalizeEntry(entry) {
  return String(entry)
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

function underEntry(relative, entry) {
  return relative === entry || relative.startsWith(entry + '/')
}

// ---------------------------------------------------------------------------
// 2. 枚举发布包候选文件：git 受跟踪 ∩ files + dist 构建产物
// ---------------------------------------------------------------------------

const tracked = runGit(['ls-files', '-z'])
  .split('\0')
  .filter(function (item) {
    return item.length > 0
  })

const entries = filesEntries.map(normalizeEntry).filter(Boolean)
const candidates = new Set()

for (const relative of tracked) {
  if (entries.some((entry) => underEntry(relative, entry))) {
    candidates.add(relative)
  }
}

// npm 打包会自动附带 package.json、README、LICENSE（即使不在 files 里），
// 因此把它们也纳入发布包口径一起检查。
const AUTO_INCLUDED = ['package.json', 'LICENSE', 'LICENCE', 'README.md']
for (const relative of AUTO_INCLUDED) {
  if (tracked.includes(relative)) candidates.add(relative)
}

// dist 由 npm run build 生成、不进 git；发布包必须带构建产物
const distAbsolute = path.join(ROOT, 'dist')
if (!existsSync(distAbsolute)) {
  fail('dist/ 不存在：发布包不完整（先执行 npm run build）')
} else if (walk('dist').length === 0) {
  fail('dist/ 为空：发布包不完整（先执行 npm run build）')
} else {
  for (const relative of walk('dist')) {
    candidates.add(relative)
  }
}

if (pkg.main) {
  const mainRelative = String(pkg.main).replace(/^\.\//, '')
  if (!candidates.has(mainRelative)) {
    fail(`package.json main 指向 ${pkg.main}，但发布包中不存在（是否漏了 dist？）`)
  }
}
if (pkg.types) {
  const typesRelative = String(pkg.types).replace(/^\.\//, '')
  if (!candidates.has(typesRelative)) {
    fail(`package.json types 指向 ${pkg.types}，但发布包中不存在`)
  }
}

// ---------------------------------------------------------------------------
// 3. 路径黑名单
// ---------------------------------------------------------------------------

const FORBIDDEN_DIR_SEGMENTS = new Set([
  '.git',
  '.github',
  '.dsh-tmp',
  'node_modules',
  'backups',
  'dev-notes',
  '__pycache__',
  'coverage',
  '.vscode',
  '.idea',
  'test',
  'dev-notes',
])

const FORBIDDEN_EXTENSIONS = new Set([
  '.log',
  '.bak',
  '.tmp',
  '.pyc',
  '.zip',
  '.7z',
  '.rar',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.tsbuildinfo',
  '.sent.json',
])

const FORBIDDEN_BASENAMES = new Set([
  'state.json',
  'audit.jsonl',
  'audit.1.jsonl',
  'alerts.jsonl',
  'drafts.jsonl',
  'outbox.jsonl',
  'inbound.jsonl',
  'deferred-inbound.json',
  'desktop-ack.json',
  'api-token',
  'uia-state.json',
  'list-preview.json',
  '.env',
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const IMAGE_ALLOWED_DIRS = ['stickers/', 'personas/', 'persona/']

function hasForbiddenSegment(relative) {
  const segments = relative.split('/').map((segment) => segment.toLowerCase())
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (FORBIDDEN_DIR_SEGMENTS.has(segments[index])) return segments[index]
  }
  return ''
}

for (const relative of candidates) {
  const base = path.posix.basename(relative).toLowerCase()
  const extension = path.posix.extname(relative).toLowerCase()
  const segment = hasForbiddenSegment(relative)
  if (segment) {
    fail(`发布包包含禁止目录 ${segment}/：${relative}`)
    continue
  }
  if (extension === '.bak' || /\.bak-\d{8}/.test(base) || /\.bak-/.test(base)) {
    fail(`发布包包含备份文件：${relative}`)
    continue
  }
  if (FORBIDDEN_EXTENSIONS.has(extension)) {
    fail(`发布包包含禁止的临时/导出文件类型 ${extension}：${relative}`)
    continue
  }
  if (FORBIDDEN_BASENAMES.has(base)) {
    fail(`发布包包含运行时数据/敏感文件：${relative}`)
    continue
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    const allowed = IMAGE_ALLOWED_DIRS.some((prefix) => relative.startsWith(prefix))
    if (!allowed) {
      fail(`发布包包含截图/图片（只允许 stickers/、personas/、persona/、icon.svg）：${relative}`)
    }
  }
}

// 本机被忽略的调试垃圾不进发布包，但打包前应清理（仅警告）
let ignoredJunk = []
try {
  ignoredJunk = runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter((relative) => entries.some((entry) => underEntry(relative, entry)))
    .filter((relative) => !relative.startsWith('node_modules/'))
    .filter((relative) => {
      const base = path.posix.basename(relative).toLowerCase()
      return (
        /\.bak(-\d+)?$/.test(base) ||
        base.endsWith('.log') ||
        base.endsWith('.pyc') ||
        base.endsWith('.zip') ||
        /\.bak-/.test(base) ||
        relative.includes('__pycache__/')
      )
    })
} catch {
  // 忽略 git 版本不支持 --ignored 的情况；不影响主检查
}
if (ignoredJunk.length > 0) {
  warn(
    `发现 ${ignoredJunk.length} 个本地忽略垃圾（不会进入 git 发布包；但**用 npm pack 直接从开发目录打包会带进去**，打包前建议清理或按 RELEASE-CHECKLIST §6.4 用 git 受跟踪文件建包）：` +
      ignoredJunk.slice(0, 8).join('、') +
      (ignoredJunk.length > 8 ? ' 等' : ''),
  )
}

// ---------------------------------------------------------------------------
// 4. 敏感串扫描
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.jsonl',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.yml',
  '.yaml',
  '.ps1',
  '.py',
  '.html',
  '.css',
  '.svg',
  '.csv',
  '.toml',
  '.ini',
  '.patch',
])

const PHONE_ALLOW = new Set([
  '13800000000',
  '13800001111',
  '13800138000',
  '13900000000',
  '18800000000',
  '18888888888',
])

const EMAIL_DOMAIN_ALLOW = new Set([
  'example.com',
  'example.org',
  'example.net',
  'users.noreply.github.com',
  'github.com',
  'githubusercontent.com',
])

// 与 scripts/check-sensitive.mjs 的 WXID_ALLOW 对齐（虚构 wxid 后缀）
const WXID_ALLOW = new Set([
  'a',
  'b',
  'c',
  'x',
  'y',
  'z',
  'demo',
  'foo',
  'bar',
  'test',
  'tester',
  'sample',
  'mock',
  'fake',
  'user',
  'unknown',
  'stranger',
  'placeholder',
  'redacted',
  'masked',
  'alice',
  'bob',
  'carol',
  'dave',
  'eve',
  'zhangsan',
  'lisi',
  'wangwu',
])

const SECRET_PATTERNS = [
  { name: '密钥/Token（sk-）', pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: '密钥/Token（ghp_）', pattern: /ghp_[A-Za-z0-9]{20,}/g },
  { name: '密钥/Token（github_pat_）', pattern: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: '密钥/Token（AKIA）', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: '密钥/Token（Slack）', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: '私钥文件内容', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'JWT', pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
]

const ABSOLUTE_PATH_PATTERNS = [
  // Windows 用户目录绝对路径；允许 <用户名> 之类的占位符
  /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/](?![<［【\uFF1C])[^\s"'`]+/g,
  // 本机临时目录中的私有机密路径
  /[A-Za-z]:[\\/][^\s"'`]*AppData[\\/]Local[\\/]Temp[\\/][^\s"'`]+/g,
  // POSIX 用户目录绝对路径；允许 <用户名> 占位
  /(?:\/home\/|\/Users\/)(?![<［【\uFF1C])[A-Za-z0-9._-]+/g,
]

function isTextCandidate(relative) {
  const extension = path.posix.extname(relative).toLowerCase()
  return TEXT_EXTENSIONS.has(extension) || relative.endsWith('.d.ts')
}

function scanText(relative) {
  const absolute = path.join(ROOT, relative)
  let stat
  try {
    stat = statSync(absolute)
  } catch (error) {
    warn(`无法读取 ${relative}：${error.message}`)
    return
  }
  if (stat.size > 2 * 1024 * 1024) {
    warn(`跳过超大文本文件（>2MB）：${relative}`)
    return
  }
  let buffer
  try {
    buffer = readFileSync(absolute)
  } catch (error) {
    warn(`无法读取 ${relative}：${error.message}`)
    return
  }
  if (buffer.includes(0)) {
    warn(`跳过含二进制内容（NUL）的文本文件：${relative}`)
    return
  }
  const lines = buffer.toString('utf8').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1
    const where = `${relative}:${lineNumber}`

    for (const rule of ABSOLUTE_PATH_PATTERNS) {
      rule.lastIndex = 0
      let match
      while ((match = rule.exec(line)) !== null) {
        fail(`[本机绝对路径] ${where} → ${mask(match[0])}`)
      }
    }

    let phoneMatch
    const phoneRule = /(?<![0-9])1[3-9]\d{9}(?![0-9])/g
    while ((phoneMatch = phoneRule.exec(line)) !== null) {
      if (!PHONE_ALLOW.has(phoneMatch[0])) {
        fail(`[手机号] ${where} → ${mask(phoneMatch[0])}`)
      }
    }

    let emailMatch
    const emailRule = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
    while ((emailMatch = emailRule.exec(line)) !== null) {
      const email = emailMatch[0]
      const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
      if (!EMAIL_DOMAIN_ALLOW.has(domain)) {
        fail(`[真实邮箱] ${where} → ${mask(email)}`)
      }
    }

    let wxidMatch
    // 与 check-sensitive.mjs 对齐：只匹配小写 wxid_ 前缀，避免把 WXID_ALLOW 之类常量误报
    const wxidRule = /\bwxid_([A-Za-z0-9_]+)/gu
    while ((wxidMatch = wxidRule.exec(line)) !== null) {
      const suffix = wxidMatch[1].toLowerCase()
      if (!WXID_ALLOW.has(suffix)) {
        fail(`[明文 wxid] ${where} → ${mask(wxidMatch[0])}`)
      }
    }

    for (const rule of SECRET_PATTERNS) {
      rule.pattern.lastIndex = 0
      let match
      while ((match = rule.pattern.exec(line)) !== null) {
        fail(`[${rule.name}] ${where} → ${mask(match[0])}`)
      }
    }
  }
}

for (const relative of candidates) {
  if (isTextCandidate(relative)) scanText(relative)
}

// ---------------------------------------------------------------------------
// 5. 输出清单与结论
// ---------------------------------------------------------------------------

const sortedCandidates = Array.from(candidates).sort()
const groups = new Map()
for (const relative of sortedCandidates) {
  const top = relative.includes('/') ? relative.split('/')[0] + '/' : '(根目录)'
  if (!groups.has(top)) groups.set(top, [])
  groups.get(top).push(relative)
}

console.log('[check-package] 发布包内容检查（private=true，本仓库不公开发布）')
console.log(`  包：${pkg.name}@${pkg.version}  private=${String(pkg.private)}`)
console.log(`  口径：git 受跟踪文件 ∩ package.json files + dist 构建产物`)
console.log(`  候选文件：${sortedCandidates.length} 个`)
console.log('  按目录：')
for (const top of Array.from(groups.keys()).sort()) {
  console.log(`    ${top}  ${groups.get(top).length} 个`)
}
console.log('  文件清单：')
for (const top of Array.from(groups.keys()).sort()) {
  console.log(`    [${top}]`)
  for (const relative of groups.get(top)) {
    console.log(`      ${relative}`)
  }
}

if (warnings.length > 0) {
  console.log(`\n[check-package] 警告（${warnings.length} 条，不阻断）：`)
  for (const message of warnings) console.log(`  ! ${message}`)
}

if (failures.length > 0) {
  console.log(`\n[check-package] 违规（${failures.length} 条，发布阻断）：`)
  for (const message of failures) console.log(`  ✗ ${message}`)
  console.log('\n[check-package] 结论：不通过。发布包内存在垃圾数据/私密信息，禁止发布。')
  process.exit(1)
}

console.log('\n[check-package] 结论：通过。发布包内容干净（private 仓库，不发布 npm）。')
process.exit(0)
