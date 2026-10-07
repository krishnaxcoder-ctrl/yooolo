import type { Side } from '../navigation/hazards'
import type { DetectResult, SegmentResult } from '../yolo/types'

export type Room = 'kitchen' | 'bedroom' | 'bathroom' | 'living room' | 'dining room'

export const ROOMS: Room[] = ['kitchen', 'bedroom', 'bathroom', 'living room', 'dining room']

/**
 * What gives each room away, by the object model's (COCO) and the surface model's (ADE20K) names.
 * Weights say how sure a clue is: a toilet means bathroom, a sink only hints at one.
 */
const CLUES: Record<Room, { objects: Record<string, number>; surfaces: Record<string, number> }> = {
  kitchen: {
    objects: { refrigerator: 3, oven: 3, microwave: 2, toaster: 2, sink: 1 },
    surfaces: { refrigerator: 3, stove: 3, oven: 3, 'kitchen island': 3, dishwasher: 3, hood: 2, microwave: 2, countertop: 1, sink: 1 },
  },
  bedroom: {
    objects: { bed: 3 },
    surfaces: { bed: 3, wardrobe: 2, pillow: 1 },
  },
  bathroom: {
    objects: { toilet: 3, sink: 1 },
    surfaces: { toilet: 3, bathtub: 3, shower: 3, mirror: 1, sink: 1 },
  },
  'living room': {
    objects: { couch: 3, tv: 2 },
    surfaces: { sofa: 3, 'television receiver': 2, fireplace: 2, 'coffee table': 2, armchair: 1, cushion: 1 },
  },
  'dining room': {
    objects: { 'dining table': 2 },
    surfaces: { table: 1 },
  },
}

/** The thing to walk toward when looking for each room. */
const LANDMARK_NAMES: Record<string, string> = {
  refrigerator: 'fridge',
  'television receiver': 'TV',
  tv: 'TV',
  'kitchen island': 'kitchen counter',
  countertop: 'counter',
  couch: 'sofa',
}

export interface Sighting {
  frame: { objects: DetectResult | null; surfaces: SegmentResult | null }
  objectNames: string[]
  surfaceNames: string[]
}

/** Below this score the view doesn't say which room it is (e.g. a blank wall or a hallway). */
const MIN_SCORE = 1

/** The room the camera is most likely looking at, or null if nothing in view gives it away. */
export function guessRoom({ frame, objectNames, surfaceNames }: Sighting): Room | null {
  const shares = surfaceShares(frame.surfaces)
  let best: Room | null = null
  let bestScore = MIN_SCORE
  for (const room of ROOMS) {
    const clues = CLUES[room]
    let score = 0
    for (const d of frame.objects?.detections ?? []) {
      const weight = clues.objects[objectNames[d.classId]]
      if (weight) score += weight * Math.max(d.score, 0.3)
    }
    // A surface counts once it covers 2% of the view, and more as it fills it.
    for (const [classId, share] of shares) {
      const weight = clues.surfaces[surfaceNames[classId]]
      if (weight && share > 0.02) score += weight * Math.min(1, share * 10)
    }
    if (score > bestScore) {
      best = room
      bestScore = score
    }
  }
  return best
}

export interface Landmark {
  /** What to call it out loud, e.g. "fridge". */
  name: string
  side: Side
  /** Close enough to count as having reached the room. */
  near: boolean
}

/** The most telling thing in view that belongs to `room`, and where it is. */
export function findLandmark({ frame, objectNames, surfaceNames }: Sighting, room: Room): Landmark | null {
  const clues = CLUES[room]
  let best: (Landmark & { weight: number }) | null = null
  const consider = (name: string, weight: number, cx: number, size: number, nearAt: number) => {
    if (best && weight * size <= best.weight) return
    const side: Side = cx < 0.33 ? 'left' : cx > 0.67 ? 'right' : 'ahead'
    best = { name: LANDMARK_NAMES[name] ?? name, side, near: size >= nearAt, weight: weight * size }
  }
  const objects = frame.objects
  if (objects) {
    for (const d of objects.detections) {
      const name = objectNames[d.classId]
      const weight = clues.objects[name]
      if (!weight || d.score < 0.3) continue
      const [x1, y1, x2, y2] = d.box
      consider(name, weight, (x1 + x2) / 2 / objects.width, (y2 - y1) / objects.height, 0.55)
    }
  }
  if (frame.surfaces) {
    for (const [classId, { share, cx }] of surfaceCentroids(frame.surfaces)) {
      const name = surfaceNames[classId]
      const weight = clues.surfaces[name]
      if (weight && weight >= 2 && share > 0.02) consider(name, weight, cx, share * 2, 0.4)
    }
  }
  return best
}

/** Phrases a landmark as a direction: "Fridge ahead." or "Fridge on your left." */
export function landmarkPhrase(l: Landmark): string {
  const name = l.name.charAt(0).toUpperCase() + l.name.slice(1)
  return l.side === 'ahead' ? `${name} ahead.` : `${name} on your ${l.side}.`
}

/** Whether a door is in the middle of the view: a hint when looking for another room. */
export function doorAhead(seg: SegmentResult | null, surfaceNames: string[]): Side | null {
  if (!seg) return null
  for (const [classId, { share, cx }] of surfaceCentroids(seg)) {
    const name = surfaceNames[classId]
    if ((name === 'door' || name === 'screen door') && share > 0.04) return cx < 0.33 ? 'left' : cx > 0.67 ? 'right' : 'ahead'
  }
  return null
}

function surfaceShares(seg: SegmentResult | null): Map<number, number> {
  const out = new Map<number, number>()
  if (!seg) return out
  for (const [id, { share }] of surfaceCentroids(seg)) out.set(id, share)
  return out
}

/** Share of the view and horizontal centre (0 to 1) of every class in the label map. */
function surfaceCentroids(seg: SegmentResult): Map<number, { share: number; cx: number }> {
  const { labels, labelWidth: w } = seg
  const count = new Float64Array(256)
  const sumX = new Float64Array(256)
  for (let i = 0; i < labels.length; i++) {
    count[labels[i]]++
    sumX[labels[i]] += i % w
  }
  const out = new Map<number, { share: number; cx: number }>()
  for (let id = 0; id < 256; id++) {
    if (count[id]) out.set(id, { share: count[id] / labels.length, cx: sumX[id] / count[id] / w })
  }
  return out
}

/** Matches a spoken or typed room: "where is the kitchen" → kitchen. */
export function parseRoom(text: string): Room | 'where am i' | null {
  const t = text.toLowerCase()
  if (/\bwhere am i\b|\bwhich room\b|\bwhat room\b/.test(t)) return 'where am i'
  if (/\bkitchen\b|\bcook/.test(t)) return 'kitchen'
  if (/\bbed ?room\b|\bbed\b|\bsleep/.test(t)) return 'bedroom'
  if (/\bbath ?room\b|\btoilet\b|\bwashroom\b|\brest ?room\b|\bshower\b/.test(t)) return 'bathroom'
  if (/\bliving ?room\b|\bhall\b|\blounge\b|\bsofa\b|\btv\b|\btelevision\b/.test(t)) return 'living room'
  if (/\bdining\b/.test(t)) return 'dining room'
  return null
}
