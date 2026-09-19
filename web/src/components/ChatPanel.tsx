import { useEffect, useRef, useState } from 'react'
import { SendHorizonal } from 'lucide-react'

import type { ChatMessage, MemberInfo } from '@/lib/sfu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface ChatPanelProps {
  messages: ChatMessage[]
  members: MemberInfo[]
  onSend: (text: string) => Promise<void>
}

export function ChatPanel({ messages, members, onSend }: ChatPanelProps) {
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages.length])

  const send = async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    await onSend(trimmed)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b px-3 py-2">
        {members.map((member) => (
          <span
            key={member.id}
            title={member.name}
            className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium"
          >
            {member.name.slice(0, 2).toUpperCase()}
          </span>
        ))}
      </div>
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              'max-w-[85%] rounded-lg px-3 py-1.5 text-sm',
              message.mine ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted',
            )}
          >
            {!message.mine && <div className="text-xs opacity-70">{message.name}</div>}
            <span className="whitespace-pre-wrap break-words">{message.text}</span>
          </div>
        ))}
        {messages.length === 0 && (
          <p className="pt-6 text-center text-xs text-muted-foreground">
            Messages are end-to-end encrypted.
          </p>
        )}
      </div>
      <form
        className="flex gap-2 border-t p-2"
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
        <Button size="icon" type="submit" title="Send">
          <SendHorizonal />
        </Button>
      </form>
    </div>
  )
}
