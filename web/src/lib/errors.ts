// What a caught value says, for the page, the console and other errors
// to carry: anything can be thrown, so each of these takes unknown.

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
