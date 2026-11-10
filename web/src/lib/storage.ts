// The app's values in localStorage, and the only module that touches it.
// A blocked or full store fails on every read and write, so each key
// reports each kind of failure once, and the caller carries on with what
// it holds in memory.
const reported = new Set<string>()

function reportOnce(attempt: string, err: unknown): void {
  if (reported.has(attempt)) return
  reported.add(attempt)
  console.warn(`storage: ${attempt}`, err)
}

function read<T>(key: string, decode: (text: string) => T): T | undefined {
  try {
    const text = localStorage.getItem(key)
    return text === null ? undefined : decode(text)
  } catch (err) {
    reportOnce(`reading "${key}", so it starts from its default`, err)
    return undefined
  }
}

function write(key: string, encode: () => string): void {
  try {
    localStorage.setItem(key, encode())
  } catch (err) {
    reportOnce(`saving "${key}", so it lasts only until the page is closed`, err)
  }
}

// Whatever JSON is stored under key, still to be parsed: an older build
// or a hand edit may have left anything there. Undefined when nothing is
// stored or it cannot be read.
export function readStored(key: string): unknown {
  return read(key, JSON.parse)
}

export function writeStored(key: string, value: unknown): void {
  write(key, () => JSON.stringify(value))
}

// The same for a key that holds bare text rather than JSON.
export function readStoredText(key: string): string | undefined {
  return read(key, (text) => text)
}

export function writeStoredText(key: string, text: string): void {
  write(key, () => text)
}

// Clears out every key that starts with prefix: a family of keys the app
// no longer writes.
export function removeStoredWithPrefix(prefix: string): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    for (const key of keys) if (key?.startsWith(prefix)) localStorage.removeItem(key)
  } catch (err) {
    reportOnce(`removing the keys that start with "${prefix}", so they stay stored`, err)
  }
}

// The fields of a stored object, each still to be checked; none when
// what was stored is not an object.
export function storedFields<T>(stored: unknown): Partial<Record<keyof T, unknown>> {
  return typeof stored === 'object' && stored !== null ? stored : {}
}
