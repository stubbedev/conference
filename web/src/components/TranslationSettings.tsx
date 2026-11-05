import { Globe, Info } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { TranslationConfig } from '@/lib/api'
import { isVoiceChoice, type LangPrefs } from '@/lib/translate/types'
import { cn } from '@/lib/utils'

interface TranslationSettingsProps {
  config: TranslationConfig
  prefs: LangPrefs
  onChange: (prefs: LangPrefs) => void
}

// The language this member speaks, and how translations of everyone else
// reach them. Always shown; greyed out with what has to be set up first
// while the speech service cannot translate.
export function TranslationSettings({ config, prefs, onChange }: TranslationSettingsProps) {
  const disabled = !config.available
  // Until the server configuration is read there is no list, but the setting still shows.
  const languages = config.languages.length > 0 ? config.languages : [{ code: prefs.lang, name: 'Not available' }]
  return (
    <div className="flex flex-col gap-3">
      {disabled && (
        <p className="flex gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" />
          <span>{config.reason || 'Live translation is not available on this server.'}</span>
        </p>
      )}
      {!disabled && config.external && (
        <p className="flex gap-1.5 text-xs text-muted-foreground">
          <Globe className="mt-px size-3.5 shrink-0" />
          <span>Live translation via an external service: speech and text leave this server's network.</span>
        </p>
      )}
      <fieldset
        disabled={disabled}
        title={disabled ? config.reason : undefined}
        className={cn('flex min-w-0 flex-col gap-3', disabled && 'opacity-50')}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="my-language" className="text-xs text-muted-foreground">
            My language
          </Label>
          <Select value={prefs.lang} onValueChange={(lang) => onChange({ ...prefs, lang })} disabled={disabled}>
            <SelectTrigger id="my-language" className="w-full">
              <span className="min-w-0 flex-1 truncate text-left">
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              {languages.map((language) => (
                <SelectItem key={language.code} value={language.code}>
                  {language.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="my-translated-voice" className="text-xs text-muted-foreground">
            Others hear me translated in a
          </Label>
          <Select
            disabled={disabled}
            value={prefs.voiceChoice}
            onValueChange={(choice) => {
              if (isVoiceChoice(choice)) onChange({ ...prefs, voiceChoice: choice })
            }}
          >
            <SelectTrigger id="my-translated-voice" className="w-full">
              <span className="min-w-0 flex-1 truncate text-left">
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="female">Female voice</SelectItem>
              <SelectItem value="male">Male voice</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="translated-voice" className="text-xs text-muted-foreground">
            Translated voice
          </Label>
          <Switch
            id="translated-voice"
            disabled={disabled}
            checked={prefs.voice}
            onCheckedChange={(voice) => onChange({ ...prefs, voice })}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="subtitles" className="text-xs text-muted-foreground">
            Subtitles
          </Label>
          <Switch
            id="subtitles"
            disabled={disabled}
            checked={prefs.subtitles}
            onCheckedChange={(subtitles) => onChange({ ...prefs, subtitles })}
          />
        </div>
      </fieldset>
    </div>
  )
}
