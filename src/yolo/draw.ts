import type { DetectResult, SegmentResult } from './types'

/** Highlight color for segmented surfaces such as walls (the app's signal yellow). */
export const SURFACE_COLOR = '#f2c230'
const SURFACE_RGBA = [242, 194, 48, 125] as const
/** Highlight color for surfaces that are trip hazards, such as stairs. */
export const HAZARD_COLOR = '#ff4d6d'
const HAZARD_RGBA = [255, 77, 109, 150] as const

/**
 * A stable, well-spread hue per class (golden-angle steps around the color wheel).
 * Hues 30–90 are skipped so boxes never blend into the yellow wall highlight.
 */
export function classColor(classId: number): string {
  return `hsl(${Math.round((90 + ((classId * 137.508 + 110) % 300)) % 360)} 85% 62%)`
}

export interface Overlay {
  objects: DetectResult | null
  surfaces: SegmentResult | null
  /** Label-map class ids to highlight, e.g. ADE20K "wall". */
  surfaceClasses: readonly number[]
  /** Label-map class ids to highlight as hazards, e.g. ADE20K "stairs". */
  hazardClasses: readonly number[]
  names: string[]
}

let maskCanvas: OffscreenCanvas | null = null

function drawSurfaces(
  ctx: CanvasRenderingContext2D,
  seg: SegmentResult,
  classIds: readonly number[],
  [r, g, b, a]: readonly [number, number, number, number],
) {
  const { labels, labelWidth: w, labelHeight: h } = seg
  maskCanvas ??= new OffscreenCanvas(w, h)
  if (maskCanvas.width !== w || maskCanvas.height !== h) {
    maskCanvas.width = w
    maskCanvas.height = h
  }
  const highlight = new Uint8Array(256)
  for (const id of classIds) highlight[id] = 1

  const image = new ImageData(w, h)
  const pixels = new Uint32Array(image.data.buffer)
  const fill = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0 // RGBA bytes on little-endian hardware
  for (let i = 0; i < labels.length; i++) if (highlight[labels[i]]) pixels[i] = fill
  maskCanvas.getContext('2d')!.putImageData(image, 0, 0)

  // The label map is lower resolution than the source; smoothing softens its stair-stepped edges.
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(maskCanvas, 0, 0, seg.width, seg.height)
}

function drawBoxes(ctx: CanvasRenderingContext2D, result: DetectResult, names: string[]) {
  const { width, height, detections } = result
  // Scale strokes and type with the source so they read the same at any resolution.
  const unit = Math.max(width, height) / 640
  const line = Math.max(2, Math.round(2 * unit))
  const fontSize = Math.max(12, Math.round(13 * unit))
  const pad = Math.round(fontSize * 0.35)
  ctx.font = `600 ${fontSize}px "Archivo Variable", system-ui, sans-serif`
  ctx.textBaseline = 'top'
  ctx.lineWidth = line

  for (const d of detections) {
    const [x1, y1, x2, y2] = d.box
    const color = classColor(d.classId)
    ctx.strokeStyle = color
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)

    const label = `${names[d.classId] ?? `class ${d.classId}`} ${Math.round(d.score * 100)}%`
    const tagWidth = ctx.measureText(label).width + pad * 2
    const tagHeight = fontSize + pad * 2
    const tagX = Math.max(0, Math.min(x1 - line / 2, width - tagWidth))
    const tagY = y1 - tagHeight >= 0 ? y1 - tagHeight : y1
    ctx.fillStyle = color
    ctx.fillRect(tagX, tagY, tagWidth, tagHeight)
    ctx.fillStyle = '#10161d'
    ctx.fillText(label, tagX + pad, tagY + pad)
  }
}

/** Draws surfaces, then boxes, onto a canvas whose intrinsic size matches the source. */
export function drawOverlay(canvas: HTMLCanvasElement, overlay: Overlay) {
  const size = overlay.objects ?? overlay.surfaces
  if (!size) return clearCanvas(canvas)
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width
    canvas.height = size.height
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (overlay.surfaces && overlay.surfaceClasses.length) {
    drawSurfaces(ctx, overlay.surfaces, overlay.surfaceClasses, SURFACE_RGBA)
  }
  if (overlay.surfaces && overlay.hazardClasses.length) {
    drawSurfaces(ctx, overlay.surfaces, overlay.hazardClasses, HAZARD_RGBA)
  }
  if (overlay.objects) drawBoxes(ctx, overlay.objects, overlay.names)
}

export function clearCanvas(canvas: HTMLCanvasElement | null) {
  canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
}

/** Fraction of the source covered by the given label-map classes, 0 to 1. */
export function coverage(seg: SegmentResult, classIds: readonly number[]): number {
  if (!classIds.length) return 0
  const highlight = new Uint8Array(256)
  for (const id of classIds) highlight[id] = 1
  let count = 0
  for (let i = 0; i < seg.labels.length; i++) count += highlight[seg.labels[i]]
  return count / seg.labels.length
}
