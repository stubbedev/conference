import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

function pressOnKey(event: KeyboardEvent, press: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  press()
}

interface PinTargetProps {
  label: string
  onPin: () => void
  className?: string
  style?: CSSProperties
  children: ReactNode
}

export function PinTarget({ label, onPin, className, style, children }: PinTargetProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onPin}
      onKeyDown={(event) => pressOnKey(event, onPin)}
      className={cn('cursor-pointer', className)}
      style={style}
    >
      {children}
    </div>
  )
}

type Corner = { vertical: 'top' | 'bottom'; horizontal: 'left' | 'right' }

const DEFAULT_CORNER: Corner = { vertical: 'top', horizontal: 'left' }
const TAP_SLOP_PX = 8

interface Drag {
  pointerId: number
  x: number
  y: number
  moved: boolean
}

function nearestCorner(tile: DOMRect, area: DOMRect): Corner {
  return {
    vertical: tile.top + tile.height / 2 < area.top + area.height / 2 ? 'top' : 'bottom',
    horizontal: tile.left + tile.width / 2 < area.left + area.width / 2 ? 'left' : 'right',
  }
}

interface SelfViewProps {
  label: string
  inset: { top: number; bottom: number; side: number }
  size: { width: number; height: number }
  onTap: () => void
  children: ReactNode
}

export function SelfView({ label, inset, size, onTap, children }: SelfViewProps) {
  const [corner, setCorner] = useState<Corner>(DEFAULT_CORNER)
  const drag = useRef<Drag | null>(null)
  const area = useRef<HTMLDivElement>(null)

  const release = (tile: HTMLDivElement) => {
    drag.current = null
    tile.style.transform = ''
    tile.style.willChange = ''
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const x = event.clientX - current.x
    const y = event.clientY - current.y
    if (!current.moved) {
      if (Math.hypot(x, y) < TAP_SLOP_PX) return
      current.moved = true
      event.currentTarget.style.willChange = 'transform'
    }
    event.currentTarget.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const tile = event.currentTarget
    if (!current.moved) {
      release(tile)
      onTap()
      return
    }
    if (area.current) setCorner(nearestCorner(tile.getBoundingClientRect(), area.current.getBoundingClientRect()))
    release(tile)
  }

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => release(event.currentTarget)

  return (
    <div
      ref={area}
      className="pointer-events-none absolute z-10"
      style={{ top: inset.top, bottom: inset.bottom, left: inset.side, right: inset.side }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        data-corner={`${corner.vertical}-${corner.horizontal}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={(event) => pressOnKey(event, onTap)}
        className={cn(
          'pointer-events-auto absolute cursor-grab touch-none rounded-xl shadow-lg select-none active:cursor-grabbing',
          corner.vertical === 'top' ? 'top-0' : 'bottom-0',
          corner.horizontal === 'left' ? 'left-0' : 'right-0',
        )}
        style={{ width: size.width, height: size.height }}
      >
        {children}
      </div>
    </div>
  )
}
