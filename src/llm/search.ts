/**
 * 联网搜索客户端：包装宿主 ctx.web.search。
 * 只依赖结构化接口，测试用假实现；失败由引擎降级（不抛给用户）。
 */

import type { SearchLike, SearchResult, SearchSource } from '../types.ts'

export interface HostWebSearchRequest {
  query: string
  maxResults?: number
}

export interface HostWebSearchResponse {
  content?: string
  sources?: Array<{ url?: string; title?: string; snippet?: string }>
  truncated?: boolean
}

export interface HostWeb {
  search(request: HostWebSearchRequest, signal?: AbortSignal): Promise<HostWebSearchResponse>
}

export class HostSearch implements SearchLike {
  private readonly web: HostWeb
  private readonly maxResults: number

  constructor(web: HostWeb, maxResults = 3) {
    this.web = web
    this.maxResults = Math.max(1, Math.min(10, maxResults))
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult> {
    const raw = await this.web.search({ query, maxResults: this.maxResults }, signal)
    const sources: SearchSource[] = []
    for (const item of raw.sources ?? []) {
      if (!item.url) continue
      sources.push({ url: item.url, title: item.title, snippet: item.snippet })
    }
    return {
      content: raw.content,
      sources: sources.slice(0, this.maxResults),
      truncated: raw.truncated,
    }
  }
}
