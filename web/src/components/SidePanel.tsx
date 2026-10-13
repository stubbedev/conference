import type { ReactNode } from 'react'
import { Lock, MessageSquare, Users, X } from 'lucide-react'

import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type SidePanelTab = 'people' | 'chat'

interface SidePanelProps {
  tab: SidePanelTab
  peopleCount: number
  unread: number
  onTab: (tab: SidePanelTab) => void
  onClose: () => void
  people: ReactNode
  chat: ReactNode
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
        active
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

export function SidePanel({ tab, peopleCount, unread, onTab, onClose, people, chat }: SidePanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <div role="tablist" className="flex flex-1 items-center gap-1">
          <TabButton active={tab === 'people'} onClick={() => onTab('people')}>
            <Users className="size-4" />
            People
            <span className="text-xs text-muted-foreground tabular-nums">{peopleCount}</span>
          </TabButton>
          <TabButton active={tab === 'chat'} onClick={() => onTab('chat')}>
            <MessageSquare className="size-4" />
            Chat
            <Lock className="size-3 text-muted-foreground" />
            {unread > 0 && tab !== 'chat' && (
              <span className="grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </TabButton>
        </div>
        <Hint label="Close panel" side="bottom">
          <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label="Close panel">
            <X />
          </Button>
        </Hint>
      </div>
      <div role="tabpanel" className={cn('min-h-0 flex-1', tab !== 'people' && 'hidden')}>
        {people}
      </div>
      <div role="tabpanel" className={cn('min-h-0 flex-1', tab !== 'chat' && 'hidden')}>
        {chat}
      </div>
    </div>
  )
}
