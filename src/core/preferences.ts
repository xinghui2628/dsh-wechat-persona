/**
 * 联系人偏好的轻量提取（0 token）。
 *
 * 从入站消息里用保守的中文规则抽取：
 * - 称呼：告诉我该叫他什么（“叫我老王”“喊我阿杰”）；
 * - 忌口/雷区：“不吃辣”“受不了烟味”“过敏”；
 * - 最近话题：“最近在准备考试”“我最近在看剧”。
 *
 * 只做“有把握才记”的提取，宁缺毋滥；真正的理解交给每 50 条的长期摘要。
 * 提取结果合并进 MemoryRecord.profile，并作为提示词里的一小段背景信息。
 */

import type { MemoryProfile } from '../types.ts'

const NICKNAME_PATTERNS: readonly RegExp[] = [
  /(?:以后|就|可以)?(?:叫我|喊我|称呼我)\s*[「“"']?([^\s，。！？,.!?、；;：:「」“”"'（）()]{1,8})/,
]

const TABOO_PATTERNS: readonly RegExp[] = [
  /(?:不吃|忌口|受不了|讨厌|烦死|过敏)(?:吃|闻|的|了|是)?\s*[「“"']?([^\s，。！？,.!?、；;：:「」“”"'（）()]{1,10})/g,
]

const TOPIC_PATTERNS: readonly RegExp[] = [
  /(?:最近在|我最近在|我最近)\s*([^\s，。！？,.!?、；;：:「」“”"'（）()]{2,14})/g,
]

const NICKNAME_TRAILING = /(?:就行|就好|可以|好了|啦|呗|吧|呀|啊|哦|呢|嘛|哈|了)$/u

const MAX_TABOOS = 3
const MAX_TOPICS = 5

/** 清洗提取到的短语：去首尾标点/空白，过滤明显无意义的片段。 */
function clean(fragment: string): string {
  return fragment
    .replace(/^[\s，。！？、；：,.!?:;'"“”‘’「」（）()]+/, '')
    .replace(/[\s，。！？、；：,.!?:;'"“”‘’「」（）()]+$/, '')
    .trim()
}

function isMeaningful(fragment: string): boolean {
  if (fragment.length < 1 || fragment.length > 14) return false
  if (/^(你|我|他|她|它|这|那|什么|怎么|为什么|吗|呢|吧|了|的|地|得|啊|哦|嗯)$/.test(fragment)) return false
  return true
}

/** 昵称清洗：去掉“吧/就行/就好”等口语尾巴，避免把“老王吧”当称呼。 */
function cleanNickname(fragment: string): string {
  let value = clean(fragment)
  for (let round = 0; round < 3; round += 1) {
    const next = value.replace(NICKNAME_TRAILING, '')
    if (next === value) break
    value = next
  }
  return value.trim()
}

/** 提取单条消息里的偏好片段（可能为空对象）。 */
export function extractPreferences(text: string): Partial<MemoryProfile> {
  const result: Partial<MemoryProfile> = {}
  const content = typeof text === 'string' ? text.trim() : ''
  if (content === '') return result

  for (const pattern of NICKNAME_PATTERNS) {
    const match = pattern.exec(content)
    const nickname = match?.[1] ? cleanNickname(match[1]) : ''
    if (nickname !== '' && isMeaningful(nickname)) {
      result.nickname = nickname
      break
    }
  }

  const taboos: string[] = []
  for (const pattern of TABOO_PATTERNS) {
    pattern.lastIndex = 0
    let match = pattern.exec(content)
    while (match !== null && taboos.length < MAX_TABOOS) {
      const value = match[1] ? clean(match[1]) : ''
      if (value !== '' && isMeaningful(value) && !taboos.includes(value)) taboos.push(value)
      match = pattern.exec(content)
    }
  }
  if (taboos.length > 0) result.taboos = taboos

  const topics: string[] = []
  for (const pattern of TOPIC_PATTERNS) {
    pattern.lastIndex = 0
    let match = pattern.exec(content)
    while (match !== null && topics.length < MAX_TOPICS) {
      const value = match[1] ? clean(match[1]) : ''
      if (value !== '' && isMeaningful(value) && !topics.includes(value)) topics.push(value)
      match = pattern.exec(content)
    }
  }
  if (topics.length > 0) result.topics = topics
  return result
}

/**
 * 合并偏好：新提取的片段覆盖/追加到已有记录。
 *
 * - nickname：新值非空则覆盖；
 * - taboos：追加并去重，保留最近 MAX_TABOOS 个；
 * - topics：追加并去重，保留最近 MAX_TOPICS 个（新的在后）。
 */
export function mergePreferences(
  current: MemoryProfile | undefined,
  patch: Partial<MemoryProfile>,
  now: number,
): MemoryProfile {
  const base: MemoryProfile = current ?? { nickname: '', taboos: [], topics: [], updatedAt: now }
  const nickname = typeof patch.nickname === 'string' && patch.nickname.trim() !== '' ? patch.nickname.trim() : base.nickname
  const taboos = unique([...base.taboos, ...(patch.taboos ?? [])]).slice(-MAX_TABOOS)
  const topics = unique([...base.topics, ...(patch.topics ?? [])]).slice(-MAX_TOPICS)
  return { nickname, taboos, topics, updatedAt: now }
}

/** 判断偏好是否为空（空则提示词里不展示）。 */
export function isEmptyProfile(profile: MemoryProfile | undefined): boolean {
  if (!profile) return true
  return profile.nickname.trim() === '' && profile.taboos.length === 0 && profile.topics.length === 0
}

/** 把偏好渲染成提示词里的一行背景（0 token 规则文本）。 */
export function formatProfile(profile: MemoryProfile | undefined): string {
  if (!profile || isEmptyProfile(profile)) return ''
  const parts: string[] = []
  if (profile.nickname.trim() !== '') parts.push(`他希望你叫他「${profile.nickname.trim()}」`)
  if (profile.taboos.length > 0) parts.push(`忌口/雷区：${profile.taboos.join('、')}`)
  if (profile.topics.length > 0) parts.push(`最近聊到：${profile.topics.join('、')}`)
  return parts.join('；')
}

function unique(values: readonly string[]): string[] {
  const out: string[] = []
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}
