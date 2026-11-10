import { cloneElement, type AriaAttributes, type FocusEvent, type ReactElement, type ReactNode } from 'react'
import { Tooltip } from 'radix-ui'

// The one tooltip provider, at the app root; a Hint outside it throws.
// Every hint shares the open delay, the skipped delay while the pointer
// runs along a row of buttons, and one-open-at-a-time. The content is not
// hoverable, so leaving the trigger closes it: a hoverable tooltip waits
// for a pointermove outside its grace area, and none comes when the
// pointer leaves the window, the usual way off the call bar.
export function HintProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={300} disableHoverableContent>
      {children}
    </Tooltip.Provider>
  )
}

// Radix opens a tooltip whenever its trigger gains focus without a press on
// it, which includes a menu or popover handing focus back after it closes
// and the window regaining focus; nothing closes it then until the trigger
// is hovered and left. Only keyboard focus shows it: preventing the event
// skips Radix's own focus handler.
function onlyKeyboardFocus(event: FocusEvent<HTMLButtonElement>) {
  if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
}

interface TextHintProps {
  label: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactElement
}

interface HintProps extends TextHintProps {
  /** The control's accessible name, where it deliberately differs from the label. */
  name?: string
  children: ReactElement<Pick<AriaAttributes, 'aria-label'>>
}

// The app's one tooltip style around a control, which it also names: the
// label is the control's accessible name unless `name` gives another.
// The child becomes the trigger (asChild), so it must accept trigger
// props — a Button or any plain element. The name is set on the child
// itself, replacing any aria-label written there: Slot lets a child's
// own props win over the trigger's, and the name has this one source.
export function Hint({ label, name = label, side, children }: HintProps) {
  return (
    <TextHint label={label} side={side}>
      {cloneElement(children, { 'aria-label': name })}
    </TextHint>
  )
}

// The same tooltip on something its own text already names, a status
// pill or a line cut short: it adds detail and leaves the name alone.
export function TextHint({ label, side = 'top', children }: TextHintProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild onFocus={onlyKeyboardFocus}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          data-slot="tooltip-content"
          side={side}
          sideOffset={4}
          className="bg-primary text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit max-w-64 origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance"
        >
          {label}
          <Tooltip.Arrow className="bg-primary fill-primary z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
