#!/usr/bin/env node
/**
 * 生成表情包 PNG（可重复执行，幂等）。
 *
 * 只用 Node 内置模块手写合法 PNG，不依赖任何第三方库、不联网：
 *   stickers/<emotion>/00N.png   （6 类情绪 × 3 张 = 18 个 32x32 PNG）
 *
 * PNG 结构：8 字节签名 + IHDR + IDAT(zlib deflate) + IEND，每块带 CRC32。
 * 每张图只有两种颜色（背景色 + 图案色），便于微信侧当作极简表情包使用。
 *
 * 用法：node scripts/gen-stickers.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')
const STICKER_ROOT = join(PROJECT_ROOT, 'stickers')

const SIZE = 32
/** 每种情绪三张（不同图案），颜色区分情绪。 */
const VARIANTS = 3

/** 每种情绪的 [背景色, 图案色]（RGB）。 */
const EMOTIONS = [
  { name: 'happy', background: [255, 205, 60], accent: [255, 120, 20] },
  { name: 'playful', background: [170, 120, 255], accent: [255, 235, 80] },
  { name: 'shy', background: [255, 170, 190], accent: [225, 70, 120] },
  { name: 'comfort', background: [120, 205, 150], accent: [30, 130, 80] },
  { name: 'curious', background: [95, 185, 240], accent: [25, 80, 200] },
  { name: 'neutral', background: [205, 205, 210], accent: [110, 110, 120] },
]

/* ───────────────────────────── PNG 编码 ───────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value >>> 0, 0)
  return buffer
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuffer, data])
  return Buffer.concat([u32(data.length), body, u32(crc32(body))])
}

/**
 * 把 32x32 的 RGB 像素数组编码成 PNG。
 * pixels 为长度 SIZE*SIZE*3 的 Uint8Array。
 */
function encodePng(pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // 每行前置 1 字节 filter（0 = None）。
  const stride = SIZE * 3
  const raw = Buffer.alloc((stride + 1) * SIZE)
  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0
    for (let x = 0; x < stride; x += 1) {
      raw[rowStart + 1 + x] = pixels[y * stride + x]
    }
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ───────────────────────────── 图案绘制 ───────────────────────────── */

/** 画一张双色图：背景色 + 图案色；variant 决定图案形状。 */
function renderPixels(background, accent, variant) {
  const pixels = new Uint8Array(SIZE * SIZE * 3)
  const mid = (SIZE - 1) / 2

  /** 图案区域判定。 */
  const isAccent = (x, y) => {
    const dx = x - mid
    const dy = y - mid
    if (variant === 0) {
      // 0 号：中央方块 + 四周 2px 边框。
      const border = x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2
      const center = x >= 10 && x < 22 && y >= 10 && y < 22
      return border || center
    }
    if (variant === 1) {
      // 1 号：中央菱形。
      return Math.abs(dx) + Math.abs(dy) <= 9
    }
    // 2 号：三条横向条纹。
    const border = x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2
    const stripes = (y >= 7 && y < 11) || (y >= 14 && y < 18) || (y >= 21 && y < 25)
    return border || stripes
  }

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const color = isAccent(x, y) ? accent : background
      const offset = (y * SIZE + x) * 3
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
    }
  }
  return pixels
}

/* ───────────────────────────── 主流程 ───────────────────────────── */

function main() {
  let written = 0
  for (const emotion of EMOTIONS) {
    const dir = join(STICKER_ROOT, emotion.name)
    mkdirSync(dir, { recursive: true })
    for (let variant = 0; variant < VARIANTS; variant += 1) {
      const name = `${String(variant + 1).padStart(3, '0')}.png`
      const png = encodePng(renderPixels(emotion.background, emotion.accent, variant))
      writeFileSync(join(dir, name), png)
      written += 1
    }
  }
  console.log(`stickers: 已生成 ${written} 个 PNG -> ${STICKER_ROOT}`)
}

main()
