import { useEffect, useState } from 'react'

export interface PauseCountdown {
  secsRemaining: number
  mm: number
  ss: string    // zero-padded "05"
  expired: boolean
}

// Pure math: given a target unix-ms `until` and a "now" unix-ms, compute the
// countdown fields. Never returns negative seconds; `expired` is true when
// the target has been reached or passed.
export function computePauseCountdown(until: number, now: number): PauseCountdown {
  const secsRemaining = Math.max(0, Math.round((until - now) / 1000))
  const mm = Math.floor(secsRemaining / 60)
  const ssNum = secsRemaining % 60
  return {
    secsRemaining,
    mm,
    ss: String(ssNum).padStart(2, '0'),
    expired: secsRemaining === 0,
  }
}

// Ticks every 1s to return a live countdown toward `until` (unix ms).
// Used by both ChatroomLayout's PauseBanner and CliLayout's pause line.
export function usePauseCountdown(until: number): PauseCountdown {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return computePauseCountdown(until, now)
}
