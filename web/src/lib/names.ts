const ADJECTIVES = [
  'amber', 'ancient', 'arctic', 'autumn', 'brave', 'bright', 'calm', 'cheerful',
  'clever', 'coastal', 'cosmic', 'crisp', 'curious', 'daring', 'dawn', 'drifting',
  'eager', 'ember', 'gentle', 'glassy', 'golden', 'hidden', 'ivory', 'jolly',
  'lucky', 'mellow', 'mighty', 'misty', 'noble', 'northern', 'peaceful', 'playful',
  'quiet', 'rapid', 'silent', 'silver', 'smooth', 'sunny', 'tranquil', 'velvety',
  'wandering', 'wise', 'witty', 'zesty',
]

const NOUNS = [
  'aurora', 'badger', 'beacon', 'birch', 'bison', 'brook', 'canyon', 'cedar',
  'comet', 'cove', 'crater', 'cricket', 'dune', 'eagle', 'echo', 'falcon',
  'fern', 'finch', 'flint', 'fox', 'glacier', 'granite', 'harbor', 'heron',
  'juniper', 'lagoon', 'lantern', 'lynx', 'maple', 'meadow', 'nebula', 'oak',
  'orbit', 'osprey', 'penguin', 'pine', 'quasar', 'raven', 'ridge', 'river',
  'robin', 'sage', 'salmon', 'sparrow', 'summit', 'willow', 'wren',
]

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)]
}

function capitalize(word: string): string {
  return word[0].toUpperCase() + word.slice(1)
}

export function randomDisplayName(): string {
  return `${capitalize(pick(ADJECTIVES))} ${capitalize(pick(NOUNS))}`
}

// The name a member last went by, or a fresh random one when nothing
// usable is stored.
export function storedDisplayName(stored: unknown): string {
  return typeof stored === 'string' ? stored : randomDisplayName()
}

const AVATAR_COLORS = ['bg-sky-600', 'bg-emerald-600', 'bg-violet-600', 'bg-amber-600', 'bg-rose-600', 'bg-teal-600', 'bg-indigo-600'] as const

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0] ?? ''
  const letters = words.length > 1 ? `${first[0] ?? ''}${words.at(-1)?.[0] ?? ''}` : first.slice(0, 2)
  return letters.toUpperCase() || '?'
}

export function avatarColor(id: string): string {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0]
}
