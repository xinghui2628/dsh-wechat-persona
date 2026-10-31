/**
 * 多引擎 OCR 投票：同一帧被多个引擎识别后，选出更可信的一份。
 *
 * CCG 五要素：
 * - 目标：把 v0.2.8 desktop.ts 里的双引擎投票逻辑抽成可单测的纯函数。
 * - 场景：Windows OCR 与 RapidOCR 对同一张截图识别同一行文字，两份文本长度/噪声不同。
 * - 方法：先算归一化后的字符重合度；低于阈值视为两路内容无关，保留主引擎结果；
 *   再比较完整度与噪声分，倾向「更完整且噪声更低」的一份。
 * - 输入：winText（系统 OCR）、engineText（第二引擎）。
 * - 输出：选中的文本（两者都空返回空串；任何一路为空返回另一路）。
 *
 * 注意：阈值与规则必须与 v0.2.8 行为一致（重合度 <0.35 直接信任系统 OCR），
 * 这样 A/B 对比才能把「融合策略」的变化单独归因。
 */

import { noiseScore } from './correction.ts'
import { textOverlapRatio } from './normalize.ts'

export interface EngineVoteOptions {
  /** 两路文本的最小重合度阈值；低于它视为无关内容，保留主引擎结果。 */
  minOverlap?: number
  /** 第二引擎比系统 OCR 更长多少字以上时直接采用（v0.2.8 为 +1）。 */
  lengthGain?: number
  /** 噪声分低多少以上才替换（v0.2.8 为 0.5）。 */
  noiseGain?: number
}

const DEFAULT_MIN_OVERLAP = 0.35
const DEFAULT_LENGTH_GAIN = 1
const DEFAULT_NOISE_GAIN = 0.5

/** 双引擎投票：系统 OCR 与第二引擎（RapidOCR）文本重合度高时，取更完整/噪声更低的一份。 */
export function mergeEngineVote(
  winText: string,
  engineText: string,
  options: EngineVoteOptions = {},
): string {
  const win = String(winText || '').trim()
  const eng = String(engineText || '').trim()
  if (!eng) return win
  if (!win) return eng
  const minOverlap = options.minOverlap ?? DEFAULT_MIN_OVERLAP
  if (textOverlapRatio(win, eng) < minOverlap) return win
  const sw = noiseScore(win)
  const se = noiseScore(eng)
  const lengthGain = options.lengthGain ?? DEFAULT_LENGTH_GAIN
  const noiseGain = options.noiseGain ?? DEFAULT_NOISE_GAIN
  if (eng.length > win.length + lengthGain) return eng
  if (eng.length >= win.length && se < sw - noiseGain) return eng
  return win
}
