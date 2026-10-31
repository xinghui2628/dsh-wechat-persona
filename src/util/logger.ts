/**
 * 最小日志器：按级别过滤，输出到 stderr（DSH host 日志 / 终端可见）。
 * 不依赖 ctx.logger，避免宿主实现差异；插件内部统一走 Logger 接口。
 */

import type { Logger } from '../types.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

export type LogSink = (line: string) => void

const defaultSink: LogSink = (line) => {
  // host 侧没有 window；直接写进程输出，避免依赖 ctx.logger 的生命周期。
  process.stderr.write(line + '\n')
}

export function createLogger(level: LogLevel = 'info', sink: LogSink = defaultSink): Logger {
  const threshold = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info
  const write = (weight: number, tag: string, message: string, extra?: unknown): void => {
    if (weight < threshold) return
    let suffix = ''
    if (extra !== undefined) {
      try {
        suffix = ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))
      } catch {
        suffix = ' [unserializable]'
      }
    }
    sink(`[dsh-wechat-persona][${tag}] ${message}${suffix}`)
  }
  return {
    debug: (m, e) => write(LEVEL_WEIGHT.debug, 'debug', m, e),
    info: (m, e) => write(LEVEL_WEIGHT.info, 'info', m, e),
    warn: (m, e) => write(LEVEL_WEIGHT.warn, 'warn', m, e),
    error: (m, e) => write(LEVEL_WEIGHT.error, 'error', m, e),
  }
}
