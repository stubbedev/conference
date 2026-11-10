// JSON values in localStorage. A blocked or full store fails on every
// read and write, so each key reports each kind of failure once, and the
// caller carries on with what it holds in memory.
const reported = new Set<string>()

function reportOnce(attempt: string, err: unknown): void {
  if (reported.has(attempt)) return
  reported.add(attempt)
  console.warn(`storage: ${attempt}`, err)
}

// Whatever is stored under key, still to be parsed: an older build or a
// hand edit may have left anything there. Undefined when nothing is
// stored or it cannot be read.
export function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? undefined : JSON.parse(raw)
  } catch (err) {
    reportOnce(`reading "${key}", so it starts from its default`, err)
    return undefined
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    reportOnce(`saving "${key}", so it lasts only until the page is closed`, err)
  }
}

// The fields of a stored object, each still to be checked; none when
// what was stored is not an object.
export function storedFields<T>(stored: unknown): Partial<Record<keyof T, unknown>> {
  return typeof stored === 'object' && stored !== null ? stored : {}
}
