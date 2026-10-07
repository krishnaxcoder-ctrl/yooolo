export interface LatLng {
  lat: number
  lng: number
}

export interface Step {
  /** The maneuver that starts this step, e.g. "Turn left onto MG Rd". */
  instruction: string
  /** Extra detail Google adds, e.g. "Pass by the petrol pump (on the left in 2.6 km)". */
  detail: string
  maneuver: string
  points: LatLng[]
  /** Distance along this step's points from its start, one entry per point. */
  along: number[]
  length: number
}

export interface Route {
  steps: Step[]
  path: LatLng[]
  length: number
  seconds: number
  start: LatLng
  end: LatLng
}

export type Place = string | LatLng

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
const MISSING_KEY = 'The Google Maps key is missing. Add VITE_GOOGLE_MAPS_API_KEY to .env.local and restart the dev server.'

const FIELDS = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.legs.startLocation',
  'routes.legs.endLocation',
  'routes.legs.steps.polyline.encodedPolyline',
  'routes.legs.steps.navigationInstruction',
].join(',')

interface ApiLatLng {
  latLng: { latitude: number; longitude: number }
}
interface ApiRoute {
  distanceMeters: number
  duration: string
  legs: {
    startLocation: ApiLatLng
    endLocation: ApiLatLng
    steps: { polyline: { encodedPolyline: string }; navigationInstruction?: { maneuver?: string; instructions?: string } }[]
  }[]
}

const waypoint = (p: Place) =>
  typeof p === 'string' ? { address: p } : { location: { latLng: { latitude: p.lat, longitude: p.lng } } }
const toLatLng = (p: ApiLatLng): LatLng => ({ lat: p.latLng.latitude, lng: p.latLng.longitude })

/** Asks the Routes API for a driving route with turn-by-turn steps. */
export async function findRoute(from: Place, to: Place): Promise<Route> {
  if (!API_KEY) throw new Error(MISSING_KEY)
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': API_KEY, 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify({
      origin: waypoint(from),
      destination: waypoint(to),
      travelMode: 'DRIVE',
      // Bias place names toward India, so "Panvel" means the one in Maharashtra.
      regionCode: 'IN',
      languageCode: 'en-IN',
      units: 'METRIC',
    }),
  })
  const body = (await res.json()) as { routes?: ApiRoute[]; error?: { message: string } }
  if (!res.ok) throw new Error(`Google couldn’t plan the route: ${body.error?.message ?? res.status}`)
  const route = body.routes?.[0]
  if (!route) throw new Error('No driving route was found between those places. Try saying the city or area more fully.')

  const leg = route.legs[0]
  const steps = route.legs
    .flatMap((l) => l.steps)
    .map((s): Step => {
      const points = decodePolyline(s.polyline.encodedPolyline)
      const along = cumulative(points)
      const [instruction = '', ...rest] = (s.navigationInstruction?.instructions ?? '').split('\n')
      const maneuver = s.navigationInstruction?.maneuver ?? 'STRAIGHT'
      return {
        instruction: instruction || MANEUVER_TEXT[maneuver] || 'Continue',
        detail: rest.join(' '),
        maneuver,
        points,
        along,
        length: along[along.length - 1] ?? 0,
      }
    })
    .filter((s) => s.points.length > 0)
  return {
    steps,
    path: steps.flatMap((s) => s.points),
    length: steps.reduce((sum, s) => sum + s.length, 0),
    seconds: parseInt(route.duration, 10) || 0,
    start: toLatLng(leg.startLocation),
    end: toLatLng(route.legs[route.legs.length - 1].endLocation),
  }
}

const MANEUVER_TEXT: Record<string, string> = {
  DEPART: 'Start driving',
  STRAIGHT: 'Go straight',
  TURN_LEFT: 'Turn left',
  TURN_RIGHT: 'Turn right',
  TURN_SLIGHT_LEFT: 'Bear left',
  TURN_SLIGHT_RIGHT: 'Bear right',
  TURN_SHARP_LEFT: 'Turn sharp left',
  TURN_SHARP_RIGHT: 'Turn sharp right',
  UTURN_LEFT: 'Make a U-turn',
  UTURN_RIGHT: 'Make a U-turn',
  RAMP_LEFT: 'Take the ramp on the left',
  RAMP_RIGHT: 'Take the ramp on the right',
  FORK_LEFT: 'Keep left at the fork',
  FORK_RIGHT: 'Keep right at the fork',
  MERGE: 'Merge',
  ROUNDABOUT_LEFT: 'Take the roundabout',
  ROUNDABOUT_RIGHT: 'Take the roundabout',
  ROUNDABOUT_COUNTERCLOCKWISE: 'Take the roundabout',
  ROUNDABOUT_CLOCKWISE: 'Take the roundabout',
  FERRY: 'Take the ferry',
  NAME_CHANGE: 'Continue',
}

/** Decodes Google's encoded polyline format. */
function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = []
  let i = 0
  let lat = 0
  let lng = 0
  const next = () => {
    let result = 0
    let shift = 0
    let byte: number
    do {
      byte = encoded.charCodeAt(i++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    return result & 1 ? ~(result >> 1) : result >> 1
  }
  while (i < encoded.length) {
    lat += next()
    lng += next()
    points.push({ lat: lat / 1e5, lng: lng / 1e5 })
  }
  return points
}

/** Great-circle distance in metres. */
export function distance(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(h))
}

function cumulative(points: LatLng[]): number[] {
  const out = [0]
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + distance(points[i - 1], points[i]))
  return out
}

/** Where the driver is along the route. `step` is the step being driven; its end is the next maneuver. */
export interface Progress {
  step: number
  /** Metres left on the current step, i.e. until the next maneuver. */
  toManeuver: number
  position: LatLng | null
  arrived: boolean
  /** Metres from the route when the driver isn't on it. */
  offRoute: number | null
}

export const START: Progress = { step: 0, toManeuver: 0, position: null, arrived: false, offRoute: null }

const OFF_ROUTE_M = 1000
const ARRIVED_M = 30

/** Snaps a GPS fix to the route, looking a few steps ahead so a missed fix can't strand the driver on an old step. */
export function trackPosition(route: Route, prev: Progress, position: LatLng): Progress {
  let best = { step: prev.step, point: 0, d: Infinity }
  for (let s = prev.step; s < Math.min(prev.step + 3, route.steps.length); s++) {
    route.steps[s].points.forEach((p, point) => {
      const d = distance(position, p)
      // `<=` so a shared junction point counts as the later step, i.e. the turn has been made.
      if (d <= best.d) best = { step: s, point, d }
    })
  }
  if (best.d > OFF_ROUTE_M) return { ...prev, position, offRoute: best.d }
  const step = route.steps[best.step]
  const toManeuver = step.length - step.along[best.point]
  const arrived = best.step === route.steps.length - 1 && distance(position, route.end) < ARRIVED_M
  return { step: best.step, toManeuver, position, arrived, offRoute: null }
}

/** Progress after driving `meters` from the start, for the simulated drive. */
export function progressAt(route: Route, meters: number): Progress {
  if (meters >= route.length) return { step: route.steps.length - 1, toManeuver: 0, position: route.end, arrived: true, offRoute: null }
  let start = 0
  for (let s = 0; s < route.steps.length; s++) {
    const step = route.steps[s]
    if (meters < start + step.length) {
      const into = meters - start
      const i = Math.max(1, step.along.findIndex((a) => a > into))
      const t = (into - step.along[i - 1]) / (step.along[i] - step.along[i - 1] || 1)
      const a = step.points[i - 1]
      const b = step.points[i]
      const position = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }
      return { step: s, toManeuver: step.length - into, position, arrived: false, offRoute: null }
    }
    start += step.length
  }
  return { step: route.steps.length - 1, toManeuver: 0, position: route.end, arrived: true, offRoute: null }
}

/** Metres left to the destination. */
export function remaining(route: Route, p: Progress): number {
  if (p.arrived) return 0
  return p.toManeuver + route.steps.slice(p.step + 1).reduce((sum, s) => sum + s.length, 0)
}

export function formatDistance(m: number, spoken = false): string {
  if (m < 1000) {
    const rounded = m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50
    return spoken ? `${rounded} metres` : `${rounded} m`
  }
  const km = m < 10000 ? (m / 1000).toFixed(1).replace(/\.0$/, '') : String(Math.round(m / 1000))
  return spoken ? `${km} kilometres` : `${km} km`
}

export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** An arrow for the maneuver. */
export function maneuverGlyph(maneuver: string): string {
  if (maneuver.startsWith('UTURN')) return '↶'
  if (maneuver.startsWith('ROUNDABOUT')) return '⟳'
  if (maneuver.includes('SLIGHT_LEFT') || maneuver.endsWith('FORK_LEFT') || maneuver === 'RAMP_LEFT') return '↖'
  if (maneuver.includes('SLIGHT_RIGHT') || maneuver.endsWith('FORK_RIGHT') || maneuver === 'RAMP_RIGHT') return '↗'
  if (maneuver.includes('LEFT')) return '←'
  if (maneuver.includes('RIGHT')) return '→'
  return '↑'
}

let mapsReady: Promise<void> | null = null

/** Loads the Google Maps JavaScript API once. */
export function loadMaps(): Promise<void> {
  if (!API_KEY) return Promise.reject(new Error(MISSING_KEY))
  mapsReady ??= new Promise<void>((resolve, reject) => {
    const callback = '__yoooloMapsReady'
    ;(window as unknown as Record<string, () => void>)[callback] = () => resolve()
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(API_KEY)}&loading=async&callback=${callback}&region=IN`
    script.async = true
    script.onerror = () => {
      mapsReady = null
      reject(new Error('Google Maps couldn’t load. Check your connection and that the Maps JavaScript API is enabled for the key.'))
    }
    document.head.append(script)
  })
  return mapsReady
}
