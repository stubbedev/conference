import { memo, type ReactNode } from 'react'
import { Mic, MicOff, MonitorUp, MonitorX, UserX, Video, VideoOff } from 'lucide-react'

import type { MemberInfo, ModerateAction } from '@/lib/sfu'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface PeoplePanelProps {
  members: MemberInfo[]
  selfId: string
  canModerate: boolean
  onModerate: (target: string, action: ModerateAction) => void
}

interface ActionButton {
  action: ModerateAction
  label: string
  icon: ReactNode
  destructive?: boolean
}

function actionsFor(member: MemberInfo): ActionButton[] {
  const actions: ActionButton[] = []
  if (member.mic) actions.push({ action: 'mute', label: 'Mute', icon: <MicOff /> })
  if (member.cam) actions.push({ action: 'cam', label: 'Stop camera', icon: <VideoOff /> })
  if (member.sharing) actions.push({ action: 'screen', label: 'Stop share', icon: <MonitorX /> })
  actions.push({ action: 'kick', label: 'Remove', icon: <UserX />, destructive: true })
  return actions
}

export const PeoplePanel = memo(function PeoplePanel({
  members,
  selfId,
  canModerate,
  onModerate,
}: PeoplePanelProps) {
  return (
    <ul className="h-full space-y-1 overflow-y-auto p-2">
      {members.map((member) => {
        const self = member.id === selfId
        return (
          <li key={member.id} className="rounded-lg px-2 py-2 transition-colors hover:bg-muted/60">
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium">
                {member.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {member.name}
                {self && <span className="font-normal text-muted-foreground"> (you)</span>}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                {member.sharing && <MonitorUp className="size-4" aria-label="Sharing screen" />}
                {member.mic ? (
                  <Mic className="size-4" aria-label="Microphone on" />
                ) : (
                  <MicOff className="size-4 text-destructive" aria-label="Microphone off" />
                )}
                {member.cam ? (
                  <Video className="size-4" aria-label="Camera on" />
                ) : (
                  <VideoOff className="size-4" aria-label="Camera off" />
                )}
              </span>
            </div>
            {canModerate && !self && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {actionsFor(member).map(({ action, label, icon, destructive }) => (
                  <Button
                    key={action}
                    variant="secondary"
                    size="sm"
                    className={cn(
                      'h-7 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5',
                      destructive && 'ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive',
                    )}
                    onClick={() => onModerate(member.id, action)}
                  >
                    {icon}
                    {label}
                  </Button>
                ))}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
})
