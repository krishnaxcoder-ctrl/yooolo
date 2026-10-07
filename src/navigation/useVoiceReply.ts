import { useEffect, useRef, useState } from 'react'
import { canListen, listen, type Listener } from './voice'

/**
 * Listens while `active`, starting again after each pause, until `onFinal` returns true for
 * something it heard. `blocked` means the microphone or speech service isn't available (for
 * example offline, since Chrome recognizes speech on Google's servers), so show buttons instead.
 */
export function useVoiceReply(active: boolean, onFinal: (text: string) => boolean) {
  const [heard, setHeard] = useState('')
  const [blocked, setBlocked] = useState(!canListen)
  const handler = useRef(onFinal)
  useEffect(() => {
    handler.current = onFinal
  })

  useEffect(() => {
    if (!active || !canListen) return
    let stopped = false
    let listener: Listener | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    const start = () => {
      if (stopped) return
      listener = listen({
        onText: setHeard,
        onError: () => {
          stopped = true
          setBlocked(true)
        },
        onDone: (text) => {
          listener = null
          if (stopped) return
          if (text && handler.current(text)) stopped = true
          else retry = setTimeout(start, 250)
        },
      })
    }
    start()
    return () => {
      stopped = true
      clearTimeout(retry)
      listener?.stop()
    }
  }, [active])

  return { heard, blocked }
}
