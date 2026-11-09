export function describeTrackOpenError(device: string, err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  switch (name) {
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
  }
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return `The ${device} could not be opened (${detail}).`
}
