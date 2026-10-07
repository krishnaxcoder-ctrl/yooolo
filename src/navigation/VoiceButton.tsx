import { useEffect, useRef, useState, type FormEvent } from 'react'
import { canListen, listen, parseTrip, type Listener, type TripRequest } from './voice'

type State =
  | { kind: 'closed' }
  | { kind: 'listening'; heard: string }
  | { kind: 'idle'; message?: string; error?: boolean }

const EXAMPLE = '“Panvel to Pune”'

/** A floating mic button: say a trip, and directions open. A typed box covers browsers without speech recognition. */
export function VoiceButton({ onTrip }: { onTrip: (trip: TripRequest) => void }) {
  const [state, setState] = useState<State>({ kind: 'closed' })
  const [typed, setTyped] = useState('')
  const listener = useRef<Listener | null>(null)

  useEffect(() => () => listener.current?.stop(), [])

  function go(text: string) {
    const trip = parseTrip(text)
    if (!trip) return setState({ kind: 'idle', message: `Say a start and destination, like ${EXAMPLE}.`, error: true })
    setState({ kind: 'closed' })
    setTyped('')
    onTrip(trip)
  }

  function start() {
    if (!canListen) {
      setState({ kind: 'idle', message: 'Voice commands need Chrome, Edge or Safari. You can type the route instead.', error: true })
      return
    }
    setState({ kind: 'listening', heard: '' })
    try {
      listener.current = listen({
        onText: (heard) => setState({ kind: 'listening', heard }),
        onError: (message) => setState({ kind: 'idle', message, error: true }),
        onDone: (text) => {
          listener.current = null
          if (text) go(text)
          else setState((s) => (s.kind === 'listening' ? { kind: 'idle', message: `Didn’t catch that. Try saying ${EXAMPLE}.` } : s))
        },
      })
    } catch (err) {
      setState({ kind: 'idle', message: (err as Error).message, error: true })
    }
  }

  function toggle() {
    if (state.kind === 'listening') {
      listener.current?.stop()
      setState({ kind: 'idle' })
    } else start()
  }

  function close() {
    listener.current?.stop()
    setState({ kind: 'closed' })
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (typed.trim()) go(typed)
  }

  const listening = state.kind === 'listening'

  return (
    <div className="voice">
      {state.kind !== 'closed' && (
        <div className="voice-card" role="dialog" aria-label="Voice directions">
          <div className="voice-head">
            <p className="voice-title">{listening ? 'Listening…' : 'Where to?'}</p>
            <button type="button" className="voice-close" aria-label="Close" onClick={close}>
              ×
            </button>
          </div>
          <p className="voice-heard" aria-live="polite" data-error={state.kind === 'idle' && state.error ? '' : undefined}>
            {listening ? state.heard || `Say a route, like ${EXAMPLE}.` : (state.message ?? `Select the mic and say ${EXAMPLE}.`)}
          </p>
          <form className="voice-form" onSubmit={submit}>
            <label className="visually-hidden" htmlFor="voice-typed">
              Or type a route
            </label>
            <input
              id="voice-typed"
              type="text"
              placeholder="Or type: Panvel to Pune"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
            <button type="submit" className="button">
              Go
            </button>
          </form>
        </div>
      )}
      <button
        type="button"
        className="voice-fab"
        data-listening={listening ? '' : undefined}
        aria-pressed={listening}
        aria-label={listening ? 'Stop listening' : 'Speak a destination'}
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
          <path d="M6 11a6 6 0 0 0 12 0M12 17v4M8.5 21h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
