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
