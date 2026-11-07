import { useEffect, useRef, useState } from 'react'

import { membershipChanges } from '@/lib/announce'
import type { MemberInfo } from '@/lib/sfu'

export function MemberAnnouncer({ members }: { members: readonly MemberInfo[] }) {
  const previous = useRef(members)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const changes = membershipChanges(previous.current, members)
    previous.current = members
    if (changes.length > 0) setMessage(changes.join('. '))
  }, [members])

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {message}
    </div>
  )
}
