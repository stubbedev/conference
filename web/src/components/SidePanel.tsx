import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Lock, MessageSquare, Users, X } from 'lucide-react'

import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { unreadBadge } from '@/hooks/side-panel'
import { cn } from '@/lib/utils'

export type SidePanelTab = 'people' | 'chat'

const TABS: readonly SidePanelTab[] = ['people', 'chat']

interface SidePanelProps {
  tab: SidePanelTab
  peopleCount: number
  unread: number
  onTab: (tab: SidePanelTab) => void
  onClose: () => void
  people: ReactNode
  chat: ReactNode
}

interface TabButtonProps {
  id: string
  panelId: string
  active: boolean
  onClick: () => void
  buttonRef: (element: HTMLButtonElement | null) => void
  children: ReactNode
}

function TabButton({ id, panelId, active, onClick, buttonRef, children }: TabButtonProps) {
  return (
    <button
      ref={buttonRef}
      id={id}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={cn(
        'flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11',
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function neighbour(tab: SidePanelTab, key: string): SidePanelTab | null {
  const index = TABS.indexOf(tab)
  switch (key) {
    case 'ArrowRight':
      return TABS[(index + 1) % TABS.length] ?? null
    case 'ArrowLeft':
      return TABS[(index - 1 + TABS.length) % TABS.length] ?? null
    case 'Home':
      return TABS[0] ?? null
    case 'End':
      return TABS[TABS.length - 1] ?? null
    default:
      return null
  }
}

export function SidePanel({ tab, peopleCount, unread, onTab, onClose, people, chat }: SidePanelProps) {
  const baseId = useId()
  const tabId = (name: SidePanelTab) => `${baseId}-${name}-tab`
  const panelId = (name: SidePanelTab) => `${baseId}-${name}-panel`
  const buttons = useRef(new Map<SidePanelTab, HTMLButtonElement>())
  const register = (name: SidePanelTab) => (element: HTMLButtonElement | null) => {
    if (element) buttons.current.set(name, element)
    else buttons.current.delete(name)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = neighbour(tab, event.key)
    if (!next) return
    event.preventDefault()
    onTab(next)
    buttons.current.get(next)?.focus()
  }

  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    if (event.target instanceof Element && event.target.closest('[role="menu"]')) return
    event.preventDefault()
    onClose()
  }

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={closeOnEscape}>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <div role="tablist" aria-label="Side panel" className="flex flex-1 items-center gap-1" onKeyDown={onKeyDown}>
          <TabButton
            id={tabId('people')}
            panelId={panelId('people')}
            active={tab === 'people'}
            onClick={() => onTab('people')}
            buttonRef={register('people')}
          >
            <Users className="size-4" />
            People
            <span className="text-xs text-muted-foreground tabular-nums">{peopleCount}</span>
          </TabButton>
          <TabButton
            id={tabId('chat')}
            panelId={panelId('chat')}
            active={tab === 'chat'}
            onClick={() => onTab('chat')}
            buttonRef={register('chat')}
          >
            <MessageSquare className="size-4" />
            Chat
            <Lock className="size-3 text-muted-foreground" aria-label="End-to-end encrypted" />
            {unread > 0 && tab !== 'chat' && (
              <span
                className="grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-white"
                aria-label={`${unread} unread`}
              >
                {unreadBadge(unread)}
              </span>
            )}
          </TabButton>
        </div>
        <Hint label="Close panel (Esc)" name="Close panel" side="bottom">
          <Button variant="ghost" size="icon" className="size-8" onClick={onClose}>
            <X />
          </Button>
        </Hint>
      </div>
      <div
        role="tabpanel"
        id={panelId('people')}
        aria-labelledby={tabId('people')}
        className={cn('min-h-0 flex-1', tab !== 'people' && 'hidden')}
      >
        {people}
      </div>
      <div
        role="tabpanel"
        id={panelId('chat')}
        aria-labelledby={tabId('chat')}
        className={cn('min-h-0 flex-1', tab !== 'chat' && 'hidden')}
      >
        {chat}
      </div>
    </div>
  )
}
