import { errorName, errorText } from './errors.ts'

export function describeTrackOpenError(device: string, error: unknown): string {
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Your browser is blocking the ${device}. Allow it in the site settings next to the address bar, then try again.`
    case 'NotFoundError':
      return `No ${device} was found. Connect one, then try again.`
    case 'NotReadableError':
    case 'AbortError':
      return `The ${device} could not be started; another app may be using it. Close that app, then try again.`
    case 'OverconstrainedError':
      return `The selected ${device} is not available.`
    default:
      return `The ${device} could not be opened (${errorText(error)}).`
  }
}
