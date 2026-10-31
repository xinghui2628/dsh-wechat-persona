import { describe, expect, it } from 'vitest'
import { detectSearchIntent } from '../../src/core/search-intent.ts'
import { testConfig } from './fakes.ts'

const config = testConfig()

describe('detectSearchIntent 搜索意图', () => {
  it('weather：天气/下雨/气温/冷/热/穿什么', () => {
    expect(detectSearchIntent('明天天气怎么样', config)?.category).toBe('weather')
    expect(detectSearchIntent('会下雨吗', config)?.category).toBe('weather')
    expect(detectSearchIntent('今天好冷', config)?.category).toBe('weather')
    expect(detectSearchIntent('出门穿什么好', config)?.category).toBe('weather')
  })

  it('news：新闻/热搜/头条/最近发生', () => {
    expect(detectSearchIntent('今天有什么新闻', config)?.category).toBe('news')
    expect(detectSearchIntent('微博热搜第一是啥', config)?.category).toBe('news')
    expect(detectSearchIntent('最近发生什么了', config)?.category).toBe('news')
  })

  it('meme：梗/什么梗/网络用语/什么意思', () => {
    expect(detectSearchIntent('这个梗什么意思', config)?.category).toBe('meme')
    expect(detectSearchIntent('什么梗啊', config)?.category).toBe('meme')
    expect(detectSearchIntent('这是网络用语吗', config)?.category).toBe('meme')
  })

  it('location：在哪/地址/怎么走/附近/推荐/店', () => {
    expect(detectSearchIntent('你在哪', config)?.category).toBe('location')
    expect(detectSearchIntent('这附近有什么好吃的店', config)?.category).toBe('location')
    expect(detectSearchIntent('把地址发我', config)?.category).toBe('location')
  })

  it('price：多少钱/价格/贵/汇率', () => {
    expect(detectSearchIntent('这个多少钱', config)?.category).toBe('price')
    expect(detectSearchIntent('现在汇率多少', config)?.category).toBe('price')
    expect(detectSearchIntent('有点贵', config)?.category).toBe('price')
  })

  it('config.search.extraKeywords -> other', () => {
    const custom = testConfig((value) => {
      value.search.extraKeywords = ['咖啡', '演唱会']
    })
    const intent = detectSearchIntent('想喝咖啡', custom)
    expect(intent?.category).toBe('other')
    expect(intent?.reason).toContain('咖啡')
  })

  it('query 用原文本并截断到 60 字', () => {
    const intent = detectSearchIntent('帮我查一下明天天气' + '啊'.repeat(100), config)
    expect(intent?.category).toBe('weather')
    expect([...(intent?.query ?? '')].length).toBe(60)
  })

  it('无命中返回 null', () => {
    expect(detectSearchIntent('你好呀', config)).toBeNull()
    expect(detectSearchIntent('', config)).toBeNull()
    expect(detectSearchIntent('   ', config)).toBeNull()
  })
})
