import type { ReactNode } from 'react'
import { Mic, MicOff, MonitorX, UserX, Users, Video, VideoOff } from 'lucide-react'

import type { MemberInfo, ModerateAction } from '@/lib/sfu'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface ParticipantsPanelProps {
  members: MemberInfo[]
  selfId: string
  canModerate: boolean
  onModerate: (target: string, action: ModerateAction) => void
}

interface ActionButton {
  action: ModerateAction
  title: string
  icon: ReactNode
  destructive?: boolean
}

function actionsFor(member: MemberInfo): ActionButton[] {
  const actions: ActionButton[] = []
  if (member.mic) {
    actions.push({ action: 'mute', title: 'Mute microphone', icon: <MicOff /> })
  }
  if (member.cam) {
    actions.push({ action: 'cam', title: 'Turn off camera', icon: <VideoOff /> })
  }
  if (member.sharing) {
    actions.push({ action: 'screen', title: 'Stop screen share', icon: <MonitorX /> })
  }
  actions.push({ action: 'kick', title: 'Remove from call', icon: <UserX />, destructive: true })
  return actions
}

export function ParticipantsPanel({
  members,
  selfId,
  canModerate,
  onModerate,
}: ParticipantsPanelProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" className="h-7 gap-1 px-2.5 text-xs" title="Participants">
          <Users className="size-3.5" />
          {members.length}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="grid gap-0.5">
          {members.map((member) => {
            const self = member.id === selfId

            return (
              <div key={member.id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-medium">
                  {member.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {member.name}
                  {self && <span className="text-muted-foreground"> (you)</span>}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                  {member.mic ? (
                    <Mic className="size-3.5" />
                  ) : (
                    <MicOff className="size-3.5 text-destructive" />
                  )}
                  {member.cam ? <Video className="size-3.5" /> : <VideoOff className="size-3.5" />}
                </span>
                {canModerate && !self && (
                  <span className="flex shrink-0 items-center gap-0.5">
                    {actionsFor(member).map(({ action, title, icon, destructive }) => (
                      <Button
                        key={action}
                        variant="ghost"
                        size="icon"
                        className={destructive ? 'text-destructive size-7 hover:text-destructive' : 'size-7'}
                        title={title}
                        onClick={() => onModerate(member.id, action)}
                      >
                        {icon}
                      </Button>
                    ))}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
