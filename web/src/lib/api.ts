import type { SpeechModels } from './speech/models.ts'
import type { Language } from './translate/languages.ts'

export interface ServerConfig {
  createAuthRequired: boolean
  sessionLifetimeDays: number
  joinOnly: boolean
  /** Live translation: its settings only appear once the server can do it. */
  translation: TranslationConfig
}

/** The machine that runs the speech engines. */
export type SpeechRuntime = 'server' | 'browser'

export interface TranslationConfig {
  /** All the speech engines are set up, or the browsers have their models. */
  available: boolean
  /**
   * What is missing before it can translate. For whoever runs it to read, in
   * /api/config: the app shows nothing about translation until this is empty.
   */
  reason?: string
  /** Whether this server transcribes, or every member's browser does. */
  mode: SpeechRuntime
  /** The stand-in engines, which answer without a model or a GPU. */
  fake?: boolean
  /** The models the browsers load, when they run the engines. */
  models?: SpeechModels
  /** The languages the speech service speaks. */
  languages: Language[]
  /** Speech or text goes to a service outside the server's network. */
  external: boolean
}

export interface RoomInfo {
  slug: string
  name: string
  requiresPassword: boolean
  members: number
  maxMembers: number
  authSalt?: string
  keySalt?: string
}

export interface CreatedRoom {
  slug: string
  name: string
  roomKey: string
  privToken: string
  privPath: string
  shortPath: string
  baseUrl?: string
  maxMembers: number
}

export interface AuthResult {
  session: string
  priv: boolean
  key?: string
  keyblob?: string
  keySalt?: string
}

export interface CreateRoomInput {
  name: string
  password: string
  maxMembers: number
}

// Why the server refused: the message in its JSON, or the status when the
// answer is not the server's own, as with a proxy's error page.
async function refusal(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => undefined)
  const message = typeof body === 'object' && body !== null && 'message' in body ? body.message : undefined
  return typeof message === 'string' && message !== '' ? message : `The server answered ${res.status} ${res.statusText}`.trimEnd()
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) throw new Error(await refusal(res))
  try {
    return (await res.json()) as T
  } catch (err) {
    throw new Error(`The server answered ${path} with something that is not JSON`, { cause: err })
  }
}

export const api = {
  config: () => request<ServerConfig>('/api/config'),

  createRoom: (input: CreateRoomInput, apiKey: string) =>
    request<CreatedRoom>('/api/rooms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        name: input.name,
        password: input.password,
        maxMembers: input.maxMembers,
      }),
    }),

  roomInfo: (slug: string) => request<RoomInfo>(`/api/rooms/${encodeURIComponent(slug)}`),

  auth: (slug: string, payload: { token?: string; proof?: string }) =>
    request<AuthResult>(`/api/rooms/${encodeURIComponent(slug)}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
}
