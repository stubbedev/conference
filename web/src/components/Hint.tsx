import type { ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface HintProps {
  label: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactNode
}

// The app's one tooltip style around an interactive control: the child
// becomes the trigger (asChild), so it must accept trigger props — a
// Button or any plain element. Give the child a matching aria-label;
// the tooltip itself only exists while hovered or focused.
export function Hint({ label, side = 'top', children }: HintProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
