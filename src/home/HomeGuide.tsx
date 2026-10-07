import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { allHazards, HazardAnnouncer, hazardPhrase } from '../navigation/hazards'
import { useVoiceReply } from '../navigation/useVoiceReply'
import { hush, say, speaking } from '../navigation/voice'
import type { DetectResult, SegmentResult } from '../yolo/types'
import { turnBetween, turnPhrase, watchWalking } from './pdr'
import { doorAhead, findLandmark, guessRoom, landmarkPhrase, parseRoom, ROOMS, type Room, type Sighting } from './rooms'
import { deleteRoute, legsFromSteps, loadRoutes, routeTo, saveRoute, type HomeRoute } from './routes'

type Mode =
  | { kind: 'ask' }
  | { kind: 'where' }
  | { kind: 'find'; room: Room }
  | { kind: 'teach-pick' }
  | { kind: 'teach'; from: Room | null; to: Room }
  | { kind: 'follow'; route: HomeRoute; leg: number; stepsLeft: number; walking: boolean }

/** How many recent frames vote on which room this is, and how many must agree. */
const ROOM_VOTES = 10
const ROOM_QUORUM = 6
/** How often the same guidance may repeat while searching. */
const LANDMARK_REPEAT_MS = 4000
const SEARCH_HINT_MS = 9000
/** Facing within this many degrees of a leg's heading counts as lined up. */
const ON_COURSE_DEG = 25
/** Without a compass, give the user this long to make a turn before saying to walk. */
const BLIND_TURN_MS = 3000
/** On-screen turns for laptops and phones without a compass. */
const MANUAL_TURN_DEG = 90

const roomLabel = (r: Room) => r.charAt(0).toUpperCase() + r.slice(1)
const stepsPhrase = (n: number) => `${n} step${n === 1 ? '' : 's'}`

interface HomeGuideProps {
  onClose: () => void
  camera: ReactNode
  objects: DetectResult | null
  surfaces: SegmentResult | null
  objectNames: string[]
  surfaceNames: string[]
  stairClasses: readonly number[]
}

/** Indoor guidance: which room you're in, finding a room by sight, and following routes taught by family. */
export function HomeGuide({ onClose, camera, objects, surfaces, objectNames, surfaceNames, stairClasses }: HomeGuideProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'ask' })
  const [asked, setAsked] = useState(false)
  const [room, setRoom] = useState<Room | null>(null)
  const [routes, setRoutes] = useState(loadRoutes)
  const [hasMotion, setHasMotion] = useState(false)
  const [hasCompass, setHasCompass] = useState(false)
  const [taught, setTaught] = useState<number[]>([])
  const [status, setStatus] = useState('')
  const votes = useRef<(Room | null)[]>([])
  const heading = useRef(0)
  const said = useRef<{ text: string; at: number }>({ text: '', at: -Infinity })
  const announcer = useRef(new HazardAnnouncer())
  const blindTurn = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const step = useRef<() => void>(() => {})

  const sighting: Sighting = { frame: { objects, surfaces }, objectNames, surfaceNames }

  /** Says `text`, unless the same thing was said within `repeatMs`. */
  function tell(text: string, repeatMs = 0) {
    const now = performance.now()
    if (said.current.text === text && now - said.current.at < repeatMs) return
    said.current = { text, at: now }
    setStatus(text)
    say(text)
  }

  // Ask once on opening, then listen for a room.
  useEffect(() => {
    say('Which room do you want to go to? Or ask, where am I.', () => setAsked(true))
    const fallback = setTimeout(() => setAsked(true), 6000)
    return () => {
      clearTimeout(fallback)
      clearTimeout(blindTurn.current)
      hush()
    }
  }, [])

  const { heard, blocked } = useVoiceReply(mode.kind === 'ask' && asked, (text) => {
    const choice = parseRoom(text)
    if (!choice) return false
    choose(choice)
    return true
  })

  // Steps and compass. Laptops have neither, so the screen offers buttons to act them out.
  useEffect(
    () =>
      watchWalking({
        onStep: () => {
          setHasMotion(true)
          step.current()
        },
        onHeading: (degrees) => {
          heading.current = degrees
          setHasCompass(true)
        },
      }),
    [],
  )

  // Vote on the room across recent frames, so one odd frame doesn't change the answer.
  useEffect(() => {
    if (!objects && !surfaces) return
    votes.current = [...votes.current, guessRoom({ frame: { objects, surfaces }, objectNames, surfaceNames })].slice(-ROOM_VOTES)
    const counts = new Map<Room, number>()
    for (const v of votes.current) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
    const [top] = [...counts].sort((a, b) => b[1] - a[1])
    // oxlint-disable-next-line react/set-state-in-effect
    if (top && top[1] >= ROOM_QUORUM) setRoom(top[0])
  }, [objects, surfaces, objectNames, surfaceNames])

  // Say the room whenever it changes, unless a route is being followed or taught.
  useEffect(() => {
    if (!room || mode.kind === 'follow' || mode.kind === 'teach' || mode.kind === 'teach-pick') return
    if (mode.kind === 'find' && mode.room === room) return
    tell(`You are in the ${room}.`)
    // tell() only reads refs and setters.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [room, mode.kind])

  // Searching by sight: walk toward what gives the room away, or toward a door.
  useEffect(() => {
    if (mode.kind !== 'find' || (!objects && !surfaces)) return
    const target = mode.room
    const landmark = findLandmark(sighting, target)
    if (room === target || landmark?.near) {
      tell(`You have reached the ${target}.`)
      setMode({ kind: 'where' })
      return
    }
    if (speaking()) return
    if (landmark) return tell(`${landmarkPhrase(landmark)} Walk toward it.`, LANDMARK_REPEAT_MS)
    const door = doorAhead(surfaces, surfaceNames)
    if (door) return tell(door === 'ahead' ? 'Door ahead.' : `Door on your ${door}.`, LANDMARK_REPEAT_MS)
    tell(`Turn slowly. I will tell you when I see the ${target}.`, SEARCH_HINT_MS)
    // tell() and sighting only read the props listed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [objects, surfaces, mode, room])

  // Close obstacles (stairs, people, furniture underfoot) are worth a warning on any route.
  useEffect(() => {
    if ((mode.kind !== 'find' && mode.kind !== 'follow') || speaking()) return
    const close = allHazards(objects, objectNames, surfaces, stairClasses).filter((h) => h.near)
    const h = announcer.current.pick(close)
    if (h) say(hazardPhrase(h))
  }, [objects, surfaces, objectNames, stairClasses, mode.kind])

  // Following a route: face each leg's heading, then count its steps down.
  const following = mode.kind === 'follow' ? mode : null
  useEffect(() => {
    if (!following || following.walking) return
    const { route, leg } = following
    const target = route.legs[leg].heading
    const startWalking = () => {
      setMode((m) => (m.kind === 'follow' && m.leg === leg ? { ...m, walking: true } : m))
      tell(`Walk ${stepsPhrase(route.legs[leg].steps)} forward.`)
    }
    // With a compass, turn relative to where the user faces now; without, relative to the last leg.
    const turn = hasCompass
      ? turnBetween(heading.current, target)
      : leg === 0
        ? 0
        : turnBetween(route.legs[leg - 1].heading, target)
    const phrase = turnPhrase(turn)
    if (!phrase) return startWalking()
    tell(`${phrase}.`)
    if (!hasCompass) {
      blindTurn.current = setTimeout(startWalking, BLIND_TURN_MS)
      return () => clearTimeout(blindTurn.current)
    }
    const id = setInterval(() => {
      if (Math.abs(turnBetween(heading.current, target)) < ON_COURSE_DEG) {
        clearInterval(id)
        startWalking()
      }
    }, 250)
    return () => clearInterval(id)
    // tell() only reads refs and setters.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [following?.route, following?.leg, following?.walking, hasCompass])

  // What a step means depends on the mode: count it down, or record it.
  useEffect(() => {
    step.current = () => {
      if (mode.kind === 'teach') {
        setTaught((t) => [...t, heading.current])
        return
      }
      if (mode.kind !== 'follow' || !mode.walking) return
      const left = mode.stepsLeft - 1
      if (left > 0) {
        if (left <= 2) tell(left === 1 ? 'One more step.' : 'Two more steps.')
        setMode({ ...mode, stepsLeft: left })
        return
      }
      const next = mode.leg + 1
      if (next < mode.route.legs.length) {
        setMode({ ...mode, leg: next, stepsLeft: mode.route.legs[next].steps, walking: false })
        return
      }
      tell(`You have arrived at the ${mode.route.to}.`)
      setMode({ kind: 'where' })
    }
  })

  function choose(choice: Room | 'where am i') {
    hush()
    if (choice === 'where am i') {
      setMode({ kind: 'where' })
      tell(room ? `You are in the ${room}.` : 'Looking around. Point the camera at the room.')
      return
    }
    const route = routeTo(choice, room)
    announcer.current.reset()
    if (route) {
      tell(`Following your saved route to the ${choice}.`)
      setMode({ kind: 'follow', route, leg: 0, stepsLeft: route.legs[0].steps, walking: false })
    } else {
      setMode({ kind: 'find', room: choice })
      tell(`Looking for the ${choice}. Turn slowly.`)
    }
  }

  function startTeaching(to: Room) {
    setTaught([])
    setMode({ kind: 'teach', from: room, to })
    tell(`Recording a route to the ${to}. Walk there at a normal pace, then tap Save.`)
  }

  function saveTaught() {
    if (mode.kind !== 'teach') return
    const legs = legsFromSteps(taught)
    if (!legs.length) return tell('No steps were recorded. Walk the route, then tap Save.')
    const saved = saveRoute({ id: String(Date.now()), from: mode.from, to: mode.to, legs, compass: hasCompass, savedAt: Date.now() })
    setRoutes(loadRoutes())
    tell(saved ? `Route to the ${mode.to} saved.` : 'This browser could not save the route.')
    setMode({ kind: 'ask' })
  }

  /** Acts out a step or a turn, for laptops and phones without a compass. */
  function manualTurn(degrees: number) {
    heading.current = (heading.current + degrees + 360) % 360
  }

  const showWalkButtons = !hasMotion && (mode.kind === 'teach' || (mode.kind === 'follow' && mode.walking))
  const showTurnButtons = !hasCompass && mode.kind === 'teach'

  let banner: string
  if (mode.kind === 'ask') banner = blocked ? 'Which room? Tap one below.' : heard ? `Heard: “${heard}”` : 'Which room? Say it or tap one.'
  else if (mode.kind === 'teach-pick') banner = 'Where does this route go?'
  else if (mode.kind === 'teach') {
    const legs = legsFromSteps(taught)
    banner = `Recording to the ${mode.to}: ${stepsPhrase(taught.length)}, ${legs.length > 1 ? `${legs.length - 1} turn${legs.length > 2 ? 's' : ''}` : 'no turns'}`
  } else if (mode.kind === 'follow') banner = status || `Following the route to the ${mode.route.to}`
  else banner = status || (room ? `You are in the ${room}` : 'Looking around…')

  return (
    <div className="nav home" role="dialog" aria-modal="true" aria-label="Find a room" data-main="camera" style={{ '--sheet-height': '220px' } as CSSProperties}>
      <div className="nav-pane nav-camera">{camera}</div>

      <div className="nav-banner" role="status">
        <span className="nav-glyph" aria-hidden="true">
          ⌂
        </span>
        <div className="nav-instruction">
          <span className="nav-text">{banner}</span>
          {mode.kind === 'follow' && mode.walking && <span className="nav-distance">{stepsPhrase(mode.stepsLeft)} to go</span>}
          {room && mode.kind !== 'teach' && <span className="nav-detail">Camera sees: {room}</span>}
        </div>
      </div>

      <div className="nav-sheet home-sheet">
        {(mode.kind === 'ask' || mode.kind === 'teach-pick') && (
          <div className="home-rooms">
            {ROOMS.map((r) => (
              <button key={r} type="button" className="button" onClick={() => (mode.kind === 'ask' ? choose(r) : startTeaching(r))}>
                {roomLabel(r)}
              </button>
            ))}
            {mode.kind === 'ask' && (
              <button type="button" className="button" onClick={() => choose('where am i')}>
                Where am I?
              </button>
            )}
          </div>
        )}

        {mode.kind === 'ask' && routes.length > 0 && (
          <ul className="home-routes" aria-label="Saved routes">
            {routes.map((r) => (
              <li key={r.id}>
                {r.from ? roomLabel(r.from) : 'Anywhere'} → {roomLabel(r.to)}
                <span className="sos-muted">
                  {r.legs.reduce((n, l) => n + l.steps, 0)} steps
                </span>
                <button
                  type="button"
                  className="voice-close"
                  aria-label={`Delete the route to the ${r.to}`}
                  onClick={() => {
                    deleteRoute(r.id)
                    setRoutes(loadRoutes())
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="actions">
          {showWalkButtons && (
            <button type="button" className="button" onClick={() => step.current()}>
              Take a step
            </button>
          )}
          {showTurnButtons && (
            <>
              <button type="button" className="button" onClick={() => manualTurn(-MANUAL_TURN_DEG)}>
                Turned left
              </button>
              <button type="button" className="button" onClick={() => manualTurn(MANUAL_TURN_DEG)}>
                Turned right
              </button>
            </>
          )}
          {mode.kind === 'teach' && (
            <button type="button" className="button nav-go" onClick={saveTaught}>
              Save route
            </button>
          )}
          {mode.kind === 'ask' && (
            <button type="button" className="button" onClick={() => setMode({ kind: 'teach-pick' })}>
              Teach a route
            </button>
          )}
          {mode.kind !== 'ask' && (
            <button
              type="button"
              className="button"
              onClick={() => {
                hush()
                setStatus('')
                setMode({ kind: 'ask' })
              }}
            >
              {mode.kind === 'teach' || mode.kind === 'teach-pick' ? 'Cancel' : 'Another room'}
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
        {!hasCompass && (mode.kind === 'teach' || mode.kind === 'follow') && (
          <p className="sos-muted">No compass on this device, so turns are tapped in by hand.</p>
        )}
      </div>
    </div>
  )
}
