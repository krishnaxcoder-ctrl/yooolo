import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { DetectResult } from '../yolo/types'
import { buzz, findHazards, HazardAnnouncer, hazardPhrase } from './hazards'
import {
  findRoute,
  formatDistance,
  formatDuration,
  loadMaps,
  maneuverGlyph,
  progressAt,
  remaining,
  START,
  trackPosition,
  type LatLng,
  type Progress,
  type Route,
} from './route'
import { hush, say, speaking, type TripRequest } from './voice'

type Plan =
  | { kind: 'locating' }
  | { kind: 'routing' }
  | { kind: 'ready'; route: Route }
  | { kind: 'error'; message: string }

/** `overview` shows the whole route; `live` follows GPS; `sim` drives the route at speed as a preview. */
type Mode = 'overview' | 'live' | 'sim'

const SIM_TICK_MS = 200
const ANNOUNCE_AHEAD_M = 300
const ANNOUNCE_NOW_M = 50
const LONG_STEP_M = 2000

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

function currentPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser can’t find your location. Say where you’re starting from, like “Panvel to Pune”.'))
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error('Your location isn’t available. Allow location access, or say where you’re starting from, like “Panvel to Pune”.')),
      { enableHighAccuracy: true, timeout: 15000 },
    )
  })
}

function turnPhrase(route: Route, i: number): string {
  const step = route.steps[i]
  return step.length >= LONG_STEP_M
    ? `${step.instruction}, then go ahead for ${formatDistance(step.length, true)}.`
    : `${step.instruction}.`
}

interface NavigationProps {
  trip: TripRequest
  onClose: () => void
  /** The live camera view, shown full screen with the map inset (or the other way round). */
  camera: ReactNode
  /** The latest object detections from the camera, used for spoken obstacle warnings. */
  detections: DetectResult | null
  names: string[]
}

export function Navigation({ trip, onClose, camera, detections, names }: NavigationProps) {
  const [plan, setPlan] = useState<Plan>({ kind: trip.from ? 'routing' : 'locating' })
  const [mode, setMode] = useState<Mode>('overview')
  const [progress, setProgress] = useState<Progress>(START)
  const [muted, setMuted] = useState(false)
  const [follow, setFollow] = useState(true)
  const [main, setMain] = useState<'camera' | 'map'>('camera')
  const [sheetHeight, setSheetHeight] = useState(140)
  const sheet = useRef<HTMLDivElement>(null)
  const announcer = useRef(new HazardAnnouncer())
  const [notice, setNotice] = useState<string | null>(null)
  const mapEl = useRef<HTMLDivElement>(null)
  const map = useRef<{ map: google.maps.Map; user: google.maps.Marker; bounds: google.maps.LatLngBounds } | null>(null)
  const spoken = useRef(new Set<string>())
  const route = plan.kind === 'ready' ? plan.route : null

  // Plan the route, starting from the current location when no start was said.
  useEffect(() => {
    let stale = false
    ;(async () => {
      const origin = trip.from ?? (await currentPosition())
      if (stale) return
      setPlan({ kind: 'routing' })
      const route = await findRoute(origin, trip.to)
      if (!stale) setPlan({ kind: 'ready', route })
    })().catch((err: Error) => !stale && setPlan({ kind: 'error', message: err.message }))
    return () => {
      stale = true
    }
  }, [trip])

  // Draw the map once the route is known.
  useEffect(() => {
    if (!route || !mapEl.current) return
    const el = mapEl.current
    let stale = false
    ;(async () => {
      await loadMaps()
      const { Map, Polyline } = (await google.maps.importLibrary('maps')) as google.maps.MapsLibrary
      const { Marker } = (await google.maps.importLibrary('marker')) as google.maps.MarkerLibrary
      const { LatLngBounds } = (await google.maps.importLibrary('core')) as google.maps.CoreLibrary
      if (stale) return
      const m = new Map(el, { disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false })
      const bounds = new LatLngBounds()
      route.path.forEach((p) => bounds.extend(p))
      m.fitBounds(bounds, 48)
      // A dark casing under a yellow line reads on both the road map and satellite-like tiles.
      new Polyline({ map: m, path: route.path, strokeColor: '#18212b', strokeWeight: 9, strokeOpacity: 0.9 })
      new Polyline({ map: m, path: route.path, strokeColor: '#f2c230', strokeWeight: 5, strokeOpacity: 1 })
      new Marker({ map: m, position: route.start, label: { text: 'A', fontWeight: '700' }, title: trip.from ?? 'Your location' })
      new Marker({ map: m, position: route.end, label: { text: 'B', fontWeight: '700' }, title: trip.to })
      const user = new Marker({
        zIndex: 10,
        title: 'You',
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#1a73e8', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3 },
      })
      m.addListener('dragstart', () => setFollow(false))
      map.current = { map: m, user, bounds }
    })().catch((err: Error) => !stale && setPlan({ kind: 'error', message: err.message }))
    return () => {
      stale = true
      map.current = null
    }
  }, [route, trip])

  // Follow GPS while navigating live.
  useEffect(() => {
    if (!route || mode !== 'live') return
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setNotice(null)
        setProgress((prev) => trackPosition(route, prev, { lat: p.coords.latitude, lng: p.coords.longitude }))
      },
      () => setNotice('Your location isn’t available. Allow location access, or select Simulate drive to preview the route.'),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [route, mode])

  // Drive the route at speed, finishing any trip in about two and a half minutes.
  useEffect(() => {
    if (!route || mode !== 'sim') return
    const speed = Math.min(400, Math.max(25, route.length / 150))
    let meters = 0
    const id = setInterval(() => {
      meters += (speed * SIM_TICK_MS) / 1000
      const next = progressAt(route, meters)
      setProgress(next)
      if (next.arrived) clearInterval(id)
    }, SIM_TICK_MS)
    return () => clearInterval(id)
  }, [route, mode])

  // Speak each maneuver once: a heads-up a few hundred metres out, then again at the turn.
  useEffect(() => {
    if (!route || mode === 'overview') return
    const once = (key: string, text: string) => {
      if (spoken.current.has(key)) return
      spoken.current.add(key)
      if (!muted) say(text)
    }
    if (progress.arrived) return once('arrived', `You have arrived at ${trip.to}.`)
    const s = progress.step
    once(`turn:${s}`, s === 0 ? `Starting route to ${trip.to}. ${turnPhrase(route, 0)}` : turnPhrase(route, s))
    const next = route.steps[s + 1]
    if (!next || progress.position === null) return
    if (progress.toManeuver <= ANNOUNCE_NOW_M) once(`turn:${s + 1}`, turnPhrase(route, s + 1))
    else if (progress.toManeuver <= ANNOUNCE_AHEAD_M && route.steps[s].length > ANNOUNCE_AHEAD_M + 100) {
      once(`ahead:${s}`, `In ${formatDistance(progress.toManeuver, true)}, ${lowerFirst(next.instruction)}.`)
    }
  }, [route, mode, progress, muted, trip.to])

  // Warn about obstacles the camera sees, between directions rather than over them.
  const hazards = detections ? findHazards(detections, names) : []
  useEffect(() => {
    if (mode === 'overview' || !detections || speaking()) return
    const h = announcer.current.pick(findHazards(detections, names))
    if (!h) return
    if (!muted) say(hazardPhrase(h))
    buzz(h)
  }, [detections, names, mode, muted])

  // The inset sits just above the bottom sheet, whose height changes with its content.
  useEffect(() => {
    const el = sheet.current
    if (!el) return
    const observer = new ResizeObserver(() => setSheetHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Move the blue dot, and keep it centred unless the driver has panned away.
  useEffect(() => {
    const m = map.current
    if (!m) return
    m.user.setPosition(progress.position)
    m.user.setMap(progress.position ? m.map : null)
    if (progress.position && follow && mode !== 'overview') m.map.panTo(progress.position)
  }, [progress.position, follow, mode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      hush()
    }
  }, [onClose])

  function start(next: Mode) {
    spoken.current.clear()
    announcer.current.reset()
    setProgress(START)
    setNotice(null)
    setFollow(true)
    setMode(next)
    map.current?.map.setZoom(16)
    if (next === 'live' && route) map.current?.map.panTo(route.start)
  }

  function stop() {
    hush()
    setMode('overview')
    setProgress(START)
    setNotice(null)
    if (map.current) map.current.map.fitBounds(map.current.bounds, 48)
  }

  function recenter() {
    setFollow(true)
    if (progress.position) map.current?.map.panTo(progress.position)
  }

  function toggleMute() {
    if (!muted) hush()
    setMuted(!muted)
  }

  const navigating = mode !== 'overview'
  const left = route ? remaining(route, progress) : 0
  const next = route && navigating ? route.steps[progress.step + 1] : null

  let banner: { glyph: string; distance?: string; text: string; detail?: string }
  if (plan.kind === 'locating') banner = { glyph: '◌', text: 'Finding your location…' }
  else if (plan.kind === 'routing') banner = { glyph: '◌', text: `Finding the way to ${trip.to}…` }
  else if (plan.kind === 'error') banner = { glyph: '!', text: 'No route', detail: plan.message }
  else if (progress.arrived) banner = { glyph: '◎', text: 'You have arrived', detail: trip.to }
  else if (!navigating) {
    const first = plan.route.steps[0]
    banner = { glyph: maneuverGlyph(first.maneuver), text: first.instruction, detail: 'Select Start to begin turn-by-turn directions.' }
  } else if (next) {
    banner = { glyph: maneuverGlyph(next.maneuver), distance: formatDistance(progress.toManeuver), text: next.instruction, detail: next.detail }
  } else banner = { glyph: '◎', distance: formatDistance(progress.toManeuver), text: `Arrive at ${trip.to}` }

  return (
    <div
      className="nav"
      role="dialog"
      aria-modal="true"
      aria-label={`Directions to ${trip.to}`}
      data-main={main}
      style={{ '--sheet-height': `${sheetHeight}px` } as CSSProperties}
    >
      <div className="nav-pane nav-camera">
        {camera}
        {hazards.length > 0 && (
          <p className="nav-hazard" data-near={hazards[0].near ? '' : undefined}>
            {hazardPhrase(hazards[0])}
          </p>
        )}
      </div>
      <div className="nav-pane nav-map" ref={mapEl} />

      <div className="nav-banner" role="status" data-tone={plan.kind === 'error' ? 'error' : undefined}>
        <span className="nav-glyph" aria-hidden="true">
          {banner.glyph}
        </span>
        <div className="nav-instruction">
          {banner.distance && <span className="nav-distance">{banner.distance}</span>}
          <span className="nav-text">{banner.text}</span>
          {banner.detail && <span className="nav-detail">{banner.detail}</span>}
        </div>
      </div>

      {navigating && !follow && main === 'map' && (
        <button type="button" className="button nav-recenter" onClick={recenter}>
          Re-centre
        </button>
      )}

      <div className="nav-sheet" ref={sheet}>
        <div className="nav-trip">
          <p className="nav-route">
            {trip.from ?? 'Your location'} <span aria-hidden="true">→</span>
            <span className="visually-hidden">to</span> {trip.to}
          </p>
          {route && (
            <p className="nav-meta">
              {progress.arrived
                ? 'Trip complete'
                : `${formatDistance(left)} · ${formatDuration((left / (route.length || 1)) * route.seconds)}`}
              {mode === 'sim' && ' · Simulated drive'}
            </p>
          )}
          {progress.offRoute !== null && (
            <p className="nav-note">
              You’re {formatDistance(progress.offRoute)} from this route. Directions begin when you reach it, or select
              Simulate drive to preview them.
            </p>
          )}
          {notice && <p className="nav-note">{notice}</p>}
        </div>
        <div className="actions">
          {route && !navigating && (
            <>
              <button type="button" className="button nav-go" onClick={() => start('live')}>
                Start
              </button>
              <button type="button" className="button" onClick={() => start('sim')}>
                Simulate drive
              </button>
            </>
          )}
          {navigating && (
            <>
              <button type="button" className="button" onClick={stop}>
                {progress.arrived ? 'Done' : 'Stop'}
              </button>
              <button type="button" className="button" aria-pressed={muted} onClick={toggleMute}>
                {muted ? 'Unmute voice' : 'Mute voice'}
              </button>
            </>
          )}
          <button type="button" className="button" onClick={() => setMain(main === 'camera' ? 'map' : 'camera')}>
            {main === 'camera' ? 'Big map' : 'Big camera'}
          </button>
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
