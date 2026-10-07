import { useEffect, useRef, useState } from 'react'
import { useVoiceReply } from '../navigation/useVoiceReply'
import { canListen, say, sosReply } from '../navigation/voice'
import { loadContacts } from './contacts'

/** Long enough to hear the question and answer it out loud. */
const COUNTDOWN_S = 15
/** Start listening by now even if the browser never reports the question finished. */
const PROMPT_MAX_MS = 8000

/** Who the SOS goes to, with the numbers from Parental settings. A demo: nothing is actually sent. */
function recipients() {
  const { mom, dad } = loadContacts()
  return [
    { name: 'Mom', detail: mom || 'No number set' },
    { name: 'Dad', detail: dad || 'No number set' },
    { name: 'Ambulance', detail: '108' },
  ]
}

type Phase = { kind: 'countdown'; left: number } | { kind: 'sending' } | { kind: 'sent'; message: string }

function currentLocation(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(`https://maps.google.com/?q=${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}`),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 },
    )
  })
}

/** Asks whether the user is OK after a fall, and sends a (pretend) SOS if they don't answer. */
export function FallAlert({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'countdown', left: COUNTDOWN_S })
  const okButton = useRef<HTMLButtonElement>(null)
  const [asked, setAsked] = useState(false)

  useEffect(() => {
    okButton.current?.focus()
    navigator.vibrate?.([400, 200, 400, 200, 400])
    // Listening starts after the question, so the microphone doesn't hear the phone talking.
    const fallback = setTimeout(() => setAsked(true), PROMPT_MAX_MS)
    say('Fall detected. Are you okay? Say send to call for help, or say I am okay to cancel.', () => {
      clearTimeout(fallback)
      setAsked(true)
    })
    return () => clearTimeout(fallback)
  }, [])

  const counting = phase.kind === 'countdown'

  // Listen for "send" or "don't send" until the countdown ends.
  const { heard, blocked: micBlocked } = useVoiceReply(counting && asked, (text) => {
    const reply = sosReply(text)
    if (reply === 'cancel') {
      say('Okay. Glad you are safe.')
      onClose()
    } else if (reply === 'send') setPhase({ kind: 'sending' })
    return reply !== null
  })

  useEffect(() => {
    if (!counting) return
    const id = setInterval(
      () => setPhase((p) => (p.kind === 'countdown' ? (p.left <= 1 ? { kind: 'sending' } : { kind: 'countdown', left: p.left - 1 }) : p)),
      1000,
    )
    return () => clearInterval(id)
  }, [counting])

  // "Send" once the countdown runs out or the user asks for help.
  const sending = phase.kind === 'sending'
  useEffect(() => {
    if (!sending) return
    let stale = false
    currentLocation().then((location) => {
      if (stale) return
      const message = `SOS from yooolo: I may have fallen and need help.${location ? ` My location: ${location}` : ''}`
      setPhase({ kind: 'sent', message })
      say('S O S sent to your parents and the ambulance.')
    })
    return () => {
      stale = true
    }
  }, [sending])

  function cancel() {
    say('Okay. Glad you are safe.')
    onClose()
  }

  return (
    <div className="sos-backdrop">
      <div className="sos" role="alertdialog" aria-modal="true" aria-labelledby="sos-title" aria-describedby="sos-body">
        {phase.kind === 'sent' ? (
          <>
            <p className="sos-badge" data-sent="">
              ✓
            </p>
            <h2 id="sos-title" className="sos-title">
              SOS sent
            </h2>
            <div id="sos-body">
              <ul className="sos-contacts">
                {recipients().map((c) => (
                  <li key={c.name}>
                    <span>{c.name}</span>
                    <span className="sos-muted">{c.detail}</span>
                    <span className="sos-status">Sent</span>
                  </li>
                ))}
              </ul>
              <p className="sos-message">{phase.message}</p>
              <p className="sos-muted">Demo only: no real message was sent.</p>
            </div>
            <button type="button" className="button sos-primary" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <p className="sos-badge" aria-hidden="true">
              {phase.kind === 'countdown' ? phase.left : '…'}
            </p>
            <h2 id="sos-title" className="sos-title">
              Fall detected. Are you OK?
            </h2>
            <p id="sos-body" className="sos-muted">
              {phase.kind === 'countdown'
                ? `Sending an SOS to your parents and an ambulance in ${phase.left} second${phase.left === 1 ? '' : 's'}.`
                : 'Sending an SOS with your location…'}
            </p>
            <div className="sos-actions">
              <button ref={okButton} type="button" className="button sos-primary" onClick={cancel}>
                I’m OK
              </button>
              <button
                type="button"
                className="button sos-danger"
                disabled={phase.kind === 'sending'}
                onClick={() => setPhase({ kind: 'sending' })}
              >
                Send SOS now
              </button>
            </div>
            {phase.kind === 'countdown' && (
              <p className="sos-listen" aria-live="polite">
                {!canListen || micBlocked
                  ? 'Voice replies aren’t available here. Tap a button.'
                  : !asked
                    ? 'Asking…'
                    : heard
                      ? `Heard: “${heard}”`
                      : 'Listening… say “send” or “I’m OK”.'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
