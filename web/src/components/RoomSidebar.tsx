import { ChatPanel } from '@/components/ChatPanel'
import { PeoplePanel } from '@/components/PeoplePanel'
import { SidePanel, type SidePanelTab } from '@/components/SidePanel'
import type { ChatMessage, MemberInfo, ModerateAction } from '@/lib/sfu'
import type { Language } from '@/lib/translate/languages'

interface RoomSidebarProps {
  tab: SidePanelTab
  unread: number
  onTab: (tab: SidePanelTab) => void
  onClose: () => void
  members: MemberInfo[]
  selfId: string
  canModerate: boolean
  onModerate: (target: string, action: ModerateAction) => void
  languages: Language[]
  memberLangs: Record<string, string>
  onSetLanguage: (target: string, lang: string) => void
  messages: ChatMessage[]
  onSend: (text: string) => Promise<void>
}

export function RoomSidebar({
  tab,
  unread,
  onTab,
  onClose,
  members,
  selfId,
  canModerate,
  onModerate,
  languages,
  memberLangs,
  onSetLanguage,
  messages,
  onSend,
}: RoomSidebarProps) {
  return (
    <>
      <button
        type="button"
        aria-label="Close panel"
        className="absolute inset-0 z-30 cursor-default bg-black/50 md:hidden"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 right-0 z-40 flex w-[85%] max-w-sm flex-col bg-background shadow-xl md:static md:z-auto md:w-[22rem] md:max-w-none md:shrink-0 md:border-l md:shadow-none">
        <SidePanel
          tab={tab}
          peopleCount={members.length}
          unread={unread}
          onTab={onTab}
          onClose={onClose}
          people={
            <PeoplePanel
              members={members}
              selfId={selfId}
              canModerate={canModerate}
              onModerate={onModerate}
              languages={languages}
              memberLangs={memberLangs}
              onSetLanguage={onSetLanguage}
            />
          }
          chat={<ChatPanel messages={messages} onSend={onSend} />}
        />
      </aside>
    </>
  )
}
