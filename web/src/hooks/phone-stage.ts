import { useSyncExternalStore } from 'react'

const PHONE_STAGE_QUERY = 'not all and (min-width: 40rem) and (min-height: 30rem)'

let phoneQuery: MediaQueryList | null = null

function query(): MediaQueryList {
  phoneQuery ??= window.matchMedia(PHONE_STAGE_QUERY)
  return phoneQuery
}

function subscribe(onChange: () => void): () => void {
  const list = query()
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

function snapshot(): boolean {
  return query().matches
}

export function usePhoneStage(): boolean {
  return useSyncExternalStore(subscribe, snapshot)
}
