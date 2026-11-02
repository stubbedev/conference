import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import site from './site.json' with { type: 'json' }

const glyphs = {
  c: 'M 15.957031 26.009766 C 15.454904 26.011467 14.954555 26.039661 14.458984 26.09375 C 13.137463 26.237988 11.847214 26.564709 10.640625 27.064453 C 5.8142702 29.063428 1.9980469 33.93325 1.9980469 40 C 1.9980469 46.06675 5.8142702 50.936572 10.640625 52.935547 C 15.46698 54.934522 21.608905 54.189267 25.898438 49.898438 L 20.240234 44.242188 C 18.230116 46.252913 15.837671 46.427053 13.703125 45.542969 C 11.568579 44.658884 9.9980469 42.842566 9.9980469 40 C 9.9980469 37.157434 11.568579 35.341116 13.703125 34.457031 C 15.837671 33.572947 18.230116 33.747087 20.240234 35.757812 L 25.898438 30.101562 C 23.083432 27.285707 19.471922 25.997855 15.957031 26.009766 z',
  n: 'M 30 26 L 30 40 L 30 54 L 38 54 L 38 40 C 38 36.638908 40.638909 34 44 34 C 47.361091 34 50 36.638908 50 40 L 50 54 L 58 54 L 58 40 C 58 32.31539 51.684604 26 44 26 C 41.848479 26 39.828309 26.536424 38 27.417969 L 38 26 L 30 26 z',
  f: 'M 74 10 C 67.419962 10 62 15.419962 62 22 L 62 26 L 59 26 L 59 34 L 62 34 L 62 54 L 70 54 L 70 34 L 77 34 L 77 26 L 70 26 L 70 22 C 70 19.743482 71.743482 18 74 18 L 79 18 L 79 10 L 74 10 z',
}

const glyphBox = { x: 2, y: 10, width: 77, height: 44 }

const front = [
  { glyph: 'c', hollow: false },
  { glyph: 'n', hollow: true },
  { glyph: 'f', hollow: false },
]

const marks = {
  logo: { echoes: 11, step: 1, echoWidth: 0.28, hollowWidth: 0.5, padding: 1.12 },
  favicon: { echoes: 4, step: 2, echoWidth: 1.1, hollowWidth: 2.2, padding: 1.02 },
}

const publicDir = path.resolve(import.meta.dirname, '../public')
const publicPath = (url) => path.join(publicDir, url)

function viewBox({ echoes, step, padding }) {
  const trail = echoes * step
  const width = glyphBox.width + trail
  const height = glyphBox.height + trail
  const side = Math.max(width, height) * padding
  const x = glyphBox.x - (side - width) / 2
  const y = glyphBox.y - trail - (side - height) / 2
  return [x, y, side, side].map((n) => +n.toFixed(2)).join(' ')
}

function markBody({ echoes, step, echoWidth, hollowWidth }) {
  const defs = Object.entries(glyphs).map(([id, d]) => `<path id="${id}" d="${d}"/>`)
  const knockout = front.map(({ glyph }) => `<use href="#${glyph}" fill="#000"/>`)
  const trail = Array.from({ length: echoes }, (_, i) => (echoes - i) * step).flatMap((offset) =>
    front.map(({ glyph }) => `<use href="#${glyph}" transform="translate(${offset} ${-offset})"/>`),
  )
  const letters = front.map(({ glyph, hollow }) =>
    hollow
      ? `<use href="#${glyph}" fill="none" stroke="currentColor" stroke-width="${hollowWidth}"/>`
      : `<use href="#${glyph}" fill="currentColor"/>`,
  )
  return [
    `<defs>${defs.join('')}<mask id="knockout"><rect x="-1000" y="-1000" width="2000" height="2000" fill="#fff"/>${knockout.join('')}</mask></defs>`,
    `<g mask="url(#knockout)" fill="none" stroke="currentColor" stroke-width="${echoWidth}">${trail.join('')}</g>`,
    letters.join(''),
  ].join('\n  ')
}

function themedMark(spec) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="${viewBox(spec)}">
  <title>${site.name}</title>
  <style>svg{color:${site.ink}}@media (prefers-color-scheme: dark){svg{color:${site.inkDark}}}</style>
  ${markBody(spec)}
</svg>
`
}

function placedMark(spec, x, y, size) {
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${viewBox(spec)}" color="${site.ink}">
  ${markBody(spec)}
</svg>`
}

function touchIcon(size) {
  const inset = size * 0.1
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="${site.paper}"/>
${placedMark(marks.favicon, inset, inset, size - 2 * inset)}
</svg>
`
}

function card({ width, height }) {
  const markSize = height * 0.57
  const markX = width * 0.06
  const markY = (height - markSize) / 2
  const textX = markX + markSize + width * 0.035
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="${site.paper}"/>
${placedMark(marks.logo, markX, markY, markSize)}
<g font-family="Noto Sans, DejaVu Sans, sans-serif" fill="${site.ink}">
  <text x="${textX}" y="${height * 0.46}" font-size="${height * 0.165}" font-weight="700" letter-spacing="-3">${site.name}</text>
  <text x="${textX + 4}" y="${height * 0.575}" font-size="${height * 0.052}" fill-opacity="0.8">${site.tagline}</text>
  <text x="${textX + 4}" y="${height * 0.665}" font-size="${height * 0.04}" fill-opacity="0.6">${site.highlights}</text>
</g>
</svg>
`
}

function writeAtomic(target, contents) {
  const staging = `${target}.tmp`
  writeFileSync(staging, contents)
  renameSync(staging, target)
}

function rasterize(svg, target, width, workDir) {
  const source = path.join(workDir, `${path.basename(target)}.svg`)
  const staging = path.join(path.dirname(target), `.${path.basename(target)}`)
  writeFileSync(source, svg)
  execFileSync(
    'inkscape',
    [source, '--export-type=png', `--export-width=${width}`, `--export-filename=${staging}`],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  renameSync(staging, target)
}

writeAtomic(publicPath(site.images.logo), themedMark(marks.logo))
writeAtomic(publicPath(site.images.favicon), themedMark(marks.favicon))

const workDir = mkdtempSync(path.join(tmpdir(), 'conference-brand-'))
try {
  rasterize(touchIcon(180), publicPath(site.images.touchIcon), 180, workDir)
  rasterize(card(site.card), publicPath(site.images.card), site.card.width, workDir)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
