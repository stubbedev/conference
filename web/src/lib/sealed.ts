// What members seal for each other the server can neither read nor
// check, so to the member who opens it, it is untrusted input: each kind
// is parsed where it is opened, every field checked and bounded and
// nothing else kept, or refused with the reason.

/** Why something that arrived sealed is not handed on. */
export interface Refused {
  refused: string
}

/**
 * The longest chat message, in UTF-16 units. Sealed, even one that
 * takes three bytes a unit stays inside what the server relays.
 */
export const CHAT_TEXT_MAX = 4000

export interface ChatText {
  text: string
}

/** parseChatText reads the text of a chat message another member sealed. */
export function parseChatText(text: string): ChatText | Refused {
  if (text === '') return { refused: 'it is empty' }
  if (text.length > CHAT_TEXT_MAX) return { refused: `it is longer than ${CHAT_TEXT_MAX} characters` }
  return { text }
}

/**
 * Refusals says in the log what is dropped and why. A member whose build
 * or intent sends one message that is refused sends many, so each reason
 * is said once, with the first sender it came from.
 */
export class Refusals {
  private readonly said = new Set<string>()
  private readonly log: (line: string, ...detail: unknown[]) => void

  constructor(log: (line: string, ...detail: unknown[]) => void) {
    this.log = log
  }

  report(what: string, from: string, reason: string, ...detail: unknown[]): void {
    const key = `${what}\n${reason}`
    if (this.said.has(key)) return
    this.said.add(key)
    this.log(`dropping ${what} from ${from}, and every later one like it: ${reason}`, ...detail)
  }
}
