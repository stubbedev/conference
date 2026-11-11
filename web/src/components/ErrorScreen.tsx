import { CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

interface ErrorScreenProps {
  title: string
  message: string
  children: ReactNode
}

export function ErrorScreen({ title, message, children }: ErrorScreenProps) {
  return (
    <div className="grid h-dvh place-items-center">
      <div className="grid max-w-md gap-3 px-4 text-center">
        <CircleAlert className="mx-auto size-8 text-muted-foreground" />
        <p className="text-lg font-medium">{title}</p>
        <p className="text-sm break-words text-muted-foreground">{message}</p>
        {children}
      </div>
    </div>
  )
}
