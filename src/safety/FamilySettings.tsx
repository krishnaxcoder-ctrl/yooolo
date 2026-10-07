import { useEffect, useRef, useState } from 'react'
import { loadContacts, saveContacts, type Contacts } from './contacts'

/** Demo family features: the switches remember their state on this device, but nothing is sent. */
interface Family {
  shareLocation: boolean
  locationWithSos: boolean
  tripStarts: boolean
  lowBattery: boolean
}

const DEFAULTS: Family = { shareLocation: false, locationWithSos: true, tripStarts: false, lowBattery: true }
const KEY = 'yooolo.family'

function load(): Family {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Family>) }
  } catch {
    return DEFAULTS
  }
}

function save(family: Family) {
  try {
    localStorage.setItem(KEY, JSON.stringify(family))
  } catch {
    // Private windows and blocked storage: the switches just won't be remembered.
  }
}

const SWITCHES: { key: keyof Family; label: string }[] = [
  { key: 'shareLocation', label: 'Share live location with parents' },
  { key: 'locationWithSos', label: 'Send location with SOS' },
  { key: 'tripStarts', label: 'Tell parents when a trip starts' },
  { key: 'lowBattery', label: 'Low battery alert to parents' },
]

export function FamilySettings() {
  const [family, setFamily] = useState(load)
  const [confirming, setConfirming] = useState(false)
  const [contacts, setContacts] = useState(loadContacts)

  function setNumber(who: keyof Contacts, number: string) {
    const next = { ...contacts, [who]: number }
    setContacts(next)
    saveContacts(next)
  }

  function set(key: keyof Family, on: boolean) {
    // Turning on location sharing asks first; everything else changes straight away.
    if (key === 'shareLocation' && on) return setConfirming(true)
    const next = { ...family, [key]: on }
    setFamily(next)
    save(next)
  }

  function confirmSharing(on: boolean) {
    setConfirming(false)
    if (!on) return
    const next = { ...family, shareLocation: true }
    setFamily(next)
    save(next)
  }

  return (
    <>
      <div className="field">
        <h2 className="field-label">Family</h2>
        {SWITCHES.map((s) => (
          <label key={s.key} className="toggle">
            <input type="checkbox" checked={family[s.key]} onChange={(e) => set(s.key, e.target.checked)} />
            {s.label}
          </label>
        ))}
        <p className="hint">
          {family.shareLocation ? 'Mom and Dad can see where you are while the app is open. ' : ''}
          Demo only: nothing is sent.
        </p>
      </div>

      <div className="field">
        <h2 className="field-label">Emergency contacts</h2>
        <ul className="family-contacts">
          {(['mom', 'dad'] as const).map((who) => (
            <li key={who}>
              <label htmlFor={`contact-${who}`}>{who === 'mom' ? 'Mom' : 'Dad'}</label>
              <input
                id={`contact-${who}`}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="+91 98765 43210"
                value={contacts[who]}
                onChange={(e) => setNumber(who, e.target.value)}
              />
            </li>
          ))}
          <li>
            <span>Ambulance</span>
            <span className="sos-muted">108</span>
          </li>
        </ul>
      </div>

      {confirming && <ShareLocationModal onAnswer={confirmSharing} />}
    </>
  )
}

function ShareLocationModal({ onAnswer }: { onAnswer: (on: boolean) => void }) {
  const turnOn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    turnOn.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape closes this popup, not the settings behind it.
      e.stopImmediatePropagation()
      onAnswer(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onAnswer])

  return (
    <div className="sos-backdrop family-modal" onClick={(e) => e.target === e.currentTarget && onAnswer(false)}>
      <div className="sos" role="alertdialog" aria-modal="true" aria-labelledby="share-title" aria-describedby="share-body">
        <p className="sos-badge family-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="40" height="40">
            <path
              d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="9.5" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </p>
        <h2 id="share-title" className="sos-title">
          Share your live location?
        </h2>
        <p id="share-body" className="sos-muted">
          Mom and Dad will see where you are while the app is open. You can turn this off at any time.
        </p>
        <div className="sos-actions">
          <button ref={turnOn} type="button" className="button settings-done" onClick={() => onAnswer(true)}>
            Turn on
          </button>
          <button type="button" className="button" onClick={() => onAnswer(false)}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
