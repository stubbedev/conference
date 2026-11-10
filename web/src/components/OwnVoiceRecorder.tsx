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
  unprocessedMicrophone,
  type OwnVoiceSample,
} from '@/lib/translate/own-voice'
import { READING_TIPS, readingText } from '@/lib/translate/reading-texts'

export interface OwnVoiceControls {
  sample: OwnVoiceSample | null
  /** Keep the recording on this device for later calls. */
  remember: boolean
  micTrack: MediaStreamTrack | null
  /** The microphone the call uses ('' for the system default). */
  micDeviceId: string
  onSample: (sample: OwnVoiceSample | null) => void
  onRemember: (remember: boolean) => void
  /** The speaker agreed that this meeting's server may make their voice from the recording. */
  serverConsent: boolean
  onServerConsent: (consent: boolean) => void
}

interface OwnVoiceRecorderProps extends OwnVoiceControls {
  lang: string
}

// Recording the speaker's own voice, before or during the call; their
// translated voice is cloned from it.
export function OwnVoiceRecorder({
  lang,
  sample,
  remember,
  micTrack,
  micDeviceId,
  onSample,
  onRemember,
  serverConsent,
  onServerConsent,
}: OwnVoiceRecorderProps) {
  const [recording, setRecording] = useState<SampleRecorder | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [tooShort, setTooShort] = useState(false)
  const recordingRef = useRef(recording)
  const reading = readingText(lang)

  useEffect(() => {
    recordingRef.current = recording
  }, [recording])

  // A recording still running when the settings close is stopped and dropped.
  useEffect(() => () => recordingRef.current?.stop(), [])

  const record = async () => {
    if (!micTrack) return
    const recorder = new SampleRecorder(setSeconds)
    setSeconds(0)
    setTooShort(false)
    setRecording(recorder)
    // The voice is made from this recording, so it skips the call's audio
    // processing when the browser allows; otherwise it uses the call's track.
    const raw = await unprocessedMicrophone(micDeviceId)
    void recorder
      .start(raw ?? micTrack)
      .then((pcm) => {
        if (pcm.length < MIN_SAMPLE_SECONDS * SAMPLE_RATE) {
          setTooShort(true)
          return
        }
        onSample({ pcm, lang })
      })
      .finally(() => {
        raw?.stop()
        setRecording(null)
      })
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="server-voice" className="text-xs">
          Make my voice on this meeting's server
        </Label>
        <Switch id="server-voice" checked={serverConsent} onCheckedChange={onServerConsent} />
      </div>
      <p className="text-xs text-muted-foreground">
        Your recording is sent to this meeting's server, which makes your voice from it so everyone can hear it. Unlike
        the call itself, it is not end-to-end encrypted. The server keeps it only while you're in the call.
      </p>
      {recording ? (
        <>
          <p className="text-xs text-muted-foreground">{reading.read ? 'Read this aloud:' : 'Talk freely:'}</p>
          <p className="text-sm">{reading.text}</p>
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
            <Button size="sm" variant="ghost" onClick={() => void record()} disabled={!micTrack || !serverConsent} aria-label="Record again">
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
            {reading.read
              ? `Record yourself reading this aloud (${SAMPLE_SECONDS} s), and others hear your voice from your first sentence.`
              : `Record yourself talking for ${SAMPLE_SECONDS} s, and others hear your voice from your first sentence.`}{' '}
            Without a recording, they hear the female voice.
          </p>
          <p className="border-l-2 pl-2 text-sm">{reading.text}</p>
          <p className="text-xs text-muted-foreground">{READING_TIPS}</p>
          <Button size="sm" variant="secondary" onClick={() => void record()} disabled={!micTrack || !serverConsent}>
            <Mic /> Record my voice
          </Button>
          {!serverConsent && (
            <p className="text-xs text-muted-foreground">Allow the server above first to use your own voice.</p>
          )}
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
          This copy stays in this browser on this device until you delete it.
        </p>
      )}
    </div>
  )
}
