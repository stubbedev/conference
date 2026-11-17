import { AudioLines, Circle, Languages, Link2, TriangleAlert } from 'lucide-react'

import { Hint, TextHint } from '@/components/Hint'
import { SpeechLoading } from '@/components/SpeechLoading'
import type { TranslationConfig } from '@/lib/api'
import type { MemberInfo } from '@/lib/sfu'
import { languageName, type Language } from '@/lib/translate/languages'
import type { TranslatorStatus } from '@/lib/translate/types'

const TRANSLATOR_STATE_LABELS: Record<TranslatorStatus['state'], string> = {
  claiming: 'starting…',
  connecting: 'connecting…',
  live: 'live',
  retrying: 'reconnecting…',
  failed: 'failed',
}

function translationLabel(config: TranslationConfig): string {
  if (config.mode === 'browser') return 'Live translation in your browser'
  return config.external ? 'Live translation via an external service' : 'Live translation'
}

function translationWarnings(status: TranslatorStatus, selfLang: string, languages: readonly Language[]): string[] {
  const warnings: string[] = []
  if ((status.state === 'failed' || status.state === 'live') && status.detail && status.loading?.state !== 'failed') {
    warnings.push(status.detail)
  }
  if (status.sameLanguage) {
    warnings.push(`Everyone here speaks ${languageName(languages, selfLang)}: nothing to translate`)
  }
  if (status.failedTranslations > 0) {
    warnings.push(`${status.failedTranslations} sentence${status.failedTranslations === 1 ? '' : 's'} sent untranslated`)
  }
  if (status.droppedVoices > 0) {
    warnings.push(
      `${status.droppedVoices} translated voice${status.droppedVoices === 1 ? '' : 's'} skipped: the voice engine fell behind`,
    )
  }
  return warnings
}

// Where this member's own voice stands, while they have chosen it.
function ownVoiceLabel(status: TranslatorStatus, recorded: boolean, serverConsent: boolean): string {
  if (!serverConsent) return 'Allow your voice on the server in the settings (female voice for now)'
  if (status.ownVoice === 'ready') return 'Your own voice is in use'
  if (status.ownVoice === 'rejected') return 'Your recording was too short: record again (female voice for now)'
  if (!recorded) return 'Record your voice in the settings (female voice for now)'
  return 'Preparing your voice…'
}

interface RoomHeaderProps {
  title: string
  onTitleTap: () => void
  recorder: string | null
  translation: TranslationConfig
  translationBy: string | null
  selfId: string
  members: readonly MemberInfo[]
  translatorStatus: TranslatorStatus | null
  translationFailure: string
  onDismissFailure: () => void
  lang: string
  /** Set while this member has chosen their own voice and the server offers it. */
  ownVoice?: { recorded: boolean; serverConsent: boolean }
}

export function RoomHeader({
  title,
  onTitleTap,
  recorder,
  translation,
  translationBy,
  selfId,
  members,
  translatorStatus,
  translationFailure,
  onDismissFailure,
  lang,
  ownVoice,
}: RoomHeaderProps) {
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex p-4">
      <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-2 [&>*]:shadow-sm">
        <Hint label="Copy invite link (tap 5× for diagnostics)" name="Copy invite link" side="bottom">
          <button
            type="button"
            onClick={onTitleTap}
            className="group flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full bg-background/85 px-3 py-1.5 text-sm font-medium backdrop-blur transition-colors hover:bg-background"
          >
            <span className="hud-title max-w-48 truncate sm:max-w-80">{title}</span>
            <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </Hint>
        {recorder && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-destructive px-2.5 py-1 text-xs font-medium text-white">
            <Circle className="size-2 animate-pulse fill-current" />
            Recording
          </span>
        )}
        {translationBy && (
          <TextHint
            label={[
              `Started by ${translationBy === selfId ? 'you' : (members.find((m) => m.id === translationBy)?.name ?? 'someone')}.`,
              translatorStatus?.detail ?? '',
            ].join(' ')}
            side="bottom"
          >
            <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-background/85 px-2.5 py-1 text-xs font-medium backdrop-blur">
              <Languages className="size-3 shrink-0" />
              <span className="truncate">
                {translationLabel(translation)}
                {translatorStatus && ` · ${TRANSLATOR_STATE_LABELS[translatorStatus.state]}`}
              </span>
            </span>
          </TextHint>
        )}
        {translationFailure && (
          <TextHint label={`${translationFailure} Click to dismiss.`} side="bottom">
            <button
              type="button"
              onClick={onDismissFailure}
              className="flex min-w-0 items-center gap-1.5 rounded-full bg-destructive px-2.5 py-1 text-xs font-medium text-white"
            >
              <TriangleAlert className="size-3 shrink-0" />
              <span className="truncate">Live translation failed: {translationFailure}</span>
            </button>
          </TextHint>
        )}
        {translatorStatus && translationBy && ownVoice && (
          <TextHint label="Others hear your translations in a voice made from your recording." side="bottom">
            <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              <AudioLines className="size-3 shrink-0" />
              <span className="truncate">{ownVoiceLabel(translatorStatus, ownVoice.recorded, ownVoice.serverConsent)}</span>
            </span>
          </TextHint>
        )}
        {translatorStatus?.loading && <SpeechLoading loading={translatorStatus.loading} />}
        {translatorStatus && translationWarnings(translatorStatus, lang, translation.languages).map((warning) => (
          <TextHint key={warning} label={warning} side="bottom">
            <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-amber-400 px-2.5 py-1 text-xs font-medium text-black">
              <TriangleAlert className="size-3 shrink-0" />
              <span className="truncate">{warning}</span>
            </span>
          </TextHint>
        ))}
      </div>
    </header>
  )
}
