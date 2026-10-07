/**
 * Step counting and compass heading from the phone's sensors: enough to retrace a short walk
 * between rooms (pedestrian dead reckoning). It drifts over long distances; home routes are short.
 */

/** Total acceleration (m/s², gravity included) a step's bounce must rise above, then fall back under. */
const STEP_HIGH = 11.2
const STEP_LOW = 9.6
/** People don't take more than about three steps a second. */
const MIN_STEP_MS = 330

export interface MotionHandlers {
  onStep: () => void
  /** Compass heading in degrees, 0 = north, clockwise. */
  onHeading: (degrees: number) => void
}

/** Starts counting steps and reading the compass. Returns a function that stops. */
export function watchWalking({ onStep, onHeading }: MotionHandlers): () => void {
  let smoothed = 9.8
  let high = false
  let lastStep = -Infinity

  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity
    if (a?.x == null || a.y == null || a.z == null) return
    // A light low-pass filter keeps one bounce from reading as several steps.
    smoothed = smoothed * 0.75 + Math.hypot(a.x, a.y, a.z) * 0.25
    const now = e.timeStamp || performance.now()
    if (!high && smoothed > STEP_HIGH && now - lastStep > MIN_STEP_MS) {
      high = true
      lastStep = now
      onStep()
    } else if (high && smoothed < STEP_LOW) high = false
  }

  // iPhones report a true compass heading; Android Chrome reports absolute orientation separately.
  const onOrientation = (e: DeviceOrientationEvent) => {
    const ios = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading
    if (typeof ios === 'number') return onHeading(ios)
    if (e.absolute && e.alpha != null) onHeading((360 - e.alpha) % 360)
  }

  window.addEventListener('devicemotion', onMotion)
  window.addEventListener('deviceorientationabsolute', onOrientation as EventListener)
  window.addEventListener('deviceorientation', onOrientation)
  return () => {
    window.removeEventListener('devicemotion', onMotion)
    window.removeEventListener('deviceorientationabsolute', onOrientation as EventListener)
    window.removeEventListener('deviceorientation', onOrientation)
  }
}

/** The signed turn from `from` to `to`, in degrees: negative is left, positive is right. */
export function turnBetween(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180
}

/** Says a turn the way a person would. */
export function turnPhrase(degrees: number): string | null {
  const d = Math.abs(degrees)
  if (d < 30) return null
  if (d > 150) return 'Turn around'
  const side = degrees < 0 ? 'left' : 'right'
  return d < 60 ? `Turn slightly ${side}` : `Turn ${side}`
}

/** Averages headings properly across north, so 350° and 10° give 0°, not 180°. */
export function meanHeading(degrees: number[]): number {
  let x = 0
  let y = 0
  for (const d of degrees) {
    x += Math.cos((d * Math.PI) / 180)
    y += Math.sin((d * Math.PI) / 180)
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}
