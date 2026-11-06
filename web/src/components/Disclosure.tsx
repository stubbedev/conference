import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

interface DisclosureProps {
  title: string
  children: ReactNode
  className?: string
  contentClassName?: string
}

/** A collapsed section: the settings behind it stay out of the way until asked for. */
export function Disclosure({ title, children, className, contentClassName }: DisclosureProps) {
  return (
    <Collapsible className={cn('rounded-lg border', className)}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="group w-full justify-between text-muted-foreground"
        >
          {title}
          <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn('px-3 pb-3', contentClassName)}>{children}</CollapsibleContent>
    </Collapsible>
  )
}
