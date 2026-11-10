const COMPRESSION_RATIO = 2.4

const CREDITS = [' amara org ', ' zdf fur funk ', ' untertitelung des zdf ', ' nicolai winther ', ' societe radio canada ']

const INVENTED = new Set(
  [
    'you',
    'thank you for watching',
    'thanks for watching',
    'thank you for watching and see you next time',
    'vielen dank furs zuschauen',
    'tak fordi du sa med',
    'merci d avoir regarde',
    'gracias por ver',
    'grazie per la visione',
    'dziekuje za obejrzenie',
    'obrigado por assistir',
    'bedankt voor het kijken',
    'tack for att du tittade',
    'kiitos katsomisesta',
    'спасибо за просмотр',
    'дякую за перегляд',
  ].map(normalized),
)

export function normalized(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function annotation(text: string): boolean {
  return /^\s*(?:[[(*♪♫].*[\])*♪♫]|[♪♫\s]+)\s*$/u.test(text)
}

function credit(words: string): boolean {
  const padded = ` ${words} `
  return CREDITS.some((marker) => padded.includes(marker))
}

async function compressionRatio(text: string): Promise<number> {
  const bytes = new TextEncoder().encode(text)
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const compressed = await new Response(stream).arrayBuffer()
  return bytes.length / Math.max(compressed.byteLength, 1)
}

export async function invented(text: string): Promise<boolean> {
  const words = normalized(text)
  if (!words || annotation(text) || INVENTED.has(words) || credit(words)) return true
  return (await compressionRatio(text)) > COMPRESSION_RATIO
}
