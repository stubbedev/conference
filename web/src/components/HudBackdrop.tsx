// Cyberchat 2077 scenery for the screens before a call: a frame with
// tick marks and notched corners, status lines, and a circuit board
// drawn once from a fixed seed. Rendered for every theme but only shown
// by the .hud theme (see .hud-only in index.css), so the upstream themes
// are untouched.

interface Trace {
  d: string
  end: [number, number]
  red: boolean
  pulse: boolean
}

interface Chip {
  x: number
  y: number
  width: number
  height: number
  pins: string
}

const BOARD_WIDTH = 1600
const BOARD_HEIGHT = 900
const STEP = 20

// Unit moves on the board grid: right, down-right, down, ... (45° apart).
const DIRECTIONS: [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]

function board(): { traces: Trace[]; chips: Chip[] } {
  let seed = 2077
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const pick = (n: number) => Math.floor(random() * n)

  // Traces run in from the edges and wander with 45° turns, the way PCB
  // tracks do, ending in a via.
  const traces: Trace[] = []
  for (let i = 0; i < 70; i++) {
    const edge = pick(4)
    let x = edge === 0 ? 0 : edge === 1 ? BOARD_WIDTH : pick(BOARD_WIDTH / STEP) * STEP
    let y = edge === 2 ? 0 : edge === 3 ? BOARD_HEIGHT : pick(BOARD_HEIGHT / STEP) * STEP
    let direction = edge === 0 ? 0 : edge === 1 ? 4 : edge === 2 ? 2 : 6
    let d = `M${x} ${y}`
    const segments = 2 + pick(4)
    for (let s = 0; s < segments; s++) {
      const length = (2 + pick(9)) * STEP
      const [dx, dy] = DIRECTIONS[direction]
      x += dx * length
      y += dy * length
      d += ` L${x} ${y}`
      // Turn 45° left or right, never back on itself.
      direction = (direction + (random() < 0.5 ? 1 : 7)) % 8
    }
    traces.push({ d, end: [x, y], red: random() < 0.2, pulse: random() < 0.18 })
  }

  // A few chips near the edges, with pins down both long sides.
  const chips: Chip[] = []
  for (let i = 0; i < 6; i++) {
    const width = 60 + pick(4) * 20
    const height = 40 + pick(3) * 20
    const nearLeft = random() < 0.5
    const x = nearLeft ? 40 + pick(12) * STEP : BOARD_WIDTH - width - 40 - pick(12) * STEP
    const y = 60 + pick((BOARD_HEIGHT - 160) / STEP) * STEP
    let pins = ''
    for (let px = x + 8; px < x + width - 4; px += 10) {
      pins += `M${px} ${y} L${px} ${y - 8} M${px} ${y + height} L${px} ${y + height + 8} `
    }
    chips.push({ x, y, width, height, pins })
  }

  return { traces, chips }
}

const BOARD = board()

export function HudBackdrop() {
  return (
    <div className="hud-only hud-backdrop" aria-hidden>
      <svg className="hud-board" viewBox={`0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          {/* Clear in the middle, where the forms sit. */}
          <radialGradient id="hud-board-fade" cx="50%" cy="50%" r="62%">
            <stop offset="28%" stopColor="black" />
            <stop offset="72%" stopColor="white" />
          </radialGradient>
          <mask id="hud-board-mask">
            <rect width={BOARD_WIDTH} height={BOARD_HEIGHT} fill="url(#hud-board-fade)" />
          </mask>
        </defs>
        <g mask="url(#hud-board-mask)">
          {BOARD.traces.map((t, i) => (
            <g key={i} className={t.red ? 'hud-trace hud-trace-red' : 'hud-trace'}>
              <path d={t.d} />
              <circle cx={t.end[0]} cy={t.end[1]} r={4} />
              {t.pulse && <path d={t.d} className="hud-pulse" style={{ animationDelay: `${(i % 7) * 0.9}s` }} />}
            </g>
          ))}
          {BOARD.chips.map((c, i) => (
            <g key={i} className="hud-chip">
              <path d={c.pins} />
              <rect x={c.x} y={c.y} width={c.width} height={c.height} />
            </g>
          ))}
        </g>
      </svg>
      <div className="hud-frame">
        <span className="hud-status hud-status-top-left">CONFERENCE</span>
        <span className="hud-status hud-status-top-right">SECURE CHANNEL // E2EE ACTIVE</span>
        <span className="hud-status hud-status-bottom">// SELF-HOSTED /|\ END-TO-END ENCRYPTED \\</span>
        <span className="hud-bars" />
      </div>
    </div>
  )
}

/** The Cyberchat 2077 title for the start page. */
export function HudTitle() {
  return (
    <div className="hud-only hud-title-block">
      <div className="hud-wordmark" data-text="CONFERENCE">
        CONFERENCE
      </div>
    </div>
  )
}
