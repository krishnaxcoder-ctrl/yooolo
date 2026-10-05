import type { Detection } from './types'

/** How a source image was scaled and padded into the square model input. */
export interface Letterbox {
  scale: number
  left: number
  top: number
  width: number
  height: number
}

/** Matches Ultralytics' centered letterbox, so boxes line up with Python results. */
export function letterbox(srcWidth: number, srcHeight: number, size: number): Letterbox {
  const scale = Math.min(size / srcWidth, size / srcHeight)
  const width = Math.round(srcWidth * scale)
  const height = Math.round(srcHeight * scale)
  return {
    scale,
    left: Math.round((size - width) / 2 - 0.1),
    top: Math.round((size - height) / 2 - 0.1),
    width,
    height,
  }
}

function toSource(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lb: Letterbox,
  srcWidth: number,
  srcHeight: number,
): Detection['box'] {
  const clampX = (v: number) => Math.min(Math.max((v - lb.left) / lb.scale, 0), srcWidth)
  const clampY = (v: number) => Math.min(Math.max((v - lb.top) / lb.scale, 0), srcHeight)
  return [clampX(x1), clampY(y1), clampX(x2), clampY(y2)]
}

/** NMS-free output such as YOLO26: rows of x1, y1, x2, y2, score, class. */
export function decodeEnd2End(
  data: Float32Array,
  rows: number,
  conf: number,
  lb: Letterbox,
  srcWidth: number,
  srcHeight: number,
): Detection[] {
  const detections: Detection[] = []
  for (let i = 0; i < rows; i++) {
    const o = i * 6
    const score = data[o + 4]
    if (score < conf) continue
    detections.push({
      box: toSource(data[o], data[o + 1], data[o + 2], data[o + 3], lb, srcWidth, srcHeight),
      score,
      classId: Math.round(data[o + 5]),
    })
  }
  return detections.sort((a, b) => b.score - a.score)
}

/** Classic YOLOv8/YOLO11-style output: channel-major cx, cy, w, h, then one score per class. */
export function decodeRaw(
  data: Float32Array,
  numClasses: number,
  anchors: number,
  conf: number,
  iou: number,
  lb: Letterbox,
  srcWidth: number,
  srcHeight: number,
): Detection[] {
  const candidates: Detection[] = []
  for (let a = 0; a < anchors; a++) {
    let score = 0
    let classId = -1
    for (let c = 0; c < numClasses; c++) {
      const s = data[(4 + c) * anchors + a]
      if (s > score) {
        score = s
        classId = c
      }
    }
    if (score < conf) continue
    const cx = data[a]
    const cy = data[anchors + a]
    const hw = data[2 * anchors + a] / 2
    const hh = data[3 * anchors + a] / 2
    candidates.push({
      box: toSource(cx - hw, cy - hh, cx + hw, cy + hh, lb, srcWidth, srcHeight),
      score,
      classId,
    })
  }
  return nms(candidates, iou)
}

function overlap(a: Detection['box'], b: Detection['box']): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)
}

/** Greedy per-class non-maximum suppression. */
export function nms(detections: Detection[], iou: number, maxDetections = 300): Detection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score)
  const kept: Detection[] = []
  for (const d of sorted) {
    if (kept.length >= maxDetections) break
    if (kept.every((k) => k.classId !== d.classId || overlap(k.box, d.box) <= iou)) kept.push(d)
  }
  return kept
}

/** Crops the letterbox padding off a [H, W] label map, leaving only the source image area. */
export function cropLabels(data: Uint8Array, mapWidth: number, mapHeight: number, size: number, lb: Letterbox) {
  // The map may be smaller than the model input (e.g. stride 4); scale the crop to match.
  const fx = mapWidth / size
  const fy = mapHeight / size
  const x0 = Math.round(lb.left * fx)
  const y0 = Math.round(lb.top * fy)
  const labelWidth = Math.max(1, Math.min(mapWidth - x0, Math.round(lb.width * fx)))
  const labelHeight = Math.max(1, Math.min(mapHeight - y0, Math.round(lb.height * fy)))
  const labels = new Uint8Array(labelWidth * labelHeight)
  for (let y = 0; y < labelHeight; y++) {
    const row = (y + y0) * mapWidth + x0
    labels.set(data.subarray(row, row + labelWidth), y * labelWidth)
  }
  return { labels, labelWidth, labelHeight }
}
