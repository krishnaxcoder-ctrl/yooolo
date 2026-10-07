import type { DetectResult } from '../yolo/types'

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
])

/** Box heights (share of frame) at which something counts as in the way, and as close. */
const AHEAD_SIZE = 0.28
const SIDE_SIZE = 0.42
const NEAR_SIZE = 0.5

/** The obstacles worth mentioning in this frame, most pressing first. */
export function findHazards(result: DetectResult, names: string[]): Hazard[] {
  const hazards: Hazard[] = []
  for (const d of result.detections) {
    const name = names[d.classId]
    if (!name || !OBSTACLES.has(name)) continue
    const [x1, y1, x2, y2] = d.box
    const cx = (x1 + x2) / 2 / result.width
    const size = (y2 - y1) / result.height
    const side: Side = cx < 0.33 ? 'left' : cx > 0.67 ? 'right' : 'ahead'
    if (size < (side === 'ahead' ? AHEAD_SIZE : SIDE_SIZE)) continue
    hazards.push({ name, side, size, near: size >= NEAR_SIZE })
  }
  // Things straight ahead matter most, then whatever is closest.
  return hazards.sort((a, b) => Number(b.side === 'ahead') - Number(a.side === 'ahead') || b.size - a.size)
}

export function hazardPhrase(h: Hazard): string {
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
