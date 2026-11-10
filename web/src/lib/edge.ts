export const EDGE_SPATIAL_SIGMA = 1
export const EDGE_RANGE_SIGMA = 0.1
export const EDGE_LOW = 0.2
export const EDGE_HIGH = 0.8
export const EDGE_REACH = { from: -1, to: 2 } as const

export type Rgb = readonly [number, number, number]

export interface EdgeInput {
  mask: ArrayLike<number>
  guide: ArrayLike<number>
  width: number
  height: number
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)))
  return t * t * (3 - 2 * t)
}

export function refinedAlpha(input: EdgeInput, colour: Rgb, maskX: number, maskY: number): number {
  const { mask, guide, width, height } = input
  const baseX = Math.floor(maskX)
  const baseY = Math.floor(maskY)
  let weights = 0
  let weighted = 0

  for (let j = EDGE_REACH.from; j <= EDGE_REACH.to; j += 1) {
    for (let i = EDGE_REACH.from; i <= EDGE_REACH.to; i += 1) {
      const x = Math.min(width - 1, Math.max(0, baseX + i))
      const y = Math.min(height - 1, Math.max(0, baseY + j))
      const dx = baseX + i - maskX
      const dy = baseY + j - maskY
      const spatial = Math.exp(-(dx * dx + dy * dy) / (2 * EDGE_SPATIAL_SIGMA * EDGE_SPATIAL_SIGMA))
      const at = y * width + x
      const dr = colour[0] - (guide[at * 3] ?? 0)
      const dg = colour[1] - (guide[at * 3 + 1] ?? 0)
      const db = colour[2] - (guide[at * 3 + 2] ?? 0)
      const range = Math.exp(-(dr * dr + dg * dg + db * db) / (2 * EDGE_RANGE_SIGMA * EDGE_RANGE_SIGMA))
      const weight = spatial * range + spatial * 1e-6
      weights += weight
      weighted += weight * (mask[at] ?? 0)
    }
  }

  return smoothstep(EDGE_LOW, EDGE_HIGH, weighted / weights)
}
