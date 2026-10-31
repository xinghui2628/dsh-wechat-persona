/**
 * 宿主服务安全读取工具。
 *
 * 为什么需要它：
 * - Cordis 的 `inject` 只有两种合法形式：`string[]` 或 `{ 服务名?: 拦截配置 }`；
 *   写 `{ required: [...], optional: [...] }` 会被当成两个叫 required/optional 的服务，
 *   导致插件永远 pending。本插件选择「不声明 inject」，改为运行时按需读取服务，
 *   读不到就降级（更符合“插件异常不影响 DSH 主进程”的要求）。
 * - 未声明的服务直接用 `ctx.xxx` 属性访问可能抛错，因此统一走本函数：
 *   先 try 属性读取，再 try `ctx.get(name)`，都失败返回 undefined。
 */

export interface ServiceHost {
  get?: (name: string) => unknown
  [key: string]: unknown
}

export function readService<T>(ctx: ServiceHost, name: string): T | undefined {
  try {
    const direct = ctx[name]
    if (direct !== undefined && direct !== null) return direct as T
  } catch {
    // 未注入时 cordis 上下文代理可能抛错，继续尝试 ctx.get
  }
  try {
    const viaGet = ctx.get?.(name)
    if (viaGet !== undefined && viaGet !== null) return viaGet as T
  } catch {
    // 无此服务
  }
  return undefined
}
