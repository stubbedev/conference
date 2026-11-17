import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { useLatest } from '@/hooks/latest'
import { usePersistentState } from '@/hooks/persistent'
import { forgetSample, rememberedSample, rememberSample, type OwnVoiceSample } from '@/lib/translate/own-voice'

function storedTrue(stored: unknown): boolean {
  return stored === true
}

/**
 * The speaker's own voice: the recording they make before (or during) the
 * call, kept on this device only when they ask to remember it, and their
 * consent that this meeting's server makes their voice from it. Without
 * that consent the recording never leaves this browser.
 */
export function useOwnVoice() {
  const [sample, setSample] = useState<OwnVoiceSample | null>(null)
  const sampleRef = useLatest(sample)
  const [remember, setRemember] = usePersistentState('conference:own-voice-remember', { parse: storedTrue })
  const [serverConsent, setServerConsent] = usePersistentState('conference:own-voice-server', { parse: storedTrue })

  useEffect(() => {
    // Not remembering: make sure no earlier copy is left on this device.
    if (!remember) {
      void forgetSample()
      return
    }
    let cancelled = false
    void rememberedSample().then((stored) => {
      if (!cancelled && stored) setSample((current) => current ?? stored)
    })
    return () => {
      cancelled = true
    }
  }, [remember])

  const changeSample = useCallback(
    (next: OwnVoiceSample | null) => {
      setSample(next)
      if (!next) void forgetSample()
      else if (remember) void rememberSample(next).catch(() => toast.error('Could not keep your voice on this device.'))
    },
    [remember],
  )

  const changeRemember = useCallback(
    (next: boolean) => {
      setRemember(next)
      if (!next) void forgetSample()
      else if (sampleRef.current) void rememberSample(sampleRef.current).catch(() => {})
    },
    [setRemember, sampleRef],
  )

  return {
    sample,
    remember,
    serverConsent,
    changeSample,
    changeRemember,
    setServerConsent,
    /** What the speech service may have: the recording, only with the speaker's consent. */
    forServer: serverConsent ? sample : null,
  }
}
