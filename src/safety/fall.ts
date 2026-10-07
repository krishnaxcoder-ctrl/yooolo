/** Below this total acceleration (m/s², gravity included) the phone is in free fall. */
const FREE_FALL = 3
/** Above this it has hit something, or is being shaken hard (about 2.5 g). */
const IMPACT = 25
/** An impact this soon after free fall is a drop: the phone, and likely its owner, fell. */
const FALL_WINDOW_MS = 1000
/** This many hard jolts in a short time also count, so shaking the phone calls for help. */
const SHAKES = 4
const SHAKE_WINDOW_MS = 1500

/** Calls `onFall` when the motion sensor sees a fall, or hard shaking. Returns a function that stops watching. */
export function watchFalls(onFall: () => void): () => void {
  let freeFallAt = -Infinity
  let jolts: number[] = []
  let above = false

  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity
    if (a?.x == null || a.y == null || a.z == null) return
    const g = Math.hypot(a.x, a.y, a.z)
    const now = e.timeStamp || performance.now()
    if (g < FREE_FALL) freeFallAt = now

    // Count each jolt once, on the way up, however many sensor readings it spans.
    const rising = g > IMPACT && !above
    above = g > IMPACT
    if (!rising) return
    if (now - freeFallAt < FALL_WINDOW_MS) {
      freeFallAt = -Infinity
      jolts = []
      return onFall()
    }
    jolts = [...jolts.filter((t) => now - t < SHAKE_WINDOW_MS), now]
    if (jolts.length >= SHAKES) {
      jolts = []
      onFall()
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
