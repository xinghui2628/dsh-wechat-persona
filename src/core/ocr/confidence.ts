import type { OcrAgreement } from './types.ts'

/**
 * 置信度评估输入（设计文档 6.5）。
 * 只接收真实可得的证据：没有原生 confidence 就传 undefined（不得编造/占位）。
 */
export interface ConfidenceInputs {
  /** 引擎原生置信度 0..1；Windows OCR 不提供 → undefined，不计分 */
  nativeConfidence?: number
  /** 行高（逻辑像素，来自 OCR 框） */
  boxHeight?: number
  /** 截图放大倍数（PS1 Get-WindowShot 的 scale，1-4） */
  scale?: number
  /** 参与识别的引擎数（1 或 2） */
  engineCount?: number
  /** 多引擎对同一行的文本一致程度（single=只有单引擎） */
  agreement?: OcrAgreement
  /** 几何匹配度 0..1（fusion.matchLines 的 score） */
  boxMatch?: number
  /** 跨行合并的原始行数（>1 表示发生了合并） */
  mergedLines?: number
  /** 是否疑似截断（长气泡被裁掉/合并边界不完整） */
  truncated?: boolean
  /** 是否使用了词典纠错 */
  correctionApplied?: boolean
  /** 联系人身份是否已确认；false 时一票否决 */
  contactVerified?: boolean
  /** 文本长度（极短文本更易误判，作为辅助说明） */
  textLength?: number
}

/** 单个质量因子（可解释：诊断中心/日志直接展示）。 */
export interface ConfidenceSignal {
  name: string
  /** 参与加权时的权重（>0） */
  weight: number
  /** 该项得分 0..1 */
  value: number
  /** 人类可读说明 */
  note: string
}

export interface ConfidenceEvaluation {
  /** 加权总分 0..1；没有可用因子时为 0（不臆断） */
  score: number
  /** 实际参与计分的因子（未提供的因子不出现在这里） */
  signals: ConfidenceSignal[]
  decision: 'accept' | 'verify' | 'reject'
  /** 面向诊断中心的中文解释 */
  explain: string
  /** 是否被硬性条件否决（联系人身份未确认） */
  vetoed: boolean
}

/** 高可信阈值：达到即进入正常回复流程。 */
export const CONFIDENCE_HIGH = 0.75
/** 低可信阈值：低于该值不自动回复；介于两者之间需要二次验证。 */
export const CONFIDENCE_LOW = 0.45

const WEIGHTS = {
  native: 0.35,
  sharpness: 0.2,
  agreement: 0.25,
  boxMatch: 0.1,
  mergeTruncation: 0.1,
  correction: 0.05,
} as const

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function format(value: number): string {
  return value.toFixed(2)
}

/**
 * 规则式可解释质量评估（设计文档 6.5）：
 * - 先规则打分，不训练分类器、不宣称概率校准；
 * - 可用因子加权平均，权重按实际可用因子重新归一化（缺项不影响其它项）；
 * - 联系人身份未确认 → 无论 OCR 多高都 reject（硬否决）；
 * - 没有任何证据 → score=0、decision='verify'（交给二次验证，而不是盲目放行）。
 */
export function evaluateConfidence(inputs: ConfidenceInputs = {}): ConfidenceEvaluation {
  const signals: ConfidenceSignal[] = []
  const notes: string[] = []

  if (inputs.nativeConfidence !== undefined && Number.isFinite(inputs.nativeConfidence)) {
    const value = clamp01(inputs.nativeConfidence)
    signals.push({
      name: 'native-confidence',
      weight: WEIGHTS.native,
      value,
      note: `引擎原生置信度 ${format(value)}`,
    })
  } else {
    notes.push('引擎未提供原生置信度（不计分）')
  }

  const sharpnessParts: Array<{ value: number; note: string }> = []
  if (inputs.boxHeight !== undefined && Number.isFinite(inputs.boxHeight)) {
    const heightScore = clamp01((inputs.boxHeight - 8) / 12)
    sharpnessParts.push({ value: heightScore, note: `行高 ${Math.round(inputs.boxHeight)}px` })
  }
  if (inputs.scale !== undefined && Number.isFinite(inputs.scale)) {
    const scaleScore = inputs.scale >= 2 ? 1 : inputs.scale >= 1 ? 0.65 : 0.4
    sharpnessParts.push({ value: scaleScore, note: `截图放大 ${format(inputs.scale)}x` })
  }
  if (sharpnessParts.length > 0) {
    const value = sharpnessParts.reduce((sum, part) => sum + part.value, 0) / sharpnessParts.length
    signals.push({
      name: 'sharpness-heuristic',
      weight: WEIGHTS.sharpness,
      value,
      note: `清晰度启发：${sharpnessParts.map((part) => part.note).join('，')}`,
    })
  }

  const agreement = inputs.agreement
  if (agreement === 'agree' || agreement === 'conflict' || agreement === 'single') {
    const value = agreement === 'agree' ? 1 : agreement === 'single' ? 0.6 : 0.2
    const label = agreement === 'agree' ? '双引擎一致' : agreement === 'single' ? '单引擎无交叉验证' : '双引擎结果冲突'
    signals.push({ name: 'multi-engine-agreement', weight: WEIGHTS.agreement, value, note: label })
  } else if (inputs.engineCount === 1) {
    signals.push({
      name: 'multi-engine-agreement',
      weight: WEIGHTS.agreement,
      value: 0.6,
      note: '仅单引擎识别',
    })
  }

  if (inputs.boxMatch !== undefined && Number.isFinite(inputs.boxMatch)) {
    const value = clamp01(inputs.boxMatch)
    signals.push({ name: 'box-match', weight: WEIGHTS.boxMatch, value, note: `框匹配度 ${format(value)}` })
  }

  if (inputs.mergedLines !== undefined || inputs.truncated !== undefined) {
    const parts: number[] = []
    const detail: string[] = []
    if (inputs.mergedLines !== undefined) {
      const merged = inputs.mergedLines
      const value = merged <= 1 ? 1 : merged === 2 ? 0.7 : 0.45
      parts.push(value)
      detail.push(merged > 1 ? `跨行合并 ${merged} 行` : '未跨行合并')
    }
    if (inputs.truncated !== undefined) {
      parts.push(inputs.truncated ? 0.5 : 1)
      detail.push(inputs.truncated ? '疑似截断' : '未截断')
    }
    signals.push({
      name: 'merge-truncation',
      weight: WEIGHTS.mergeTruncation,
      value: parts.reduce((min, part) => Math.min(min, part), 1),
      note: detail.join('，'),
    })
  }

  if (inputs.correctionApplied !== undefined) {
    signals.push({
      name: 'correction-applied',
      weight: WEIGHTS.correction,
      value: inputs.correctionApplied ? 0.7 : 1,
      note: inputs.correctionApplied ? '文本经过词典纠错' : '未使用词典纠错',
    })
  }

  let weightSum = 0
  let weightedSum = 0
  for (const signal of signals) {
    weightSum += signal.weight
    weightedSum += signal.weight * signal.value
  }
  let score = weightSum > 0 ? clamp01(weightedSum / weightSum) : 0

  const contactVerified = inputs.contactVerified
  const vetoed = contactVerified === false
  if (vetoed) score = Math.min(score, 0.2)

  let decision: ConfidenceEvaluation['decision']
  if (vetoed) decision = 'reject'
  else if (signals.length === 0) decision = 'verify'
  else if (score >= CONFIDENCE_HIGH) decision = 'accept'
  else if (score >= CONFIDENCE_LOW) decision = 'verify'
  else decision = 'reject'

  const parts: string[] = []
  if (signals.length === 0) parts.push('没有任何可用质量因子，需二次验证')
  else parts.push(`${signals.map((signal) => signal.note).join('；')}`)
  if (notes.length > 0) parts.push(notes.join('；'))
  if (vetoed) parts.push('联系人身份未确认，一律不自动发送')
  if (inputs.textLength !== undefined && inputs.textLength > 0 && inputs.textLength <= 2) {
    parts.push(`文本很短（${inputs.textLength} 字）`)
  }
  const decisionLabel = decision === 'accept' ? '可放行' : decision === 'verify' ? '需二次验证' : '不自动投递'
  parts.unshift(`置信度 ${format(score)}，${decisionLabel}（${decision}）`)

  return { score, signals, decision, explain: parts.join('；'), vetoed }
}
