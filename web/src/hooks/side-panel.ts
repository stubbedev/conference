import { useCallback, useState, type RefObject } from 'react'

import type { SidePanelTab } from '@/components/SidePanel'
import { useLatest } from '@/hooks/latest'
import { usePersistentState } from '@/hooks/persistent'
import type { ChatMessage, RoomClient } from '@/lib/sfu'

function parseSidebar(stored: unknown): SidePanelTab | null {
  return stored === 'people' || stored === 'chat' ? stored : null
}

export function useSidePanel(clientRef: RefObject<RoomClient | null>) {
  const [sidebar, setSidebar] = usePersistentState('conference:sidebar', { parse: parseSidebar })
  const [unread, setUnread] = useState(0)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const chatOpen = sidebar === 'chat'
  const chatOpenRef = useLatest(chatOpen)
  const sidebarRef = useLatest(sidebar)

  const bind = useCallback(
    (client: RoomClient) => {
      client.on('chat', (message) => {
        setMessages((prev) => [...prev, message])
        if (!message.mine && !chatOpenRef.current) setUnread((count) => count + 1)
      })
    },
    [chatOpenRef],
  )

  const sendChat = useCallback(
    async (text: string) => {
      await clientRef.current?.sendChat(text)
      setMessages((prev) => [
        ...prev,
        { id: `me:${Date.now()}`, name: 'You', text, ts: Date.now(), mine: true },
      ])
    },
    [clientRef],
  )

  const showSidebar = useCallback(
    (tab: SidePanelTab | null) => {
      setSidebar(tab)
      if (tab === 'chat') setUnread(0)
    },
    [setSidebar],
  )
  const toggleSidebar = useCallback(
    (tab: SidePanelTab) => showSidebar(sidebarRef.current === tab ? null : tab),
    [showSidebar, sidebarRef],
  )
  const toggleChat = useCallback(() => toggleSidebar('chat'), [toggleSidebar])
  const togglePeople = useCallback(() => toggleSidebar('people'), [toggleSidebar])
  const closeSidebar = useCallback(() => showSidebar(null), [showSidebar])

  return { sidebar, chatOpen, unread, messages, bind, sendChat, showSidebar, toggleChat, togglePeople, closeSidebar }
}
