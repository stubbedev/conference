import { useEffect, useRef, useState } from 'react'
import { Mic, Square, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  MIN_SAMPLE_SECONDS,
  SAMPLE_RATE,
  SAMPLE_SECONDS,
  SampleRecorder,
  READING_TIPS,
  readingText,
  type OwnVoiceSample,
} from '@/lib/translate/own-voice'

export interface OwnVoiceControls {
  sample: OwnVoiceSample | null
  /** Keep the recording on this device for later calls. */
  remember: boolean
  micTrack: MediaStreamTrack | null
  onSample: (sample: OwnVoiceSample | null) => void
  onRemember: (remember: boolean) => void
}

interface OwnVoiceRecorderProps extends OwnVoiceControls {
  lang: string
}

// Recording the speaker's own voice, before or during the call; their
// translated voice is cloned from it.
export function OwnVoiceRecorder({ lang, sample, remember, micTrack, onSample, onRemember }: OwnVoiceRecorderProps) {
  const [recording, setRecording] = useState<SampleRecorder | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [tooShort, setTooShort] = useState(false)
  const recordingRef = useRef(recording)

  useEffect(() => {
    recordingRef.current = recording
  }, [recording])

  // A recording still running when the settings close is stopped and dropped.
  useEffect(() => () => recordingRef.current?.stop(), [])

  const record = () => {
    if (!micTrack) return
    const recorder = new SampleRecorder(setSeconds)
    setSeconds(0)
    setTooShort(false)
    setRecording(recorder)
    void recorder
      .start(micTrack)
      .then((pcm) => {
        if (pcm.length < MIN_SAMPLE_SECONDS * SAMPLE_RATE) {
          setTooShort(true)
          return
        }
        onSample({ pcm, lang })
      })
      .finally(() => setRecording(null))
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-2.5">
      {recording ? (
        <>
          <p className="text-xs text-muted-foreground">{READING_TIPS}</p>
          <p className="text-xs text-muted-foreground">{readingText(lang).read ? 'Read this aloud:' : 'Talk freely:'}</p>
          <p className="text-sm">{readingText(lang).text}</p>
          <Button size="sm" variant="secondary" onClick={() => recording.stop()}>
            <Square className="fill-current" /> Done ({Math.floor(seconds)} of {SAMPLE_SECONDS} s)
          </Button>
        </>
      ) : sample ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Your voice is recorded ({Math.round(sample.pcm.length / SAMPLE_RATE)} s) and used from your first sentence.
          </p>
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="ghost" onClick={record} disabled={!micTrack} aria-label="Record again">
              <Mic />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onSample(null)} aria-label="Delete my voice">
              <Trash2 />
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Record yourself reading a few sentences ({SAMPLE_SECONDS} s), and others hear your voice from your first
            sentence. Without a recording, they hear the female voice.
          </p>
          <Button size="sm" variant="secondary" onClick={record} disabled={!micTrack}>
            <Mic /> Record my voice
          </Button>
          {tooShort && (
            <p className="text-xs text-muted-foreground">
              That was under {MIN_SAMPLE_SECONDS} s; please read a little longer.
            </p>
          )}
        </>
      )}
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="remember-voice" className="text-xs text-muted-foreground">
          Remember my voice on this device
        </Label>
        <Switch id="remember-voice" checked={remember} onCheckedChange={onRemember} />
      </div>
      {remember && (
        <p className="text-xs text-muted-foreground">
          Kept only in this browser on this device, never on the server, until you delete it.
        </p>
      )}
    </div>
  )
}
