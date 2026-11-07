import { useEffect, useState } from 'react'

function now(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function MeetingClock() {
  const [time, setTime] = useState(now)

  useEffect(() => {
    let timer = 0
    const tick = () => {
      setTime(now())
      timer = window.setTimeout(tick, 60_000 - (Date.now() % 60_000))
    }
    timer = window.setTimeout(tick, 60_000 - (Date.now() % 60_000))
    return () => window.clearTimeout(timer)
  }, [])

  return <time>{time}</time>
}
