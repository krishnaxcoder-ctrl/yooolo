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
  /** Boxes from the hazard detector (e.g. potholes), drawn in the hazard color. */
  hazards: DetectResult | null
  hazardNames: string[]
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

/** Sets the label font and line width, scaled with the source so they read the same at any resolution. */
function labelStyle(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const unit = Math.max(width, height) / 640
  const line = Math.max(2, Math.round(2 * unit))
  const fontSize = Math.max(12, Math.round(13 * unit))
  ctx.font = `600 ${fontSize}px "Archivo Variable", system-ui, sans-serif`
  ctx.textBaseline = 'top'
  ctx.lineWidth = line
  return { line, fontSize, pad: Math.round(fontSize * 0.35) }
}

/** A filled name tag sitting on top of the region whose top-left corner is (x, y). */
function drawTag(
  ctx: CanvasRenderingContext2D,
  label: string,
  color: string,
  x: number,
  y: number,
  sourceWidth: number,
  { line, fontSize, pad }: ReturnType<typeof labelStyle>,
) {
  const tagWidth = ctx.measureText(label).width + pad * 2
  const tagHeight = fontSize + pad * 2
  const tagX = Math.max(0, Math.min(x - line / 2, sourceWidth - tagWidth))
  const tagY = y - tagHeight >= 0 ? y - tagHeight : y
  ctx.fillStyle = color
  ctx.fillRect(tagX, tagY, tagWidth, tagHeight)
  ctx.fillStyle = '#0a0a0a'
  ctx.fillText(label, tagX + pad, tagY + pad)
}

function drawBoxes(
  ctx: CanvasRenderingContext2D,
  result: DetectResult,
  names: string[],
  colorOf: (classId: number) => string = classColor,
) {
  const { width, height, detections } = result
  const style = labelStyle(ctx, width, height)
  for (const d of detections) {
    const [x1, y1, x2, y2] = d.box
    const color = colorOf(d.classId)
    ctx.strokeStyle = color
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
    drawTag(ctx, `${names[d.classId] ?? `class ${d.classId}`} ${Math.round(d.score * 100)}%`, color, x1, y1, width, style)
  }
}

/** Below this share of the frame, a hazard surface is likely stray pixels and isn't named. */
const MIN_NAMED_SHARE = 0.005

/** Names a highlighted hazard surface (e.g. "stairs") with a tag at the top-left of its extent. */
function drawSurfaceTag(ctx: CanvasRenderingContext2D, seg: SegmentResult, classIds: readonly number[], label: string) {
  const { labels, labelWidth: w, labelHeight: h } = seg
  const wanted = new Uint8Array(256)
  for (const id of classIds) wanted[id] = 1
  let count = 0
  let minX = w
  let minY = h
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!wanted[labels[y * w + x]]) continue
      count++
      if (x < minX) minX = x
      if (y < minY) minY = y
    }
  }
  if (count / labels.length < MIN_NAMED_SHARE) return
  drawTag(ctx, label, HAZARD_COLOR, (minX * seg.width) / w, (minY * seg.height) / h, seg.width, labelStyle(ctx, seg.width, seg.height))
}

/** Furniture the object model tends to see in a staircase, mostly "chair". */
const CONFUSED_WITH_STAIRS = new Set(['chair', 'bench', 'couch', 'bed', 'dining table'])
/** Share of a box covered by stairs at which the box is taken to be the stairs themselves. */
const ON_STAIRS_SHARE = 0.35

/**
 * Drops furniture boxes that mostly cover stairs, since the surface model's "stairs" is the
 * better name for them. People and animals on stairs are kept.
 */
export function dropBoxesOnStairs(
  objects: DetectResult,
  names: string[],
  surfaces: SegmentResult,
  stairClasses: readonly number[],
): DetectResult {
  if (!stairClasses.length) return objects
  const { labels, labelWidth: w, labelHeight: h } = surfaces
  const isStair = new Uint8Array(256)
  for (const id of stairClasses) isStair[id] = 1
  const sx = w / objects.width
  const sy = h / objects.height
  const detections = objects.detections.filter((d) => {
    if (!CONFUSED_WITH_STAIRS.has(names[d.classId])) return true
    const x1 = Math.max(0, Math.floor(d.box[0] * sx))
    const y1 = Math.max(0, Math.floor(d.box[1] * sy))
    const x2 = Math.min(w, Math.ceil(d.box[2] * sx))
    const y2 = Math.min(h, Math.ceil(d.box[3] * sy))
    let stairs = 0
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) stairs += isStair[labels[y * w + x]]
    const area = (x2 - x1) * (y2 - y1)
    return area === 0 || stairs / area < ON_STAIRS_SHARE
  })
  return detections.length === objects.detections.length ? objects : { ...objects, detections }
}

/** Draws surfaces, then boxes, onto a canvas whose intrinsic size matches the source. */
export function drawOverlay(canvas: HTMLCanvasElement, overlay: Overlay) {
  const size = overlay.objects ?? overlay.surfaces ?? overlay.hazards
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
  if (overlay.hazards) drawBoxes(ctx, overlay.hazards, overlay.hazardNames, () => HAZARD_COLOR)
  // Drawn last so no box covers it.
  if (overlay.surfaces && overlay.hazardClasses.length) {
    drawSurfaceTag(ctx, overlay.surfaces, overlay.hazardClasses, 'stairs')
  }
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
