import { memo, useEffect, useRef, useState } from 'react'
import { ArrowDown, Lock, SendHorizonal } from 'lucide-react'

import type { ChatMessage } from '@/lib/sfu'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface ChatPanelProps {
  messages: ChatMessage[]
  onSend: (text: string) => Promise<void>
}

export const ChatPanel = memo(function ChatPanel({ messages, onSend }: ChatPanelProps) {
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
          <Hint label="Jump to latest">
            <button
              type="button"
              onClick={() =>
                listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
              }
              aria-label="Jump to latest"
              className="absolute bottom-3 left-1/2 grid size-8 -translate-x-1/2 cursor-pointer place-items-center rounded-full border bg-background shadow-md"
            >
              <ArrowDown className="size-4" />
            </button>
          </Hint>
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
        {/* A disabled button swallows pointer events, so the trigger is
            the span around it and the tooltip survives the empty state. */}
        <Hint label="Send">
          <span className="inline-flex">
            <Button size="icon" type="submit" aria-label="Send" disabled={!text.trim()}>
              <SendHorizonal />
            </Button>
          </span>
        </Hint>
      </form>
    </div>
  )
})
