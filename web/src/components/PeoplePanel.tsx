import { memo, type ReactNode } from 'react'
import { Check, Languages, Mic, MicOff, MonitorUp, MonitorX, MoreVertical, UserX, VideoOff } from 'lucide-react'

import type { MemberInfo, ModerateAction } from '@/lib/sfu'
import { languageName, type Language } from '@/lib/translate/languages'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { avatarColor, initials } from '@/lib/names'
import { cn } from '@/lib/utils'

interface PeoplePanelProps {
  members: MemberInfo[]
  selfId: string
  canModerate: boolean
  onModerate: (target: string, action: ModerateAction) => void
  languages?: Language[]
  memberLangs?: Record<string, string>
  onSetLanguage?: (target: string, lang: string) => void
}

interface MemberAction {
  action: ModerateAction
  label: string
  icon: ReactNode
  destructive?: boolean
}

function actionsFor(member: MemberInfo): MemberAction[] {
  const actions: MemberAction[] = []
  if (member.mic) actions.push({ action: 'mute', label: 'Mute', icon: <MicOff /> })
  if (member.cam) actions.push({ action: 'cam', label: 'Stop camera', icon: <VideoOff /> })
  if (member.sharing) actions.push({ action: 'screen', label: 'Stop sharing', icon: <MonitorX /> })
  actions.push({ action: 'kick', label: 'Remove from call', icon: <UserX />, destructive: true })
  return actions
}


export const PeoplePanel = memo(function PeoplePanel({
  members,
  selfId,
  canModerate,
  onModerate,
  languages = [],
  memberLangs = {},
  onSetLanguage,
}: PeoplePanelProps) {
  const translating = languages.length > 0
  return (
    <ul className="h-full overflow-y-auto p-2">
      {members.map((member) => {
        const self = member.id === selfId
        const lang = memberLangs[member.id]
        return (
          <li key={member.id} className="group flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-muted/60">
            <span
              className={cn(
                'grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold text-white',
                avatarColor(member.name),
              )}
            >
              {initials(member.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {member.name}
                {self && <span className="font-normal text-muted-foreground"> (you)</span>}
              </span>
              {translating && lang && (
                <span className="block truncate text-xs text-muted-foreground">{languageName(languages, lang)}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
              {member.sharing && <MonitorUp className="size-4" aria-label="Sharing screen" />}
              {member.mic ? (
                <Mic className="size-4" aria-label="Microphone on" />
              ) : (
                <MicOff className="size-4 text-destructive" aria-label="Microphone off" />
              )}
            </span>
            {canModerate && !self && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 rounded-full opacity-60 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                    aria-label={`More actions for ${member.name}`}
                  >
                    <MoreVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end">
                  {translating && onSetLanguage && (
                    <>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger aria-label={`${member.name}'s language for live translation`}>
                          <Languages />
                          {lang ? languageName(languages, lang) : 'Set language'}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {languages.map((language) => (
                            <DropdownMenuItem key={language.code} onSelect={() => onSetLanguage(member.id, language.code)}>
                              <Check className={cn(language.code !== lang && 'invisible')} />
                              {language.name}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {actionsFor(member).map(({ action, label, icon, destructive }) => (
                    <DropdownMenuItem
                      key={action}
                      onSelect={() => onModerate(member.id, action)}
                      className={cn(destructive && 'text-destructive focus:bg-destructive/10 focus:text-destructive')}
                    >
                      {icon}
                      {label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        )
      })}
    </ul>
  )
})
