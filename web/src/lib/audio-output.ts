// Where call audio plays, and how this browser lets a member choose it.
// Three shapes exist, told apart by the APIs themselves:
//   listed:   HTMLMediaElement.setSinkId, and enumerateDevices lists the
//             outputs once the microphone is allowed (Chromium);
//   prompted: setSinkId plus mediaDevices.selectAudioOutput, the browser's
//             own picker, which also exposes the chosen device to
//             enumerateDevices (Firefox);
//   system:   no setSinkId, so every element plays through the system
//             output (Safari).

import { errorName, errorText } from './errors.ts'

interface OutputPicker {
  selectAudioOutput(options: { deviceId?: string }): Promise<MediaDeviceInfo>
}

export type AudioOutputs =
  | { picking: 'listed' }
  | { picking: 'prompted'; ask: (deviceId?: string) => Promise<MediaDeviceInfo> }
  | { picking: 'system' }

export type OutputPicking = AudioOutputs['picking']

function hasPicker(devices: object): devices is OutputPicker {
  return 'selectAudioOutput' in devices && typeof devices.selectAudioOutput === 'function'
}

export function detectAudioOutputs(element: object | undefined, devices: object | undefined): AudioOutputs {
  if (!element || !('setSinkId' in element)) return { picking: 'system' }
  if (devices && hasPicker(devices)) {
    return { picking: 'prompted', ask: (deviceId) => devices.selectAudioOutput(deviceId ? { deviceId } : {}) }
  }
  return { picking: 'listed' }
}

// What to do with the speaker a member chose. A device the browser does
// not list yet may still appear once the microphone has been allowed
// (both Chromium and Firefox hide outputs until then), so it is only
// lost once the devices have been read after asking for media.
export type SinkPlan =
  | { kind: 'default' }
  | { kind: 'wait' }
  | { kind: 'try'; deviceId: string }
  | { kind: 'lost'; deviceId: string }

export function planSink(
  picking: OutputPicking,
  chosen: string,
  listed: readonly string[],
  devicesKnown: boolean,
): SinkPlan {
  if (picking === 'system' || chosen === '') return { kind: 'default' }
  if (listed.includes(chosen)) return { kind: 'try', deviceId: chosen }
  return devicesKnown ? { kind: 'lost', deviceId: chosen } : { kind: 'wait' }
}

const ON_DEFAULT = 'Call audio plays through the system default.'

export function describeLostSpeaker(picking: OutputPicking): string {
  return picking === 'prompted'
    ? `The browser needs you to choose the speaker again. ${ON_DEFAULT}`
    : `The speaker you chose is not connected. ${ON_DEFAULT}`
}

export function describeSinkFailure(error: unknown): string {
  switch (errorName(error)) {
    case 'NotFoundError':
      return `The speaker you chose is not available. ${ON_DEFAULT}`
    case 'NotAllowedError':
      return `The browser did not allow playing through the speaker you chose. ${ON_DEFAULT}`
    case 'AbortError':
      return `The speaker you chose could not be started. ${ON_DEFAULT}`
    default:
      return `The speaker you chose could not be used (${errorText(error)}). ${ON_DEFAULT}`
  }
}

// Null when the member closed the browser's picker without choosing,
// which the specification reports as NotAllowedError: nothing failed,
// and the previous speaker simply stays.
export function describeAskFailure(error: unknown): string | null {
  switch (errorName(error)) {
    case 'NotAllowedError':
      return null
    case 'InvalidStateError':
      return 'The browser only opens its speaker list right after a click. Try again.'
    case 'NotFoundError':
      return 'The browser found no speakers to choose from.'
    default:
      return `The browser's speaker list could not be opened (${errorText(error)}).`
  }
}
