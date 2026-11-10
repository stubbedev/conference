import { useCallback, useMemo, useState, type RefObject } from 'react'
import { toast } from 'sonner'

import { useLatest } from '@/hooks/latest'
import type { Controls } from '@/hooks/local-media'
import { tilesOfMembers } from '@/lib/reconnect'
import { screenTracks } from '@/lib/screen'
import type { MemberInfo, ModerateAction, RoomClient } from '@/lib/sfu'
import { LOCAL_SOURCE, type Tile } from '@/lib/tiles'
import { SCREEN_KIND, tileOf } from '@/lib/track-kind'

export function useRoomMembers(clientRef: RefObject<RoomClient | null>, displayName: string, controls: Controls) {
  const [members, setMembers] = useState<MemberInfo[]>([])
  const [tiles, setTiles] = useState<Tile[]>([])
  const [selfId, setSelfId] = useState('')
  const membersRef = useLatest(members)

  const bind = useCallback(
    (client: RoomClient) => {
      client.on('welcome', ({ self, members: initial }) => {
        setMembers(initial)
        setSelfId(self.id)
      })
      client.on('member-joined', ({ member, replaces }) => {
        setMembers((prev) => [
          ...prev.filter((m) => m.id !== member.id && m.id !== replaces),
          member,
        ])
        if (replaces) {
          setTiles((prev) => prev.filter((t) => t.sourceId !== replaces))
          return
        }
        toast(`${member.name} joined`)
      })
      client.on('member-left', ({ id }) => {
        const name = membersRef.current.find((m) => m.id === id)?.name ?? 'Someone'
        toast(`${name} left`)
        setMembers((prev) => prev.filter((m) => m.id !== id))
        setTiles((prev) => prev.filter((t) => t.sourceId !== id))
      })
      client.on('member-state', ({ id, mic, cam, sharing }) => {
        setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, mic, cam, sharing } : m)))
        if (id !== client.memberId && !sharing) {
          setTiles((prev) => prev.filter((t) => !(t.sourceId === id && t.kind === SCREEN_KIND)))
        }
      })
      client.on('track', ({ sourceId, stream: incoming, kind }) => {
        const tileKind = tileOf(kind)
        if (tileKind === null) return
        const key = `${sourceId}:${tileKind}`
        setTiles((prev) => {
          const existing = prev.find((t) => t.key === key)
          const stream =
            tileKind === SCREEN_KIND
              ? new MediaStream(screenTracks(existing?.stream?.getTracks() ?? [], incoming.getTracks()))
              : incoming
          const rest = prev.filter((t) => t.key !== key)
          return [...rest, { key, sourceId, kind: tileKind, stream }]
        })
      })
    },
    [membersRef],
  )

  const keepPresent = useCallback(
    () => setTiles((prev) => tilesOfMembers(prev, membersRef.current.map((member) => member.id))),
    [membersRef],
  )

  const reset = useCallback(() => {
    setTiles([])
    setMembers([])
  }, [])

  const moderate = useCallback(
    (target: string, action: ModerateAction) => clientRef.current?.moderate(target, action),
    [clientRef],
  )

  const selfMember: MemberInfo = useMemo(
    () => ({
      id: LOCAL_SOURCE,
      short: 0,
      name: displayName,
      mic: controls.mic,
      cam: controls.cam,
      sharing: controls.sharing,
    }),
    [displayName, controls],
  )
  const memberList = useMemo(() => [selfMember, ...members], [selfMember, members])

  return { members, membersRef, tiles, selfId, selfMember, memberList, bind, keepPresent, reset, moderate }
}
