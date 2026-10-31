/**
 * 用户通知器（Notifier）。
 *
 * 风控熔断、敏感话题、通道异常等需要“立即告知用户”的场景走这里：
 * 1. 永远写 `<dataDir>/alerts.jsonl`（本地审计可查，重启后仍能看到）；
 * 2. 永远写 stderr（DSH 宿主/终端可见）；
 * 3. 尽力弹一个 Windows 通知（PowerShell toast / msg 兜底）。弹窗属于“锦上添花”，
 *    任何失败都吞掉，绝不反过来影响暂停流程——风控触发时通知失败也必须保持暂停。
 *
 * 注意：宿主沙箱下 pipe 型 spawn 可能 EPERM，所以这里一律 `stdio: 'ignore'`，
 * 不读取子进程输出；并且给 toast 设超时与最小间隔，避免刷屏。
 */
import { spawn } from 'node:child_process'
import { platform } from 'node:process'
import type { FileStoreLike, Logger, Notifier } from '../types.ts'

export interface NotifierOptions {
  store: FileStoreLike
  logger: Logger
  /** 是否尝试弹 Windows 桌面通知，默认 true；测试与无桌面环境可关。 */
  toast?: boolean
  /** toast 最小间隔（毫秒），避免风控恢复/复发时刷爆通知中心。 */
  toastMinIntervalMs?: number
  /** 注入 now（毫秒），便于测试；默认 Date.now。 */
  now?: () => number
  /** 注入 spawn，便于测试；默认 node:child_process.spawn。 */
  spawnImpl?: typeof spawn
}

/** 最多保留的 toast 命令长度，防止 PowerShell 命令行被消息正文撑爆。 */
const MAX_TOAST_TEXT = 180
/** toast 命令超时，超时直接 kill（不等待结果）。 */
const TOAST_TIMEOUT_MS = 8_000
/** alerts.jsonl 单条最大长度。 */
const MAX_ALERT_LINE = 1_200

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 生成 PowerShell toast 命令（Windows 10/11 自带 WinRT，无需额外模块）。 */
function buildToastScript(title: string, body: string): string {
  const safe = (value: string): string => value.replace(/[`'"]/g, ' ').replace(/[\r\n]+/g, ' ')
  const t = safe(oneLine(title, 80))
  const b = safe(oneLine(body, MAX_TOAST_TEXT))
  return [
    '$ErrorActionPreference="SilentlyContinue"',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    `$tpl.GetElementsByTagName("text").Item(0).AppendChild($tpl.CreateTextNode('${t}')) > $null`,
    `$tpl.GetElementsByTagName("text").Item(1).AppendChild($tpl.CreateTextNode('${b}')) > $null`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DSH WeChat Persona').Show($toast)`,
  ].join('; ')
}

export function createNotifier(options: NotifierOptions): Notifier {
  const { store, logger } = options
  const toastEnabled = options.toast ?? true
  const minInterval = options.toastMinIntervalMs ?? 60_000
  const now = options.now ?? Date.now
  const spawnImpl = options.spawnImpl ?? spawn
  let lastToastAt = 0

  const writeAlert = async (level: string, title: string, body: string): Promise<void> => {
    const line = JSON.stringify({ ts: now(), level, title: oneLine(title, 200), body: oneLine(body, MAX_ALERT_LINE) })
    try {
      await store.append('alerts.jsonl', `${line}\n`)
    } catch (error) {
      logger.warn('alerts.jsonl 写入失败', error instanceof Error ? error.message : String(error))
    }
  }

  const tryToast = (title: string, body: string): void => {
    if (!toastEnabled || platform !== 'win32') return
    const nowMs = now()
    if (nowMs - lastToastAt < minInterval) return
    lastToastAt = nowMs
    try {
      const script = buildToastScript(title, body)
      const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      })
      child.on?.('error', () => undefined)
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // 忽略：超时清理失败无碍主流程
        }
      }, TOAST_TIMEOUT_MS)
      timer.unref?.()
      child.on?.('exit', () => clearTimeout(timer))
      child.unref?.()
    } catch (error) {
      logger.debug('toast 通知不可用', error instanceof Error ? error.message : String(error))
    }
  }

  return {
    async notify(level, title, body): Promise<void> {
      const levelName = level === 'critical' ? 'critical' : level === 'warn' ? 'warn' : 'info'
      if (levelName === 'critical') {
        logger.error(`[通知/${levelName}] ${title} — ${body}`)
      } else if (levelName === 'warn') {
        logger.warn(`[通知/${levelName}] ${title} — ${body}`)
      } else {
        logger.info(`[通知/${levelName}] ${title} — ${body}`)
      }
      await writeAlert(levelName, title, body)
      if (levelName !== 'info') tryToast(title, body)
    },
  }
}
