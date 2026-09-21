import { memo, useEffect, useRef, useState } from 'react'
import { ArrowDown, Lock, MicOff, SendHorizonal, Users, VideoOff, X } from 'lucide-react'

import type { ChatMessage, MemberInfo } from '@/lib/sfu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface ChatPanelProps {
  messages: ChatMessage[]
  members: MemberInfo[]
  onSend: (text: string) => Promise<void>
  onClose: () => void
}

export const ChatPanel = memo(function ChatPanel({
  messages,
  members,
  onSend,
  onClose,
}: ChatPanelProps) {
  const [text, setText] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  const lastMessage = messages[messages.length - 1]
  const stick = atBottom || lastMessage?.mine

  useEffect(() => {
    if (!stick) return
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages.length, stick])

  const onScroll = () => {
    const list = listRef.current
    if (!list) return
    setAtBottom(list.scrollHeight - list.scrollTop - list.clientHeight < 60)
  }

  const send = async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    await onSend(trimmed)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          Chat <Lock className="size-3 text-muted-foreground" />
        </h2>
        <Button variant="ghost" size="icon" className="size-8" onClick={onClose} title="Close chat">
          <X />
        </Button>
      </div>

      <div className="shrink-0 border-b px-4 py-3">
        <p className="mb-2 flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Users className="size-3" /> In this call — {members.length}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {members.map((member) => (
            <span
              key={member.id}
              title={member.name}
              className="inline-flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pr-2.5 pl-0.5 text-xs font-medium"
            >
              <span className="grid size-5 place-items-center rounded-full bg-primary/10 text-[10px] text-foreground/70">
                {member.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="max-w-28 truncate">{member.name}</span>
              {!member.mic && <MicOff className="size-3 text-destructive" />}
              {!member.cam && <VideoOff className="size-3 text-muted-foreground" />}
            </span>
          ))}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={listRef} onScroll={onScroll} className="h-full space-y-3 overflow-y-auto px-3 py-3">
          {messages.map((message) => (
            <div
              key={message.id}
              className={cn('flex flex-col', message.mine ? 'items-end' : 'items-start')}
            >
              <div className="mb-0.5 flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground/80">
                  {message.mine ? 'You' : message.name}
                </span>
                <time>{new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              </div>
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-3 py-1.5 text-sm break-words whitespace-pre-wrap',
                  message.mine
                    ? 'rounded-br-md bg-primary text-primary-foreground'
                    : 'rounded-bl-md bg-muted',
                )}
              >
                {message.text}
              </div>
            </div>
          ))}
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Lock className="size-5 text-muted-foreground" />
              <p className="max-w-44 text-xs text-muted-foreground">
                Messages are end-to-end encrypted. Not even the server can read them.
              </p>
            </div>
          )}
        </div>
        {!atBottom && (
          <button
            type="button"
            onClick={() =>
              listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
            }
            title="Jump to latest"
            className="absolute bottom-3 left-1/2 grid size-8 -translate-x-1/2 cursor-pointer place-items-center rounded-full border bg-background shadow-md"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
      </div>

      <form
        className="flex shrink-0 gap-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Message…"
          autoComplete="off"
        />
        <Button size="icon" type="submit" title="Send" disabled={!text.trim()}>
          <SendHorizonal />
        </Button>
      </form>
    </div>
  )
})
