import site from '../../brand/site.json'
import { cn } from '@/lib/utils'

const mask = `url(${site.images.logo}) center / contain no-repeat`

export function Logo({ className }: { className?: string }) {
  return <span role="img" aria-label={site.name} className={cn('block bg-foreground', className)} style={{ mask }} />
}
