/**
 * 情绪识别：给“发表情包 / 语气”用的本地启发式分类，0 token。
 *
 * 只依赖关键词与标点，按规则顺序返回第一个命中的情绪；都没有则 neutral。
 * 注意：这是“拟人化”的辅助信号，不需要也不该精确——宁可粗一点，
 * 也不为一个表情包多调一次模型。
 */

import type { Emotion } from '../types.ts'

interface EmotionRule {
  emotion: Emotion
  keywords: string[]
}

/** 规则顺序即优先级：先判明显情绪，再判疑问，最后 neutral。 */
const EMOTION_RULES: EmotionRule[] = [
  { emotion: 'happy', keywords: ['哈哈', '笑死', '太好', '开心', '高兴', '好耶'] },
  { emotion: 'playful', keywords: ['玩笑', '逗', '整活', '嘿嘿', '皮一下', '搞怪'] },
  { emotion: 'shy', keywords: ['害羞', '不好意思', '脸红', '羞'] },
  { emotion: 'comfort', keywords: ['难过', '累', 'emo', '哭', '烦', '委屈', '郁闷'] },
  { emotion: 'curious', keywords: ['为什么', '怎么', '吗', '？', '?'] },
]

/** 识别文本情绪（不区分大小写）。 */
export function detectEmotion(text: string): Emotion {
  if (typeof text !== 'string') return 'neutral'
  const source = text.trim()
  if (source === '') return 'neutral'
  const lowerSource = source.toLowerCase()
  for (const rule of EMOTION_RULES) {
    for (const keyword of rule.keywords) {
      if (lowerSource.includes(keyword.toLowerCase())) return rule.emotion
    }
  }
  return 'neutral'
}
