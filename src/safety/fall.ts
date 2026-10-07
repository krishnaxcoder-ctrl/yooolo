/**
 * Two ways to call for help with the motion sensor:
 * - A fall: the phone drops (free fall), hits something (impact), then mostly stays put.
 * - A deliberate hard shake: a couple of seconds of strong, continuous shaking.
 * Everyday handling sets off neither: a quick shake is too short, and putting the phone down has
 * no free fall.
 */

const GRAVITY = 9.81
/** Below this total acceleration (m/s², gravity included) the phone is falling. */
const FREE_FALL = 4
/** Free fall must last this long: a drop of about 7 cm. Shaking dips below for an instant at most. */
const FREE_FALL_MS = 120
/** The landing: about 2.5 g. */
const IMPACT = 24
/** The impact must come this soon after the fall ends. */
const IMPACT_WINDOW_MS = 1000
/** After landing, wait out the bounce, then check the phone has mostly settled. */
const SETTLE_MS = 300
const STILL_MS = 1000
const STILL_WOBBLE = 3.5

/**
 * A jolt is a swing above JOLT (about 2.5 g; phones whose sensors top out at 2 g per axis still
 * reach it across axes), counted again only after dropping back under JOLT_RESET. This many jolts
 * within the window is a deliberate shake, not a casual one.
 */
const JOLT = 24
const JOLT_RESET = 16
const SHAKE_JOLTS = 7
const SHAKE_WINDOW_MS = 2500

type Stage =
  | { kind: 'idle' }
  | { kind: 'falling'; since: number }
  | { kind: 'fell'; at: number }
  | { kind: 'landed'; at: number; wobble: number; samples: number }

/** Calls `onFall` on a fall or a deliberate hard shake. Returns a function that stops watching. */
export function watchFalls(onFall: () => void): () => void {
  let stage: Stage = { kind: 'idle' }
  let jolts: number[] = []
  let inJolt = false

  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity
    if (a?.x == null || a.y == null || a.z == null) return
    const g = Math.hypot(a.x, a.y, a.z)
    const now = e.timeStamp || performance.now()

    if (!inJolt && g > JOLT) {
      inJolt = true
      jolts = [...jolts.filter((t) => now - t < SHAKE_WINDOW_MS), now]
      if (jolts.length >= SHAKE_JOLTS) {
        jolts = []
        stage = { kind: 'idle' }
        return onFall()
      }
    } else if (inJolt && g < JOLT_RESET) inJolt = false

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
        const settled = stage.wobble / stage.samples < STILL_WOBBLE
        stage = { kind: 'idle' }
        if (settled) onFall()
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
