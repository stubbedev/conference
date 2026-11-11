import { LAYER_RIDS } from './encodings.ts'
import type { Refused } from './sealed.ts'

export const MEDIA_UP = 'up'
export const SCREEN_UP = 'up-screen'
export const UPSTREAM_IDS = [MEDIA_UP, SCREEN_UP] as const
export type UpstreamId = (typeof UPSTREAM_IDS)[number]

export const DOWN_PREFIX = 'down-'
export type DownstreamId = `${typeof DOWN_PREFIX}${string}`

export function isUpstreamId(pc: string): pc is UpstreamId {
  return UPSTREAM_IDS.some((id) => id === pc)
}

function isDownstreamId(pc: string): pc is DownstreamId {
  return pc.startsWith(DOWN_PREFIX) && pc.length > DOWN_PREFIX.length
}

type Read<T> = (value: unknown, field: string) => T | Refused

type Shape = Record<string, Read<unknown>>

type Parsed<S extends Shape> = { [K in keyof S]: S[K] extends (value: unknown, field: string) => infer R ? Exclude<R, Refused> : never }

function isRefused(value: unknown): value is Refused {
  return typeof value === 'object' && value !== null && 'refused' in value
}

function check<T>(what: string, is: (value: unknown) => value is T): Read<T> {
  return (value, field) => (is(value) ? value : { refused: `its ${field} is not ${what}` })
}

const text = check('a string', (value): value is string => typeof value === 'string')
const label = check('a non-empty string', (value): value is string => typeof value === 'string' && value !== '')
const flag = check('a boolean', (value): value is boolean => typeof value === 'boolean')
const count = check('a whole number', (value): value is number => Number.isSafeInteger(value) && (value as number) >= 0)

function oneOf<const T extends string>(...values: readonly T[]): Read<T> {
  return check(`one of ${values.join(', ')}`, (value): value is T => values.some((one) => one === value))
}

function nullable<T>(read: Read<T>): Read<T | null> {
  return (value, field) => (value === null ? null : read(value, field))
}

function listOf<T>(item: Read<T>): Read<T[]> {
  return (value, field) => {
    if (!Array.isArray(value)) return { refused: `its ${field} is not a list` }
    const items: T[] = []
    for (const [i, entry] of value.entries()) {
      const read = item(entry, `${field}[${i}]`)
      if (isRefused(read)) return read
      items.push(read)
    }
    return items
  }
}

function nonEmpty<T>(list: Read<T[]>): Read<T[]> {
  return (value, field) => {
    const read = list(value, field)
    if (isRefused(read)) return read
    return read.length > 0 ? read : { refused: `its ${field} is empty` }
  }
}

function fieldsOf<S extends Shape>(shape: S, value: unknown, field: string): Parsed<S> | Refused {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { refused: field === '' ? 'it is not an object' : `its ${field} is not an object` }
  }
  const fields = value as Record<string, unknown>
  const parsed: Record<string, unknown> = {}
  for (const [key, read] of Object.entries(shape)) {
    const one = read(fields[key], field === '' ? key : `${field}.${key}`)
    if (isRefused(one)) return one
    parsed[key] = one
  }
  return parsed as Parsed<S>
}

function record<S extends Shape>(shape: S): Read<Parsed<S>> {
  return (value, field) => fieldsOf(shape, value, field)
}

const MEMBER = { id: label, short: count, name: label, mic: flag, cam: flag, sharing: flag }

export type MemberInfo = Parsed<typeof MEMBER>

const member = record(MEMBER)

const upstream = oneOf(...UPSTREAM_IDS)

const downstream = check('a downstream connection', (value): value is DownstreamId => typeof value === 'string' && isDownstreamId(value))

const connection = check(
  'a connection',
  (value): value is UpstreamId | DownstreamId => typeof value === 'string' && (isUpstreamId(value) || isDownstreamId(value)),
)

const layers = check(
  `a list of ${LAYER_RIDS.length} booleans`,
  (value): value is boolean[] => Array.isArray(value) && value.length === LAYER_RIDS.length && value.every((one) => typeof one === 'boolean'),
)

const SEALED = { from: label, iv: label, ct: label }

function variant<const T extends string, S extends Shape>(type: T, shape: S): { type: T; shape: S } {
  return { type, shape }
}

const VARIANTS = [
  variant('welcome', {
    self: member,
    members: listOf(member),
    iceServers: nonEmpty(listOf(record({ urls: nonEmpty(listOf(label)), username: label, credential: label }))),
    resume: label,
    recorder: text,
    translatingBy: text,
  }),
  variant('member-joined', { id: label, short: count, name: label, replaces: text }),
  variant('member-left', { id: label }),
  variant('member-state', { id: label, mic: flag, cam: flag, sharing: flag }),
  variant('error', { code: label, text: label }),
  variant('recording', { from: label, on: flag }),
  variant('translating', { from: label, on: flag }),
  variant('layers', { pc: upstream, mid: label, active: layers }),
  variant('lang', SEALED),
  variant('caption', SEALED),
  variant('chat', { ...SEALED, ts: count }),
  variant('forced', { action: oneOf('mute', 'cam', 'screen') }),
  variant('forced', { action: oneOf('lang'), ...SEALED }),
  variant('kicked', {}),
  variant('answer', { pc: upstream, sdp: label }),
  variant('offer', { pc: downstream, sdp: label, tracks: listOf(record({ mid: label, kind: label })) }),
  variant('ice', {
    pc: connection,
    candidate: record({ candidate: text, sdpMid: nullable(text), sdpMLineIndex: nullable(count), usernameFragment: nullable(text) }),
  }),
  variant('translate-token', { token: label }),
]

type MessageOf<V> = V extends { type: infer T; shape: infer S extends Shape } ? { type: T } & Parsed<S> : never

export type ServerMessage = MessageOf<(typeof VARIANTS)[number]>

export const SERVER_MESSAGE_SHAPES: readonly { type: string; fields: readonly string[] }[] = VARIANTS.map(({ type, shape }) => ({
  type,
  fields: Object.keys(shape),
}))

export function parseServerMessage(data: unknown): ServerMessage | Refused {
  if (typeof data !== 'string') return { refused: 'it is not text' }
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return { refused: 'it is not JSON' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { refused: 'it is not an object' }

  const { type } = value as { type?: unknown }
  const shapes = VARIANTS.filter((one) => one.type === type)
  if (shapes.length === 0) return { refused: `its type ${JSON.stringify(type)} is not one this client knows` }

  const refusals: string[] = []
  for (const shaped of shapes) {
    const fields = fieldsOf(shaped.shape, value, '')
    if (!isRefused(fields)) return { type: shaped.type, ...fields } as ServerMessage
    refusals.push(fields.refused)
  }
  return { refused: refusals.join(', or ') }
}
