export interface ICEServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface ServerConfig {
  iceServers: ICEServer[]
  createAuthRequired: boolean
  sessionLifetimeDays: number
  joinOnly: boolean
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = (body as { message?: string }).message ?? res.statusText
    throw new Error(message)
  }
  return body as T
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
