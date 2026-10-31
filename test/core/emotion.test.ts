import { describe, expect, it } from 'vitest'
import { detectEmotion } from '../../src/core/emotion.ts'

describe('detectEmotion 情绪识别', () => {
  it('happy：哈哈/笑死/太好', () => {
    expect(detectEmotion('哈哈哈笑死我了')).toBe('happy')
    expect(detectEmotion('太好了')).toBe('happy')
  })

  it('playful：玩笑/逗/整活/嘿嘿', () => {
    expect(detectEmotion('开个玩笑啦')).toBe('playful')
    expect(detectEmotion('嘿嘿')).toBe('playful')
  })

  it('shy：害羞/不好意思/脸红', () => {
    expect(detectEmotion('有点不好意思')).toBe('shy')
    expect(detectEmotion('害羞了')).toBe('shy')
  })

  it('comfort：难过/累/emo/哭/烦', () => {
    expect(detectEmotion('今天好累啊')).toBe('comfort')
    expect(detectEmotion('有点emo')).toBe('comfort')
    expect(detectEmotion('好难过')).toBe('comfort')
  })

  it('curious：为什么/吗/？/怎么', () => {
    expect(detectEmotion('为什么呢')).toBe('curious')
    expect(detectEmotion('真的吗')).toBe('curious')
    expect(detectEmotion('怎么办')).toBe('curious')
    expect(detectEmotion('？')).toBe('curious')
  })

  it('neutral：无信号', () => {
    expect(detectEmotion('今天吃了饭')).toBe('neutral')
    expect(detectEmotion('')).toBe('neutral')
  })
})
