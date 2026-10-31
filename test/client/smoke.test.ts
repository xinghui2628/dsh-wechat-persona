/**
 * 浏览器端插件的加载冒烟测试（不依赖真实 DOM / React 渲染）。
 *
 * 验证的三件事：
 * 1. client.js 在 `window.__ModuleLoader__` 存在时能被加载，`factory(require)` 返回合法模块；
 * 2. `apply(ctx)` 不抛错，并注册 styles、locale 与两个设置槽（plugins.bundle.config / settings.section）；
 * 3. 两个槽的渲染函数遵守契约：bundle 的 summary 视图返回 null，其它视图返回可渲染元素。
 *
 * 说明：真实的 React hooks 渲染由 DSH GUI 在浏览器里完成；这里只用假的 React 与假 document，
 * 因此不需要新增任何依赖，也不需要 jsdom。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type AnyRecord = Record<string, any>

const INJECTED: string[] = []
const REGISTRATIONS: Array<{ spec: AnyRecord; render: (props?: AnyRecord) => any }> = []

let moduleExports: any = null
let styleNodes: AnyRecord[] = []
let styleAppends = 0

const fakeReact = {
  createElement(type: any, props: any, ...children: any[]) {
    const next: AnyRecord = Object.assign({}, props)
    if (children.length === 1) next.children = children[0]
    else if (children.length > 1) next.children = children
    return { type, props: next, key: props && props.key !== undefined ? props.key : undefined }
  },
  Fragment: 'Fragment',
  Component: class FakeComponent {
    props: any
    state: any
    constructor(props: any) {
      this.props = props
      this.state = {}
    }
    setState(patch: any) {
      this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch)
    }
  },
}

function makeFakeDocument() {
  styleNodes = []
  styleAppends = 0
  return {
    baseURI: 'http://127.0.0.1:51642/',
    head: {
      appendChild(node: AnyRecord) {
        styleAppends += 1
        styleNodes.push(node)
      },
    },
    body: { appendChild() {} },
    getElementById(id: string) {
      return styleNodes.find((node) => node.id === id) || null
    },
    createElement() {
      return {
        id: '',
        textContent: '',
        attributes: {} as AnyRecord,
        setAttribute(name: string, value: string) {
          this.attributes[name] = value
        },
        parentNode: null,
      }
    },
  }
}

beforeAll(async () => {
  ;(globalThis as any).document = makeFakeDocument()
  let loaded: any = null
  ;(globalThis as any).window = {
    __ModuleLoader__: {
      load(spec: any) {
        loaded = spec
        return { dispose() {} }
      },
    },
  }

  await import('../../client/client.js')

  expect(loaded).toBeTruthy()
  expect(loaded.id).toBe('dsh-wechat-persona')
  expect(typeof loaded.factory).toBe('function')

  moduleExports = loaded.factory((name: string) => {
    if (name === 'react') return fakeReact
    throw new Error('client.js 不应 require 其它模块：' + name)
  })
})

afterAll(() => {
  delete (globalThis as any).document
  delete (globalThis as any).window
})

describe('client.js 模块契约', () => {
  it('导出 name/inject（slots + locale）', () => {
    expect(moduleExports).toBeTruthy()
    expect(moduleExports.name).toBe('dsh-wechat-persona')
    expect(moduleExports.inject).toEqual(['slots', 'locale'])
    expect(typeof moduleExports.apply).toBe('function')
  })

  it('apply(ctx) 注册样式、文案与两个设置槽', () => {
    const registeredNamespaces: string[] = []
    const ctx = {
      effect(fn: () => any) {
        const result = fn()
        return typeof result === 'function' ? result : undefined
      },
      locale: {
        register(namespace: string) {
          registeredNamespaces.push(namespace)
        },
        bind() {
          return (key: string, fallback?: string) => (fallback === undefined ? key : fallback)
        },
      },
      slots: {
        inject(name: string, callback: () => any) {
          INJECTED.push(name)
          return callback()
        },
        register(spec: AnyRecord, render: (props?: AnyRecord) => any) {
          REGISTRATIONS.push({ spec, render })
          return () => {}
        },
      },
    }

    const dispose = moduleExports.apply(ctx)
    expect(typeof dispose).toBe('function')

    expect(styleAppends).toBe(1)
    expect(styleNodes[0].id).toBe('dsh-wechat-persona:style')
    expect(String(styleNodes[0].textContent)).toContain('.dwp-root')
    expect(registeredNamespaces).toEqual(['dsh-wechat-persona'])
    expect(INJECTED).toEqual(['plugins.bundle.config', 'settings.section'])
    expect(REGISTRATIONS).toHaveLength(2)

    const bundle = REGISTRATIONS[0].spec
    expect(bundle.name).toBe('plugins.bundle.config')
    expect(bundle.key).toBe('dsh-wechat-persona')

    const section = REGISTRATIONS[1].spec
    expect(section.name).toBe('settings.section')
    expect(section.id).toBe('dsh-wechat-persona')
    expect(section.order).toBe(45)
    expect(section.label()).toBe('微信分身')
    expect(section.locale).toBe('dsh-wechat-persona')
  })

  it('bundle summary 视图返回 null，page 视图返回元素；settings.section 返回元素', () => {
    const bundleHandler = REGISTRATIONS[0].render
    const settingsHandler = REGISTRATIONS[1].render

    expect(bundleHandler({ view: 'summary' })).toBeNull()
    expect(bundleHandler({ view: 'page' })).toBeTruthy()
    expect(bundleHandler({})).toBeTruthy()
    expect(settingsHandler({})).toBeTruthy()

    const element = settingsHandler({})
    // 顶层包了 ErrorBoundary：type 是 class，props.label 是中文标题，children 是 Panel 元素。
    expect(typeof element.type).toBe('function')
    expect(element.props.label).toBe('微信分身设置')
    expect(typeof element.props.children.type).toBe('function')
    expect(element.props.children.props.embedded).toBe(false)
    expect(typeof element.props.children.props.t).toBe('function')
  })

  it('缺少 slots 服务时 apply 不抛错（降级为只注入样式）', () => {
    const bareCtx = {
      effect(fn: () => any) {
        const result = fn()
        return typeof result === 'function' ? result : undefined
      },
    }
    expect(() => moduleExports.apply(bareCtx)).not.toThrow()
  })

  it('缺少 __ModuleLoader__ 时静默跳过（不抛错）', async () => {
    const saved = (globalThis as any).window
    delete (globalThis as any).window
    const url = new URL('../../client/client.js', import.meta.url)
    // 通过重新请求源码并执行，模拟 loader 不可用的环境；不依赖 Node 缓存。
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(url, 'utf8')
    const run = new Function('window', 'document', 'module', 'require', source)
    expect(() =>
      run(undefined, (globalThis as any).document, undefined, (name: string) => {
        throw new Error('不应 require：' + name)
      }),
    ).not.toThrow()
    ;(globalThis as any).window = saved
  })
})

describe('保存失败判定（Lead 硬要求：网络错误不算保存失败）', () => {
  const hooks = () => moduleExports.__test
  const failure = (message: string, patch: AnyRecord) => {
    const error = new (hooks().ApiError)(message, undefined, 400)
    Object.assign(error, patch)
    return error
  }

  it('明确 JSON 错误才返回失败文案', () => {
    expect(
      hooks().saveFailureText(failure('参数不合法', { parsedBody: true, payload: { ok: false, error: '参数不合法' } })),
    ).toBe('参数不合法')
    expect(hooks().saveFailureText(failure('人格不存在', { parsedBody: true, payload: { ok: false } }))).toBe('人格不存在')
  })

  it('插件重载导致的网络错误 / 超时 / 非 JSON 都视为已提交（返回 null）', () => {
    expect(hooks().saveFailureText(failure('connection reset', { network: true }))).toBeNull()
    expect(hooks().saveFailureText(failure('非 JSON 响应', { parsedBody: false }))).toBeNull()
    expect(hooks().saveFailureText(new Error('socket hang up'))).toBeNull()
    expect(hooks().saveFailureText(undefined)).toBeNull()
  })
})

describe('表情包图片地址判定', () => {
  it('外部 URL / data URL 直连，相对 API 路径走带请求头的 blob', () => {
    const { isExternalUrl } = moduleExports.__test
    expect(isExternalUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(isExternalUrl('https://example.com/a.png')).toBe(true)
    expect(isExternalUrl('dsh-wechat-persona/api/sticker-file?id=uploaded%3Ahappy%2Fa.png')).toBe(false)
    expect(isExternalUrl('')).toBe(false)
  })
})
