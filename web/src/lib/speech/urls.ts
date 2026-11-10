// Where the speech files are. The base path comes from the server's
// configuration and is normally written with a trailing slash, but nothing
// here should depend on that: one join keeps the workers from each
// inventing their own.

/** The joined path, with exactly one slash between the parts. */
export function modelURL(base: string, ...parts: string[]): string {
  const root = base.endsWith('/') ? base : `${base}/`
  return root + parts.map(trim).filter((part) => part.length > 0).join('/')
}

function trim(part: string): string {
  return part.replace(/^\/+|\/+$/g, '')
}
