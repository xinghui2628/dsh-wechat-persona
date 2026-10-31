/**
 * DSH Windows 沙箱兼容预加载（仅用于在本机沙箱里跑 vitest）。
 *
 * 沙箱禁止 node 以“管道 stdio”方式 spawn 子进程（child_process.spawn/exec 默认
 * stdio:'pipe' => EPERM），这会让 Vite 启动失败：
 *   1) Vite 在 Windows 上第一次 realpath 时执行 `exec("net use")` 探测网络盘；
 *   2) Vite 用 esbuild 子进程（esbuild.exe）做 TS 转换；
 *   3) vitest 默认的 forks 线程池用 child_process.fork 起 worker。
 *
 * 对策（都不改变被测代码的行为）：
 *   - child_process.exec / execFile 换成“立即回调错误”的桩 => net-use 探测安静退化；
 *   - 用 module.registerHooks 把 `esbuild` 解析到进程内替身（esbuild-stub.mjs）；
 *   - 用 CLI 参数 --pool=threads 绕开 forks（见用法）。
 *
 * 用法（项目根）：
 *   $env:NODE_OPTIONS='--import ./test/core/sandbox-preload.mjs'
 *   npx vitest run --pool=threads test/core
 */
import cp from 'node:child_process'
import { registerHooks, syncBuiltinESMExports } from 'node:module'

const fakeChild = () => ({
  on: () => undefined,
  once: () => undefined,
  off: () => undefined,
  kill: () => undefined,
  unref: () => undefined,
  pid: -1,
})

const makeBlocked = (name) =>
  function blockedExec(...args) {
    const callback = [...args].reverse().find((arg) => typeof arg === 'function')
    if (callback) {
      queueMicrotask(() => {
        const error = new Error(`sandbox-blocked: ${name}`)
        error.code = 'EPERM'
        callback(error, '', '')
      })
    }
    return fakeChild()
  }

cp.exec = makeBlocked('exec')
cp.execFile = makeBlocked('execFile')
syncBuiltinESMExports()

const esbuildStubUrl = new URL('./esbuild-stub.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'esbuild') {
      return { url: esbuildStubUrl, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
