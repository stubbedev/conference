import { Globe, Laptop } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { TranslationConfig } from '@/lib/api'
import { isVoiceChoice, type LangPrefs } from '@/lib/translate/types'

interface TranslationSettingsProps {
  config: TranslationConfig
  prefs: LangPrefs
  onChange: (prefs: LangPrefs) => void
}

// The language this member speaks, and how translations of everyone else
// reach them. Only rendered once live translation can run: what has to be
// configured is a job for whoever runs the server, not something to hand
// to the people in a call.
export function TranslationSettings({ config, prefs, onChange }: TranslationSettingsProps) {
  // Until the server configuration is read there is no list, but the setting still shows.
  const languages = config.languages.length > 0 ? config.languages : [{ code: prefs.lang, name: 'Not available' }]
  // A browser speaks each language in the one voice the server chose for it.
  const chooseVoice = config.mode === 'server'

  return (
    <div className="flex flex-col gap-3">
      {config.mode === 'browser' ? (
        <p className="flex gap-1.5 text-xs text-muted-foreground">
          <Laptop className="mt-px size-3.5 shrink-0" />
          <span>Live translation runs in your browser: your speech and its translation never leave this device.</span>
        </p>
      ) : (
        config.external && (
          <p className="flex gap-1.5 text-xs text-muted-foreground">
            <Globe className="mt-px size-3.5 shrink-0" />
            <span>Live translation via an external service: speech and text leave this server's network.</span>
          </p>
        )
      )}
      <fieldset className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="my-language" className="text-xs text-muted-foreground">
            My language
          </Label>
          <Select value={prefs.lang} onValueChange={(lang) => onChange({ ...prefs, lang })}>
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
        {chooseVoice ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="my-translated-voice" className="text-xs text-muted-foreground">
              Others hear me translated in a
            </Label>
            <Select
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
        ) : (
          <p className="text-xs text-muted-foreground">
            Others hear you in the voice your server picked for their language.
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="translated-voice" className="text-xs text-muted-foreground">
            Translated voice
          </Label>
          <Switch
            id="translated-voice"
           
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
           
            checked={prefs.subtitles}
            onCheckedChange={(subtitles) => onChange({ ...prefs, subtitles })}
          />
        </div>
      </fieldset>
    </div>
  )
}
