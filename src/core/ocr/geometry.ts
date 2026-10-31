/**
 * OCR 几何工具（纯函数、无副作用）。
 *
 * 约定：
 * - 所有坐标都是同一帧内的像素坐标；跨帧比较前必须先把框换算到同一坐标模型（见 toLogical / fromLogical）。
 * - 空框/负宽高一律视为无效（返回 null 或 0），调用方必须处理「无法判断」的情况。
 */

import type { OcrBox } from './types.ts'

/** 判断一个框是否有效（宽高为正的有限数）。 */
export function isValidBox(box: OcrBox | undefined | null): box is OcrBox {
  return (
    !!box &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  )
}

/** 构造一个框（对负宽高做归正）。 */
export function makeBox(x: number, y: number, width: number, height: number): OcrBox {
  const nx = Number.isFinite(x) ? x : 0
  const ny = Number.isFinite(y) ? y : 0
  const nw = Number.isFinite(width) ? Math.abs(width) : 0
  const nh = Number.isFinite(height) ? Math.abs(height) : 0
  return { x: nx, y: ny, width: nw, height: nh }
}

export function boxRight(box: OcrBox): number {
  return box.x + box.width
}

export function boxBottom(box: OcrBox): number {
  return box.y + box.height
}

export function boxArea(box: OcrBox): number {
  return isValidBox(box) ? box.width * box.height : 0
}

/** 两框交集；不相交返回 null。 */
export function intersectionBox(a: OcrBox, b: OcrBox): OcrBox | null {
  if (!isValidBox(a) || !isValidBox(b)) return null
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(boxRight(a), boxRight(b))
  const bottom = Math.min(boxBottom(a), boxBottom(b))
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

/** 交并比 IoU（0..1）。 */
export function iou(a: OcrBox, b: OcrBox): number {
  const inter = intersectionBox(a, b)
  if (!inter) return 0
  const interArea = boxArea(inter)
  const union = boxArea(a) + boxArea(b) - interArea
  return union > 0 ? interArea / union : 0
}

/** outer 是否完全包含 inner（允许 1px 容差）。 */
export function containsBox(outer: OcrBox, inner: OcrBox, tolerance = 1): boolean {
  if (!isValidBox(outer) || !isValidBox(inner)) return false
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    boxRight(inner) <= boxRight(outer) + tolerance &&
    boxBottom(inner) <= boxBottom(outer) + tolerance
  )
}

export interface Point {
  x: number
  y: number
}

export function centerOf(box: OcrBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** 两个框中心点的欧氏距离。 */
export function centerDistance(a: OcrBox, b: OcrBox): number {
  const ca = centerOf(a)
  const cb = centerOf(b)
  return Math.hypot(ca.x - cb.x, ca.y - cb.y)
}

/** 垂直方向重合度：重合高度 / 较矮框高度（0..1）。用于判断两行是否处于同一水平带。 */
export function verticalOverlapRatio(a: OcrBox, b: OcrBox): number {
  if (!isValidBox(a) || !isValidBox(b)) return 0
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(boxBottom(a), boxBottom(b))
  const overlap = bottom - top
  if (overlap <= 0) return 0
  return overlap / Math.min(a.height, b.height)
}

/** 水平方向重合度：重合宽度 / 较窄框宽度（0..1）。用于判断两框是否左右相邻。 */
export function horizontalOverlapRatio(a: OcrBox, b: OcrBox): number {
  if (!isValidBox(a) || !isValidBox(b)) return 0
  const left = Math.max(a.x, b.x)
  const right = Math.min(boxRight(a), boxRight(b))
  const overlap = right - left
  if (overlap <= 0) return 0
  return overlap / Math.min(a.width, b.width)
}

/** 两框外接框；任一无效时返回另一个（都无效返回零框）。 */
export function unionBox(a: OcrBox | null, b: OcrBox | null): OcrBox {
  if (!isValidBox(a) && !isValidBox(b)) return makeBox(0, 0, 0, 0)
  if (!isValidBox(a)) return { ...(b as OcrBox) }
  if (!isValidBox(b)) return { ...a }
  const left = Math.min(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const right = Math.max(boxRight(a), boxRight(b))
  const bottom = Math.max(boxBottom(a), boxBottom(b))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 合并一组框为外接框。 */
export function mergeBoxes(boxes: Array<OcrBox | null | undefined>): OcrBox {
  return boxes.reduce<OcrBox>((acc, box) => unionBox(acc, box ?? null), makeBox(0, 0, 0, 0))
}

/** 按比例缩放框（用于 DPI / 预处理倍率换算）。 */
export function scaleBox(box: OcrBox, factor: number): OcrBox {
  return makeBox(box.x * factor, box.y * factor, box.width * factor, box.height * factor)
}

/** 平移框。 */
export function offsetBox(box: OcrBox, dx: number, dy: number): OcrBox {
  return makeBox(box.x + dx, box.y + dy, box.width, box.height)
}

/** 像素坐标 → 逻辑坐标（100% DPI 下）。 */
export function toLogicalBox(box: OcrBox, dpiScale: number): OcrBox {
  const scale = dpiScale > 0 && Number.isFinite(dpiScale) ? dpiScale : 1
  return scaleBox(box, 1 / scale)
}

/** 逻辑坐标 → 像素坐标。 */
export function fromLogicalBox(box: OcrBox, dpiScale: number): OcrBox {
  const scale = dpiScale > 0 && Number.isFinite(dpiScale) ? dpiScale : 1
  return scaleBox(box, scale)
}

/** 按「阅读顺序」排序：先上后下，同一水平带内先左后右。 */
export function sortByReadingOrder<T extends { box: OcrBox }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (Math.abs(a.box.y - b.box.y) > Math.max(4, Math.min(a.box.height, b.box.height) * 0.5)) {
      return a.box.y - b.box.y
    }
    return a.box.x - b.box.x
  })
}

/**
 * 把 OCR 行按「行带」分组：垂直重叠度足够高、且水平间隔不大的行归为同一带。
 * 用于把一行被横切成多段的结果合并。
 */
export function groupLinesIntoRows<T extends { box: OcrBox }>(
  items: T[],
  options: { minVerticalOverlap?: number; maxHorizontalGapRatio?: number } = {},
): T[][] {
  const minOverlap = options.minVerticalOverlap ?? 0.5
  const maxGapRatio = options.maxHorizontalGapRatio ?? 1.6
  const sorted = sortByReadingOrder(items.filter((item) => isValidBox(item.box)))
  const rows: T[][] = []
  for (const item of sorted) {
    const row = rows.find((candidate) => {
      const last = candidate[candidate.length - 1]
      if (verticalOverlapRatio(last.box, item.box) < minOverlap) return false
      const gap = item.box.x - boxRight(last.box)
      const height = Math.max(last.box.height, item.box.height)
      return gap <= height * maxGapRatio
    })
    if (row) row.push(item)
    else rows.push([item])
  }
  return rows
}

/** 框是否与给定区域（聊天区域）相交超过阈值。 */
export function boxInsideRegion(box: OcrBox, region: OcrBox, minRatio = 0.5): boolean {
  if (!isValidBox(box) || !isValidBox(region)) return false
  const inter = intersectionBox(box, region)
  if (!inter) return false
  return boxArea(inter) / boxArea(box) >= minRatio
}

/** 判断两个框是否水平相邻（同一行带内、水平间距不超过阈值）。 */
export function isHorizontallyAdjacent(a: OcrBox, b: OcrBox, maxGapRatio = 1.6): boolean {
  if (!isValidBox(a) || !isValidBox(b)) return false
  const gap = a.x <= b.x ? b.x - boxRight(a) : a.x - boxRight(b)
  const height = Math.max(a.height, b.height)
  return gap <= height * maxGapRatio
}

/** 两个框的垂直中心差（像素）。 */
export function verticalCenterDelta(a: OcrBox, b: OcrBox): number {
  return Math.abs(centerOf(a).y - centerOf(b).y)
}
