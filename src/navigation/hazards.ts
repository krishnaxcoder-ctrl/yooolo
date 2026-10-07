import type { DetectResult, SegmentResult } from '../yolo/types'

export type Side = 'left' | 'ahead' | 'right'

export interface Hazard {
  name: string
  side: Side
  /** Box height as a share of the frame: a rough stand-in for distance. */
  size: number
  near: boolean
}

// COCO classes that block a path or move into it. Small things (cups, phones) aren't worth a warning.
const OBSTACLES = new Set([
  'person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'train',
  'dog', 'cat', 'horse', 'cow', 'sheep', 'elephant',
  'bench', 'chair', 'couch', 'dining table', 'bed', 'potted plant', 'fire hydrant',
  'parking meter', 'stop sign', 'suitcase', 'skateboard', 'toilet', 'refrigerator',
  // From the hazard detector.
  'ladder',
])

/** Hazards on the ground. They're flat, so how low they sit in the frame says how close they are. */
const GROUND = new Set(['pothole'])
/** Box bottoms (share of frame height) at which a ground hazard is in the way, and close. */
const GROUND_AHEAD = 0.55
const GROUND_NEAR = 0.8

/** Box heights (share of frame) at which something counts as in the way, and as close. */
const AHEAD_SIZE = 0.28
const SIDE_SIZE = 0.42
const NEAR_SIZE = 0.5

/** The obstacles worth mentioning in this frame, most pressing first. */
export function findHazards(result: DetectResult, names: string[]): Hazard[] {
  const hazards: Hazard[] = []
  for (const d of result.detections) {
    const name = names[d.classId]
    if (!name || !(OBSTACLES.has(name) || GROUND.has(name))) continue
    const [x1, y1, x2, y2] = d.box
    const cx = (x1 + x2) / 2 / result.width
    const side: Side = cx < 0.33 ? 'left' : cx > 0.67 ? 'right' : 'ahead'
    if (GROUND.has(name)) {
      const bottom = y2 / result.height
      if (bottom >= GROUND_AHEAD) hazards.push({ name, side, size: bottom, near: bottom >= GROUND_NEAR })
      continue
    }
    const size = (y2 - y1) / result.height
    if (size < (side === 'ahead' ? AHEAD_SIZE : SIDE_SIZE)) continue
    hazards.push({ name, side, size, near: size >= NEAR_SIZE })
  }
  return hazards.sort(mostPressing)
}

// Things straight ahead matter most, then whatever is closest.
const mostPressing = (a: Hazard, b: Hazard) => Number(b.side === 'ahead') - Number(a.side === 'ahead') || b.size - a.size

/** Shares of the walking zone that stairs must cover to be mentioned, and to count as close. */
const STAIRS_SHARE = 0.04
const STAIRS_NEAR_SHARE = 0.12

/**
 * Stairs from the surface model's label map. Only the bottom half of the frame counts: that's
 * the ground just ahead, so a staircase across the room isn't announced.
 */
export function findStairs(seg: SegmentResult, classIds: readonly number[]): Hazard | null {
  if (!classIds.length) return null
  const isStair = new Uint8Array(256)
  for (const id of classIds) isStair[id] = 1
  const { labels, labelWidth: w, labelHeight: h } = seg
  const top = Math.floor(h / 2)
  const nearTop = Math.floor(h * 0.75)
  let count = 0
  let near = 0
  let sumX = 0
  for (let y = top; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isStair[labels[y * w + x]]) continue
      count++
      sumX += x
      if (y >= nearTop) near++
    }
  }
  const share = count / ((h - top) * w)
  if (share < STAIRS_SHARE) return null
  const cx = sumX / count / w
  const side: Side = cx < 0.33 ? 'left' : cx > 0.67 ? 'right' : 'ahead'
  return { name: 'stairs', side, size: share, near: near / ((h - nearTop) * w) >= STAIRS_NEAR_SHARE }
}

/** Every hazard in the latest frame, from both models, most pressing first. */
export function allHazards(
  objects: DetectResult | null,
  names: string[],
  surfaces: SegmentResult | null,
  stairClasses: readonly number[],
  detected: DetectResult | null = null,
  detectedNames: string[] = [],
): Hazard[] {
  const stairs = surfaces ? findStairs(surfaces, stairClasses) : null
  return [
    ...(stairs ? [stairs] : []),
    ...(objects ? findHazards(objects, names) : []),
    ...(detected ? findHazards(detected, detectedNames) : []),
  ].sort(mostPressing)
}

export function hazardPhrase(h: Hazard): string {
  if (GROUND.has(h.name)) {
    const where = h.side === 'ahead' ? 'ahead' : `on your ${h.side}`
    return h.near ? `Careful, ${h.name} ${where}.` : `${capitalize(h.name)} ${where}.`
  }
  if (h.name === 'stairs' && h.near) return h.side === 'ahead' ? 'Careful, stairs ahead.' : `Careful, stairs on your ${h.side}.`
  if (h.side === 'ahead') return h.near ? `Slow down, ${h.name} ahead.` : `${capitalize(h.name)} ahead.`
  return `${capitalize(h.name)} on your ${h.side}.`
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const REPEAT_MS = 8000
const GAP_MS = 3000

/** Decides when to speak a hazard, so a person standing ahead isn't announced on every frame. */
export class HazardAnnouncer {
  private lastSaid = new Map<string, number>()
  private lastAny = -Infinity

  /** Returns the hazard to announce now, if any. */
  pick(hazards: Hazard[], now = performance.now()): Hazard | null {
    if (now - this.lastAny < GAP_MS) return null
    for (const h of hazards) {
      const key = `${h.name}:${h.side}:${h.near}`
      if (now - (this.lastSaid.get(key) ?? -Infinity) < REPEAT_MS) continue
      this.lastSaid.set(key, now)
      this.lastAny = now
      return h
    }
    return null
  }

  reset() {
    this.lastSaid.clear()
    this.lastAny = -Infinity
  }
}

/** A short buzz on phones that support it; a double buzz when something is close. */
export function buzz(h: Hazard) {
  navigator.vibrate?.(h.near ? [250, 100, 250] : 150)
}
