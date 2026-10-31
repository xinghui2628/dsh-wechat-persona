/**
 * 按需搜索意图识别：只有用户真的问到“需要外部实时信息”的问题才联网。
 *
 * 纯本地 0 token；命中后由 engine 决定是否真的去搜索（config.search.enabled、
 * 每日上限、search 依赖是否存在都不在这里判断——保持本模块纯识别）。
 */

import type { SearchCategory, SearchIntent } from '../types.ts'
import type { WechatPersonaConfig } from '../config.ts'

interface IntentRule {
  category: SearchCategory
  keywords: string[]
}

/** query 截断上限（搜索词太长会浪费 token 且效果差）。 */
const QUERY_MAX_CHARS = 60

/**
 * 内置规则：组顺序即命中优先级。
 * news 放在 weather 前面：「微博热搜」不能被 weather 的裸词「热」抢走。
 * 关键词故意保持“口语短词”，宁可多触发一次搜索，也别漏掉明显该查的问题。
 */
const INTENT_RULES: IntentRule[] = [
  {
    category: 'news',
    keywords: ['新闻', '热搜', '头条', '最近发生', '发生什么事', '大事'],
  },
  {
    category: 'weather',
    keywords: ['天气', '下雨', '气温', '穿什么', '冷不冷', '热不热', '降温', '台风', '冷', '热'],
  },
  {
    category: 'meme',
    keywords: ['什么梗', '梗图', '梗', '网络用语', '什么意思'],
  },
  {
    category: 'location',
    keywords: ['在哪', '地址', '怎么走', '附近', '推荐', '店'],
  },
  {
    category: 'price',
    keywords: ['多少钱', '价格', '汇率', '贵', '便宜', '几块'],
  },
]

/** 按 code point 截断（中文/emoji 都按“字”算，避免半个字符）。 */
function clampQuery(text: string): string {
  const chars = [...text]
  return chars.length <= QUERY_MAX_CHARS ? text : chars.slice(0, QUERY_MAX_CHARS).join('')
}

/**
 * 识别搜索意图。
 *
 * - 命中内置五类之一，返回 {category, query, reason}；
 * - 命中 config.search.extraKeywords（用户自定义），返回 category='other'；
 * - 未命中返回 null。
 * query 优先用原文本（trim 后截断到 60 字）。
 */
export function detectSearchIntent(text: string, config: WechatPersonaConfig): SearchIntent | null {
  if (typeof text !== 'string') return null
  const source = text.trim()
  if (source === '') return null
  const query = clampQuery(source)

  for (const rule of INTENT_RULES) {
    for (const keyword of rule.keywords) {
      if (source.includes(keyword)) {
        return { category: rule.category, query, reason: `命中关键词「${keyword}」` }
      }
    }
  }

  const extraKeywords = Array.isArray(config?.search?.extraKeywords) ? config.search.extraKeywords : []
  for (const keyword of extraKeywords) {
    if (typeof keyword !== 'string') continue
    const trimmed = keyword.trim()
    if (trimmed === '') continue
    if (source.includes(trimmed)) {
      return { category: 'other', query, reason: `命中自定义关键词「${trimmed}」` }
    }
  }
  return null
}
