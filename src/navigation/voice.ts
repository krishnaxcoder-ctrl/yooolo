/** A spoken trip. `from: null` means start from the device's current location. */
export interface TripRequest {
  from: string | null
  to: string
}

// The Web Speech API isn't in TypeScript's DOM lib, so this declares the part we use.
interface RecognitionResultEvent extends Event {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}
interface RecognitionErrorEvent extends Event {
  error: string
}
interface Recognition extends EventTarget {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  start(): void
  abort(): void
  onresult: ((e: RecognitionResultEvent) => void) | null
  onerror: ((e: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}
type RecognitionConstructor = new () => Recognition

const Recognition: RecognitionConstructor | undefined =
  (window as unknown as Record<string, RecognitionConstructor | undefined>).SpeechRecognition ??
  (window as unknown as Record<string, RecognitionConstructor | undefined>).webkitSpeechRecognition

export const canListen = Recognition !== undefined

export interface Listener {
  stop(): void
}

/** Listens for one utterance. `onText` gets interim text as it's heard, then `onDone` the final text (or null). */
export function listen(handlers: {
  onText: (text: string) => void
  onDone: (text: string | null) => void
  onError: (message: string) => void
}): Listener {
  if (!Recognition) throw new Error('Speech recognition is not supported in this browser.')
  const rec = new Recognition()
  // Indian English handles local place names (Panvel, Pune, Thane) far better than en-US.
  rec.lang = 'en-IN'
  rec.interimResults = true
  rec.maxAlternatives = 1

  let finalText: string | null = null
  rec.onresult = (e) => {
    let text = ''
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
    handlers.onText(text)
    if (e.results[e.results.length - 1].isFinal) finalText = text
  }
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return
    handlers.onError(recognitionErrorMessage(e.error))
  }
  rec.onend = () => handlers.onDone(finalText)
  rec.start()
  return { stop: () => rec.abort() }
}

function recognitionErrorMessage(code: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return 'Microphone access is blocked. Allow it in your browser’s site settings, then try again.'
  }
  if (code === 'audio-capture') return 'No microphone was found.'
  if (code === 'network') return 'Voice recognition needs an internet connection.'
  return `Voice recognition stopped: ${code}.`
}

const LEAD_IN =
  /^(?:(?:please|hey|ok|okay|can you|could you)\s+)*(?:(?:navigate|navigation|directions?|route|drive|go|take me|show me the way|show me|get me|i want to go|how do i get|how to go)\s+)?/
// Speech recognition often hears "to" as "2" or "too"; "se ... tak" is the Hindi form.
const SEPARATOR = /^(.+?)\s+(?:to|2|too|till|until|se)\s+(.+?)(?:\s+tak)?$/

/** Turns "Panvel to Pune", "from Panvel to Pune" or "take me to Pune" into a trip. */
export function parseTrip(text: string): TripRequest | null {
  const t = text
    .toLowerCase()
    .replace(/[.,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEAD_IN, '')
    .replace(/^from\s+/, '')
  if (!t) return null
  const toOnly = t.match(/^(?:to|2)\s+(.+)$/)
  if (toOnly) return { from: null, to: titleCase(toOnly[1]) }
  const both = t.match(SEPARATOR)
  if (both) return { from: titleCase(both[1]), to: titleCase(both[2]) }
  return { from: null, to: titleCase(t) }
}

/** What a spoken reply to the SOS alert asks for. "Don't send" is checked before "send", so it can't be misread. */
export function sosReply(text: string): 'send' | 'cancel' | null {
  const t = text.toLowerCase().replace(/[’]/g, "'")
  if (/\b(don'?t|do not|no need|not)\b.*\b(send|call|help)\b/.test(t)) return 'cancel'
  if (/\b(send|help|call|sos|s o s|emergency|ambulance)\b/.test(t)) return 'send'
  if (/\b(i'?m|i am)\s+(ok|okay|fine|alright|all right|good|safe)\b|\b(cancel|stop|no)\b/.test(t)) return 'cancel'
  return null
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase())

/**
 * Speaks `text`, cutting off anything still being said so directions stay current.
 * `onEnd` runs once it has been said (or straight away if the browser can't speak).
 */
export function say(text: string, onEnd?: () => void) {
  if (!('speechSynthesis' in window)) return onEnd?.()
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'en-IN'
  u.voice = speechSynthesis.getVoices().find((v) => v.lang === 'en-IN') ?? null
  if (onEnd) {
    u.onend = () => onEnd()
    u.onerror = () => onEnd()
  }
  speechSynthesis.speak(u)
}

/** Whether something is being said right now. */
export const speaking = () => 'speechSynthesis' in window && speechSynthesis.speaking

export function hush() {
  if ('speechSynthesis' in window) speechSynthesis.cancel()
}
