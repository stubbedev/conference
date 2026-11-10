import { useEffect, useState, type RefObject } from 'react'
import { toast } from 'sonner'

import { useLatest } from '@/hooks/latest'
import {
  describeAskFailure,
  describeLostSpeaker,
  describeSinkFailure,
  detectAudioOutputs,
  planSink,
  type AudioOutputs,
} from '@/lib/audio-output'

export const audioOutputs: AudioOutputs = detectAudioOutputs(
  typeof HTMLMediaElement === 'undefined' ? undefined : HTMLMediaElement.prototype,
  typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
)

// One toast for every speaker problem: each playing element reports the
// same failure, and a newer report replaces the older one.
const SPEAKER_TOAST = 'speaker'

function reportSinkFailure(context: string, error: unknown): void {
  console.error(`media: ${context}`, error)
  toast.error(describeSinkFailure(error), { id: SPEAKER_TOAST })
}

// Opens the browser's own speaker list. It must run straight from the
// member's click, before anything is awaited, or the browser refuses it
// for want of a gesture.
export async function askForSpeaker(
  outputs: Extract<AudioOutputs, { picking: 'prompted' }>,
  remembered?: string,
): Promise<MediaDeviceInfo | null> {
  try {
    return await outputs.ask(remembered)
  } catch (err) {
    const message = describeAskFailure(err)
    if (message === null) {
      console.info('media: the speaker list was closed without a choice', err)
      return null
    }
    console.error('media: opening the browser speaker list', err)
    toast.error(message, { id: SPEAKER_TOAST })
    return null
  }
}

// Plays element through sinkId, '' being the system default. The sink
// is only ever one useSpeaker has already applied once, so a failure
// here means the device went away in between.
export function useAudioSink(ref: RefObject<HTMLMediaElement | null>, sinkId: string | undefined): void {
  useEffect(() => {
    const element = ref.current
    if (!element || sinkId === undefined || audioOutputs.picking === 'system') return
    if (element.sinkId === sinkId) return
    element.setSinkId(sinkId).catch((err: unknown) => reportSinkFailure(`playing through the speaker "${sinkId}"`, err))
  }, [ref, sinkId])
}

interface SpeakerOptions {
  /** The speaker the member chose, '' for the system default. */
  chosen: string
  speakers: readonly MediaDeviceInfo[]
  /** Whether the devices have been read since media was asked for. */
  devicesKnown: boolean
  /** Stores a new choice, '' going back to the system default. */
  choose: (deviceId: string) => void
}

// The sink call audio actually plays through. A chosen speaker is first
// applied to a detached element; only once that works do the playing
// elements follow, and when it cannot work the choice falls back to the
// system default with a toast saying why. While a new choice is being
// applied, the previous working sink keeps playing.
export function useSpeaker({ chosen, speakers, devicesKnown, choose }: SpeakerOptions): string {
  const [applied, setApplied] = useState('')
  const chooseRef = useLatest(choose)
  const plan = planSink(
    audioOutputs.picking,
    chosen,
    speakers.map((device) => device.deviceId),
    devicesKnown,
  )
  const target = plan.kind === 'try' || plan.kind === 'lost' ? plan.deviceId : ''

  if (plan.kind !== 'try' && applied !== '') setApplied('')

  useEffect(() => {
    if (plan.kind === 'lost') {
      chooseRef.current('')
      const outputs = audioOutputs
      toast.warning(describeLostSpeaker(outputs.picking), {
        id: SPEAKER_TOAST,
        action:
          outputs.picking === 'prompted'
            ? {
                label: 'Choose speaker',
                onClick: () => {
                  void askForSpeaker(outputs, target).then((device) => device && chooseRef.current(device.deviceId))
                },
              }
            : undefined,
      })
      return
    }
    if (plan.kind !== 'try') return
    let current = true
    new Audio().setSinkId(target).then(
      () => {
        if (current) setApplied(target)
      },
      (err: unknown) => {
        if (!current) return
        reportSinkFailure(`applying the speaker "${target}"`, err)
        chooseRef.current('')
      },
    )
    return () => {
      current = false
    }
  }, [plan.kind, target, chooseRef])

  return plan.kind === 'try' ? applied : ''
}
