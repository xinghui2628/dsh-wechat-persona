/**
 * 通用小工具：随机 id / 指纹 / 数值 clamp / 可取消 sleep。
 * 纯函数，方便测试。
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Clock } from '../types.ts'

export function randomId(prefix = 'id'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/** 稳定指纹（同一联系人 + 文本在短时间窗口内视为重复）。 */
export function fingerprint(contactId: string, ...parts: Array<string | number>): string {
  const hash = createHash('sha1')
  hash.update(contactId)
  for (const part of parts) hash.update('\u0000' + String(part))
  return hash.digest('hex').slice(0, 20)
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return chars.slice(0, maxChars).join('')
}

/** 系统时钟 + 真实 sleep（engine 默认使用；测试注入假时钟）。 */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, Math.max(0, ms))
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    }),
}

/** Math.random 包装（测试可替换为确定性序列）。 */
export const mathRandom = { next: (): number => Math.random() }
