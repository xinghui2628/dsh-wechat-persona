/**
 * 通道装配入口：按 config.activeChannel 创建对应实现。
 *
 * 所有通道都只依赖 ChannelDeps（clock / logger / store），因此引擎侧
 * 不关心底层是 mock 文件、adb、TCP 桥还是 Windows UIA。
 *
 * 取舍：切换通道不改变引擎、记忆与人格逻辑；通道只负责“搬运消息 + 风控信号”。
 */

import type { WechatPersonaConfig } from '../config.ts'
import type { Channel, Clock, FileStoreLike, Logger } from '../types.ts'
import { MockChannel } from './mock.ts'
import { PhoneAdbChannel } from './phone-adb.ts'
import { WindowsVmChannel } from './windows-vm.ts'
import { DesktopChannel } from './pc/desktop.ts'

export interface ChannelDeps {
  clock: Clock
  logger: Logger
  store: FileStoreLike
}

/**
 * 按配置创建通道。desktop 通道在禁用时依旧返回实例（start 只记日志 + error 状态），
 * 这样上层不需要 special-case。
 */
export async function createChannel(config: WechatPersonaConfig, deps: ChannelDeps): Promise<Channel> {
  const active = config.activeChannel
  switch (active) {
    case 'mock':
      return new MockChannel({ config, deps })
    case 'phone-adb':
      return new PhoneAdbChannel({ config, deps })
    case 'windows-vm':
      return new WindowsVmChannel({ config, deps })
    case 'desktop':
      return new DesktopChannel({ config, deps })
    default: {
      // config 由 schemastery 校验过，这里只是防御未知值（例如旧配置残留）。
      const unknown = active as unknown as string
      deps.logger.warn(`[channel] 未知 activeChannel=${unknown}，回退到 mock（不会碰真实微信）`)
      return new MockChannel({ config, deps })
    }
  }
}
