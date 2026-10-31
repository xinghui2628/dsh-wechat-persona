/**
 * esbuild 的进程内替身（仅供 DSH Windows 沙箱里跑 vitest 用）。
 *
 * 沙箱禁止 node 以管道 stdio spawn 子进程，而 Vite 的 TS 转换依赖 esbuild 的
 * 常驻子进程（esbuild.exe）。本替身用 Node 内置的 module.stripTypeScriptTypes
 * 做纯 JS 的类型擦除/转换，从而零 spawn 完成 .ts 转换。
 *
 * 覆盖范围：Vite dev/test 模式下的 transform/transformSync。
 * 不覆盖 build()（打包构建不在本沙箱内运行）。
 */
import { stripTypeScriptTypes } from 'node:module'

const TS_LOADERS = new Set(['ts', 'tsx', 'jsx'])
const JS_LOADERS = new Set(['js', 'jsx', 'mjs', 'cjs'])

function makeMap(sourcefile, original) {
  // Vite 固定 `JSON.parse(result.map)`，所以必须返回合法 sourcemap JSON。
  // 行号映射为空：仅影响报错行号展示，不影响执行。
  return JSON.stringify({
    version: 3,
    sources: [sourcefile],
    sourcesContent: [original],
    names: [],
    mappings: '',
  })
}

function strip(code, options = {}) {
  const loader = String(options.loader ?? '')
  const sourcefile = String(options.sourcefile ?? 'module.ts')
  if (!TS_LOADERS.has(loader) && !JS_LOADERS.has(loader)) {
    return { code, map: makeMap(sourcefile, String(code)), warnings: [] }
  }
  if (!TS_LOADERS.has(loader)) {
    // 纯 JS：交给 Node 原生执行，不做降级
    return { code, map: makeMap(sourcefile, String(code)), warnings: [] }
  }
  // 本项目源码全部使用“可擦除语法”（不用 enum/namespace/参数属性），
  // 因此 strip 模式即可；transform 模式需要 --experimental-transform-types，
  // 而该 flag 不允许出现在 NODE_OPTIONS 中。
  const stripped = stripTypeScriptTypes(code, { mode: 'strip', sourceUrl: sourcefile })
  return { code: stripped, map: makeMap(sourcefile, String(code)), warnings: [] }
}

export function transformSync(code, options = {}) {
  return strip(code, options)
}

export function transform(code, options = {}) {
  try {
    return Promise.resolve(strip(code, options))
  } catch (error) {
    return Promise.reject(error)
  }
}

export function build() {
  return Promise.reject(new Error('esbuild stub: build() 在沙箱中不可用'))
}

export function buildSync() {
  throw new Error('esbuild stub: buildSync() 在沙箱中不可用')
}

export function formatMessages(messages) {
  return Promise.resolve(messages.map((message) => JSON.stringify(message)))
}

export function formatMessagesSync(messages) {
  return messages.map((message) => JSON.stringify(message))
}

export const stop = () => undefined
export const version = '0.0.0-dsh-sandbox-stub'

export default {
  transform,
  transformSync,
  build,
  buildSync,
  formatMessages,
  formatMessagesSync,
  stop,
  version,
}
