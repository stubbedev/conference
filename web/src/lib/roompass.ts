// Room passwords remembered per device so rejoining never prompts again.
// localStorage scope equals the #k= URL fragment's: it unlocks the room
// on this device only.

const PREFIX = 'conference:roompw:'

export function savedRoomPassword(slug: string): string {
  try {
    return localStorage.getItem(PREFIX + slug) ?? ''
  } catch {
    return ''
  }
}

export function rememberRoomPassword(slug: string, password: string): void {
  try {
    localStorage.setItem(PREFIX + slug, password)
  } catch {
    // Best effort: private browsing may refuse storage.
  }
}

export function forgetRoomPassword(slug: string): void {
  try {
    localStorage.removeItem(PREFIX + slug)
  } catch {
    // Ignore storage failures.
  }
}
