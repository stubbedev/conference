import { RotateCw, TriangleAlert } from 'lucide-react'

import { TextHint } from '@/components/Hint'
import { overall } from '@/lib/speech/progress'
import type { Loading, LoadingPart, PartLoading } from '@/lib/translate/types'
import { cn } from '@/lib/utils'

const PART_LABELS: Record<LoadingPart, string> = {
  runtime: 'speech runtime',
  transcription: 'transcription',
  translation: 'translation',
  voice: 'voice',
}

const MEGABYTE = 1e6

function megabytes(bytes: number): string {
  return Math.round(bytes / MEGABYTE).toLocaleString('en')
}

function unfinished(part: PartLoading): boolean {
  return part.total === 0 || part.loaded < part.total
}

function caption(parts: readonly PartLoading[]): string {
  const retrying = parts.find((part) => part.retry !== null)
  if (retrying?.retry) {
    const { attempt, attempts, reason } = retrying.retry
    return `Retrying the ${PART_LABELS[retrying.part]} download (attempt ${attempt} of ${attempts}): ${reason}`
  }
  const waiting = parts.filter(unfinished).map((part) => PART_LABELS[part.part])
  return waiting.length > 0 ? `Loading ${waiting.join(', ')}` : 'Starting the speech models'
}

function LoadingBar({ parts }: { parts: readonly PartLoading[] }) {
  const { loaded, total } = overall(parts)
  const retrying = parts.some((part) => part.retry !== null)
  const label = caption(parts)

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total > 0 ? total : undefined}
      aria-valuenow={total > 0 ? loaded : undefined}
      className="flex w-72 max-w-full flex-col gap-1 rounded-2xl bg-background/85 px-3 py-1.5 text-xs font-medium backdrop-blur"
    >
      <span className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate">{label}</span>
        {total > 0 && (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {megabytes(loaded)} / {megabytes(total)} MB
          </span>
        )}
      </span>
      <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            'block h-full rounded-full transition-[width] duration-300',
            retrying ? 'bg-amber-400' : 'bg-primary',
            total === 0 && 'animate-pulse',
          )}
          style={{ width: total > 0 ? `${(Math.min(loaded, total) / total) * 100}%` : '100%' }}
        />
      </span>
    </div>
  )
}

function LoadingFailed({ reason, retry }: { reason: string; retry: () => void }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-destructive py-1 pr-1 pl-2.5 text-xs font-medium text-white">
      <TriangleAlert className="size-3 shrink-0" />
      <TextHint label={reason} side="bottom">
        <span className="truncate">Live translation could not load: {reason}</span>
      </TextHint>
      <button
        type="button"
        onClick={retry}
        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 transition-colors hover:bg-white/30"
      >
        <RotateCw className="size-3" />
        Retry
      </button>
    </span>
  )
}

export function SpeechLoading({ loading }: { loading: Loading }) {
  if (loading.state === 'failed') return <LoadingFailed reason={loading.reason} retry={loading.retry} />
  return <LoadingBar parts={loading.parts} />
}
