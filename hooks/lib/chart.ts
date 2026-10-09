// Terminal charts (F2): a burn-up in braille dots and a flow chart in
// half-blocks, each the cells of one Raster plus the line of numbers printed
// under it, so the colors never carry the meaning alone. Pure: no Claude Code API.

import { dayOf, shortDay, type Forecast, type Snapshot } from './forecast'

export const COLOR = {
  none: 0x01000000,
  axis: 0x5a6460,
  scope: 0x8a948f,
  done: 0x3fbf5a,
  doing: 0xfab219,
  blocked: 0xd03b3b,
  todo: 0x4a4f4c,
} as const

export type Chart = { columns: number; rows: number; cells: string; legend: string }

const DAY = 86_400_000
const GUTTER = 4
const parseDay = (day: string) => Date.parse(`${day}T00:00:00Z`)
const daysBetween = (a: string, b: string) => Math.round((parseDay(b) - parseDay(a)) / DAY)

/** One snapshot per calendar day from the first to the last, a quiet day carrying the one before. */
export function daily(history: Snapshot[]): Snapshot[] {
  const first = history[0]
  const last = history[history.length - 1]
  if (!first || !last) return []
  const byDay = new Map(history.map(s => [s.day, s]))
  const out: Snapshot[] = []
  let carry = first
  for (let i = 0; i <= daysBetween(first.day, last.day); i++) {
    const day = dayOf(parseDay(first.day) + i * DAY)
    carry = byDay.get(day) ?? carry
    out.push({ ...carry, day })
  }
  return out
}

/** A grid of `[codePoint, foreground, background]` cells, packed as a Raster's `cells`. */
class Grid {
  readonly words: Uint32Array
  readonly columns: number
  readonly rows: number
  constructor(columns: number, rows: number) {
    this.columns = columns
    this.rows = rows
    this.words = new Uint32Array(columns * rows * 3)
    for (let i = 0; i < columns * rows; i++) this.set(i % columns, Math.floor(i / columns), 0x20, COLOR.none)
  }
  set(col: number, row: number, glyph: number, fg: number, bg: number = COLOR.none) {
    if (col < 0 || row < 0 || col >= this.columns || row >= this.rows) return
    const i = (row * this.columns + col) * 3
    this.words.set([glyph, fg, bg], i)
  }
  text(col: number, row: number, s: string, fg: number) {
    ;[...s].forEach((ch, i) => this.set(col + i, row, ch.codePointAt(0) ?? 0x20, fg))
  }
  pack(): string {
    const bytes = new Uint8Array(this.words.length * 4)
    const view = new DataView(bytes.buffer)
    this.words.forEach((w, i) => view.setUint32(i * 4, w, true))
    return toBase64(bytes)
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

/** Y labels on the gutter, the x axis and first, middle and last dates under it. */
function frame(g: Grid, plotRows: number, ymax: number, days: { label: string; col: number }[]) {
  for (let r = 0; r < plotRows; r++) g.text(0, r, '   │', COLOR.axis)
  const label = (r: number, v: number) => g.text(0, r, `${String(v).padStart(2)} ┤`, COLOR.axis)
  label(0, ymax)
  if (plotRows >= 5) label(Math.floor((plotRows - 1) / 2), Math.round(ymax / 2))
  label(plotRows - 1, 0)
  g.text(0, plotRows, `   └${'─'.repeat(g.columns - GUTTER)}`, COLOR.axis)
  // Each date is placed only where it does not touch one already placed.
  const taken: [number, number][] = []
  for (const d of days) {
    const col = Math.max(GUTTER, Math.min(g.columns - d.label.length, d.col - Math.floor(d.label.length / 2)))
    if (taken.some(([a, b]) => col <= b + 1 && col + d.label.length >= a - 1)) continue
    taken.push([col, col + d.label.length - 1])
    g.text(col, plotRows + 1, d.label, COLOR.axis)
  }
}

// Braille: a cell is 2 dots wide and 4 high; bit for dot (x, y).
const BRAILLE = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

/**
 * Scope and done per day as lines, and the forecast as a dotted line from
 * today's done to the full scope on the median date.
 */
export function burnup(history: Snapshot[], fc: Forecast | null, columns: number, rows: number): Chart | null {
  const series = daily(history)
  const first = series[0]
  const last = series[series.length - 1]
  if (!first || !last || series.length < 2 || columns <= GUTTER + 2 || rows < 4) return null
  const range = fc?.kind === 'range' ? fc : null
  const end = range ? range.median : last.day
  const span = Math.max(1, daysBetween(first.day, end))
  const plotRows = rows - 2
  const width = (columns - GUTTER) * 2
  const height = plotRows * 4
  const ymax = Math.max(1, ...series.map(s => s.total))

  const bits = new Uint8Array((columns - GUTTER) * plotRows)
  const layer = new Uint8Array(bits.length)
  const colorOf = [COLOR.scope, COLOR.done, COLOR.done]
  const x = (day: number) => Math.round((day * (width - 1)) / span)
  const y = (v: number) => height - 1 - Math.round((v * (height - 1)) / ymax)
  const dot = (px: number, py: number, l: number) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return
    const i = Math.floor(py / 4) * (columns - GUTTER) + Math.floor(px / 2)
    bits[i]! |= BRAILLE[px % 2]![py % 4]!
    // Done over forecast over scope where they share a cell.
    if (l + 1 > layer[i]!) layer[i] = l + 1
  }
  const line = (x0: number, y0: number, x1: number, y1: number, l: number, dotted = false) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let s = 0; s <= steps; s++) {
      if (dotted && s % 2 === 1) continue
      dot(Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps), l)
    }
  }
  const lineOf = (key: 'total' | 'done', l: number) =>
    series.slice(1).forEach((s, i) => line(x(i), y(series[i]![key]), x(i + 1), y(s[key]), l))
  lineOf('total', 0)
  if (range) line(x(series.length - 1), y(last.done), x(span), y(last.total), 1, true)
  lineOf('done', 2)

  const g = new Grid(columns, rows)
  bits.forEach((b, i) => {
    if (b) g.set(GUTTER + (i % (columns - GUTTER)), Math.floor(i / (columns - GUTTER)), 0x2800 + b, colorOf[layer[i]! - 1]!)
  })
  const at = (day: string) => GUTTER + Math.floor(x(daysBetween(first.day, day)) / 2)
  frame(g, plotRows, ymax, [
    { label: shortDay(first.day), col: at(first.day) },
    { label: shortDay(end), col: at(end) },
    ...(range ? [{ label: shortDay(last.day), col: at(last.day) }] : []),
  ])

  const added = last.total - first.total
  const scope = `scope ${last.total}${added > 0 ? ` (+${added})` : ''} (grey)`
  const ahead = range ? ` · forecast ≈ ${shortDay(range.median)}, ${shortDay(range.optimistic)}–${shortDay(range.slow)} (dotted)` : ''
  return { columns, rows, cells: g.pack(), legend: `done ${last.done} (green) · ${scope}${ahead}` }
}

const STATES = ['done', 'doing', 'blocked', 'todo'] as const
const STATE_NAME = { done: 'done', doing: 'in progress', blocked: 'blocked', todo: 'to do' }

const countsOf = (s: Snapshot) => {
  const doing = s.doing ?? 0
  const blocked = s.blocked ?? 0
  return { done: s.done, doing, blocked, todo: Math.max(0, s.total - s.done - doing - blocked) }
}

/** Tasks by state per day, stacked bottom to top: done, in progress, blocked, to do. */
export function flow(history: Snapshot[], columns: number, rows: number): Chart | null {
  const series = daily(history)
  const first = series[0]
  const last = series[series.length - 1]
  if (!first || !last || series.length < 2 || columns <= GUTTER + 2 || rows < 4) return null
  const plotRows = rows - 2
  const plotCols = columns - GUTTER
  const height = plotRows * 2
  const ymax = Math.max(1, ...series.map(s => s.total))

  const g = new Grid(columns, rows)
  for (let c = 0; c < plotCols; c++) {
    const counts = countsOf(series[Math.min(series.length - 1, Math.floor((c * series.length) / plotCols))]!)
    // Pixel p (0 at the bottom) takes the state whose band covers its middle.
    let sum = 0
    const tops = STATES.map(k => (sum += counts[k]) * (height / ymax))
    const pixel = (p: number) => {
      const i = tops.findIndex(t => t > p + 0.5)
      return i < 0 ? COLOR.none : COLOR[STATES[i]!]
    }
    for (let r = 0; r < plotRows; r++) {
      const lower = pixel((plotRows - 1 - r) * 2)
      const upper = pixel((plotRows - 1 - r) * 2 + 1)
      // A half left empty takes the terminal's background, never its foreground.
      if (upper === COLOR.none && lower !== COLOR.none) g.set(GUTTER + c, r, 0x2584, lower)
      else if (upper !== COLOR.none) g.set(GUTTER + c, r, 0x2580, upper, lower)
    }
  }
  const at = (i: number) => GUTTER + Math.floor(((i + 0.5) * plotCols) / series.length)
  frame(g, plotRows, ymax, [
    { label: shortDay(first.day), col: at(0) },
    { label: shortDay(last.day), col: at(series.length - 1) },
  ])

  const now = countsOf(last)
  const parts = STATES.map(k => `${now[k]} ${STATE_NAME[k]}`)
  return { columns, rows, cells: g.pack(), legend: `${shortDay(last.day)}: ${parts.join(' · ')} (bottom to top: green, amber, red, grey)` }
}

/**
 * The cells with the plot cleared right of `fraction` of its width, axis and
 * labels kept: one frame of the draw-in when the charts pane opens.
 */
export function revealCells(cells: string, columns: number, rows: number, fraction: number): string {
  if (fraction >= 1) return cells
  const bin = atob(cells)
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const cut = GUTTER + Math.round(Math.max(0, fraction) * (columns - GUTTER))
  // The last two rows are the x axis and its dates.
  for (let r = 0; r < rows - 2; r++) {
    for (let c = cut; c < columns; c++) {
      const i = (r * columns + c) * 12
      view.setUint32(i, 0x20, true)
      view.setUint32(i + 4, COLOR.none, true)
      view.setUint32(i + 8, COLOR.none, true)
    }
  }
  return toBase64(bytes)
}
