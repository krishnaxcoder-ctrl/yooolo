/**
 * A fall, as the motion sensor sees it: the phone drops (free fall), hits the ground (impact), then
 * lies still. Each stage rules out everyday handling: shaking only touches free fall for an instant
 * and never lies still, and putting the phone down has no free fall.
 */

const GRAVITY = 9.81
/** Below this total acceleration (m/s², gravity included) the phone is falling. */
const FREE_FALL = 3
/** Free fall must last this long: about a 10 cm drop. Shaking dips below for a few milliseconds at most. */
const FREE_FALL_MS = 150
/** The landing: about 3 g. */
const IMPACT = 30
/** The impact must come this soon after the fall ends. */
const IMPACT_WINDOW_MS = 1000
/** After landing, wait this long, then require the phone to have stayed this close to plain gravity. */
const SETTLE_MS = 300
const STILL_MS = 1200
const STILL_WOBBLE = 2

type Stage =
  | { kind: 'idle' }
  | { kind: 'falling'; since: number }
  | { kind: 'fell'; at: number }
  | { kind: 'landed'; at: number; wobble: number; samples: number }

/** Calls `onFall` when the motion sensor sees a fall. Returns a function that stops watching. */
export function watchFalls(onFall: () => void): () => void {
  let stage: Stage = { kind: 'idle' }

  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity
    if (a?.x == null || a.y == null || a.z == null) return
    const g = Math.hypot(a.x, a.y, a.z)
    const now = e.timeStamp || performance.now()

    switch (stage.kind) {
      case 'idle':
        if (g < FREE_FALL) stage = { kind: 'falling', since: now }
        break
      case 'falling':
        if (g < FREE_FALL) break
        if (now - stage.since < FREE_FALL_MS) {
          stage = { kind: 'idle' }
          break
        }
        // The reading that ends the fall is usually the impact itself.
        stage = g > IMPACT ? { kind: 'landed', at: now, wobble: 0, samples: 0 } : { kind: 'fell', at: now }
        break
      case 'fell':
        if (g > IMPACT) stage = { kind: 'landed', at: now, wobble: 0, samples: 0 }
        else if (now - stage.at > IMPACT_WINDOW_MS) stage = { kind: 'idle' }
        break
      case 'landed': {
        const since = now - stage.at
        if (since < SETTLE_MS) break // the bounce
        stage.wobble += Math.abs(g - GRAVITY)
        stage.samples++
        if (since < SETTLE_MS + STILL_MS) break
        const still = stage.wobble / stage.samples < STILL_WOBBLE
        stage = { kind: 'idle' }
        if (still) onFall()
        break
      }
    }
  }

  window.addEventListener('devicemotion', onMotion)
  return () => window.removeEventListener('devicemotion', onMotion)
}

type MotionPermission = { requestPermission?: () => Promise<'granted' | 'denied'> }

/**
 * iPhones only report motion after the user allows it, and only ask in response to a tap. This
 * asks on the first tap anywhere; other browsers report motion without asking.
 */
export function askForMotionOnFirstTap(): () => void {
  const Motion = (window as unknown as { DeviceMotionEvent?: MotionPermission }).DeviceMotionEvent
  if (typeof Motion?.requestPermission !== 'function') return () => {}
  const ask = () => {
    Motion.requestPermission?.().catch(() => {})
    window.removeEventListener('pointerdown', ask)
  }
  window.addEventListener('pointerdown', ask)
  return () => window.removeEventListener('pointerdown', ask)
}
