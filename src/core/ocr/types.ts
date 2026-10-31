/**
 * OCR 领域模型（v3.0.0）。
 *
 * 设计原则：
 * - 所有坐标都是「同一帧截图」内的绝对像素坐标；帧由 captureId 唯一标识，跨帧坐标不可混用。
 * - OcrLine / OcrResult 是引擎的原始输出，**不可变**（上层不得原地修改），所有派生结果新建对象。
 * - 引擎自身不返回置信度时，`confidence` 必须是 undefined，**不得编造**（任务书约束）。
 * - 本模块只含类型与纯常量，不产生任何副作用，方便单测与离线 benchmark 复用。
 */

/** OCR 引擎标识。允许扩展（融合/benchmark 会用到），因此用 string 而非联合字面量。 */
export type OcrEngineId = string

/** 矩形框：左上角 + 宽高，单位为所在帧的像素。 */
export interface OcrBox {
  x: number
  y: number
  width: number
  height: number
}

/** 一帧截图的元数据（不可变；captureId 是帧的唯一身份）。 */
export interface FrameMeta {
  captureId: string
  /** 帧宽（像素） */
  width: number
  /** 帧高（像素） */
  height: number
  /** 系统 DPI 缩放（100% = 1，125% = 1.25），用于在固定逻辑坐标与像素坐标间换算 */
  dpiScale: number
  /** 帧对应窗口在屏幕上的位置（可选；多显示器时用于还原绝对坐标） */
  windowRect?: { left: number; top: number; width: number; height: number }
  /** 抓帧来源：全窗口 / 聊天区域 / 调试截图 */
  source?: 'window' | 'region' | 'fixture'
}

/** 预处理变体标识（原图、2x、灰度增强……）；与 captureId 一起唯一确定一次识别输入。 */
export type PreprocessingId = string

/** OCR 引擎输出的一行文本。 */
export interface OcrLine {
  text: string
  box: OcrBox
  engine: OcrEngineId
  /** 引擎置信度（0..1）。引擎不提供时为 undefined —— 不得编造。 */
  confidence?: number
  /** 该行来自哪一帧 */
  captureId: string
  /** 该行使用的预处理变体 */
  preprocessingId: PreprocessingId
  /** 行内单词/字符框（可选，用于更精细的对齐与高亮） */
  words?: OcrBox[]
}

/** 一次识别的完整结果（一个引擎 × 一帧 × 一个预处理变体）。 */
export interface OcrResult {
  captureId: string
  engine: OcrEngineId
  preprocessingId: PreprocessingId
  lines: OcrLine[]
  elapsedMs: number
  /** 识别失败时的错误描述；成功时 undefined */
  error?: string
}

/** 一次识别的输入。 */
export interface OcrRecognizeInput {
  /** 帧元数据（captureId 必填） */
  frame: FrameMeta
  /** 截图文件路径（或引擎实现自取当前帧） */
  imagePath?: string
  /** 预处理变体 */
  preprocessingId?: PreprocessingId
}

/** 识别选项：超时与取消（任务书要求每个引擎都支持）。 */
export interface OcrRecognizeOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** 引擎可用性。 */
export interface OcrAvailability {
  available: boolean
  /** 不可用原因（给诊断中心展示） */
  reason?: string
  /** 引擎自报版本（可选） */
  version?: string
}

/** 统一 OCR 引擎接口：Windows OCR、RapidOCR、mock 都实现它。 */
export interface OcrEngine {
  readonly engineId: OcrEngineId
  availability(): Promise<OcrAvailability>
  healthCheck(): Promise<boolean>
  recognize(input: OcrRecognizeInput, options?: OcrRecognizeOptions): Promise<OcrResult>
}

/** 气泡归属：左侧=对方，右侧=自己，无法判断时 unknown（宁可不回也不猜）。 */
export type BubbleSide = 'left' | 'right' | 'unknown'

/**
 * 气泡归属分类（v3.0.0 Phase C）：由几何边界判断一行文本属于谁的消息。
 * - inbound：靠聊天面板左边界，可进入回复流程；
 * - outbound：靠右边界（自己），一律不回复；
 * - uncertain：贴边不足/同时贴两边/中心越过中线等无法判断的情况，一律不投递。
 */
export type BubbleOwnership = 'inbound' | 'outbound' | 'uncertain'

/** 聊天面板的几何边界（相对截图帧的像素坐标，对应 PS1 Get-InboundCandidates 的窗格比例）。 */
export interface BubblePane {
  left: number
  right: number
  top: number
  bottom: number
}

/** 参与气泡归属判断的一行文本（OCR 行，或按行合并后的候选行）。 */
export interface BubbleLineInput {
  text: string
  box: OcrBox
}

/** 单行气泡归属分类结果（可解释，便于诊断与单测）。 */
export interface BubbleClassification {
  /** 原始输入行（同一对象引用，便于上层继续使用） */
  line: BubbleLineInput
  side: BubbleSide
  ownership: BubbleOwnership
  /** 判定原因（英文稳定标识，写日志与断言用） */
  reason: string
}

/** 从一帧 OCR 结果中抽出的消息候选（尚未提交状态）。 */
export interface MessageCandidate {
  /** 该候选所属帧 */
  captureId: string
  /** 候选在帧内的区域（多行合并后的外接框） */
  box: OcrBox
  /** 合并后的文本（已做 OCR 归一化） */
  text: string
  /** 气泡归属 */
  side: BubbleSide
  /** 组成该候选的原始行（保持只读引用） */
  lines: OcrLine[]
  /** 候选身份（稳定标识，见 identity 模块；跨帧复用） */
  identity: string
  /** 信心评估（见 confidence 模块） */
  confidence: number
  /** 候选状态 */
  status: MessageStatus
}

/** 消息候选状态。 */
export type MessageStatus =
  | 'confirmed' // 高可信，可进入回复流程
  | 'uncertain' // 可信度不足，不自动回复（可进诊断中心）
  | 'unreadable' // 无法识别（不消费、不丢）
  | 'mismatch' // 多引擎/多帧结果冲突
  | 'duplicate' // 与已处理消息重复
  | 'wrong-contact' // 联系人验证失败，一律不发

/** 置信度评估的可解释分解项。 */
export interface ConfidenceFactor {
  name: string
  /** 该项得分（0..1） */
  value: number
  /** 权重（各项权重和 = 1） */
  weight: number
  /** 人类可读原因（诊断中心展示） */
  reason: string
}

/** 置信度报告：分数 + 分解 + 等级。 */
export interface ConfidenceReport {
  score: number
  level: 'high' | 'low'
  factors: ConfidenceFactor[]
}

/** 发送结果三态：sent=确认送达；not-sent=确认未发出（可安全重试）；unknown=不可确认（不得自动重发）。 */
export type SendDelivery = 'sent' | 'not-sent' | 'unknown'

/** 发送结果（引擎与通道的公共契约）。 */
export interface SendResult {
  ok: boolean
  delivery?: SendDelivery
  /** 通道/脚本给出的错误或原因 */
  error?: string
  /** 幂等键（同一逻辑发送的多次尝试共用） */
  operationId?: string
}

/** 抓帧结果（同一帧不可变）。 */
export interface CaptureFrame {
  frame: FrameMeta
  /** 截图文件路径（临时文件或内存镜像落盘路径） */
  imagePath: string
  capturedAt: number
}
