// Pixel charts (F3): the burn-up and flow charts painted into an RGBA buffer and
// sent as a PNG, for terminals that draw pictures (kitty, Ghostty). The same
// numbers as the braille and half-block Rasters (F2) and the SVG (F4); the axis
// labels and legends stay text beside the picture, so the colors never carry
// the meaning alone. Pure: no Claude Code API.

import { COLOR, daily, toBase64 } from './chart'
import { shortDay, type Forecast, type Snapshot } from './forecast'

const DAY = 86_400_000
const parseDay = (day: string) => Date.parse(`${day}T00:00:00Z`)
const daysBetween = (a: string, b: string) => Math.round((parseDay(b) - parseDay(a)) / DAY)

/** Pixels per terminal cell the pictures are painted at; the terminal scales them to the box. */
export const CELL_PX = { w: 6, h: 12 } as const

type Rgb = number

/** An RGBA canvas, transparent until painted, so the terminal's own background shows through. */
export class Canvas {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.data = new Uint8Array(width * height * 4)
  }

  /** Blends `color` over the pixel at `alpha` (0 to 1). */
  blend(x: number, y: number, color: Rgb, alpha: number) {
    if (alpha <= 0.004 || x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const d = this.data
    const i = (y * this.width + x) * 4
    const a = alpha > 1 ? 1 : alpha
    if (d[i + 3] === 0) {
      d[i] = (color >> 16) & 0xff
      d[i + 1] = (color >> 8) & 0xff
      d[i + 2] = color & 0xff
      d[i + 3] = Math.round(a * 255)
      return
    }
    const da = d[i + 3]! / 255
    const keep = da * (1 - a)
    const oa = a + keep
    d[i] = Math.round((((color >> 16) & 0xff) * a + d[i]! * keep) / oa)
    d[i + 1] = Math.round((((color >> 8) & 0xff) * a + d[i + 1]! * keep) / oa)
    d[i + 2] = Math.round(((color & 0xff) * a + d[i + 2]! * keep) / oa)
    d[i + 3] = Math.round(oa * 255)
  }

  fillRect(x0: number, y0: number, w: number, h: number, color: Rgb, alpha = 1) {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.height, Math.ceil(y0 + h)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.width, Math.ceil(x0 + w)); x++) this.blend(x, y, color, alpha)
  }

  /**
   * An anti-aliased segment `width` pixels thick: coverage from each pixel's
   * distance to it, visiting only the band of pixels near the segment.
   */
  line(x0: number, y0: number, x1: number, y1: number, width: number, color: Rgb, alpha = 1) {
    const r = width / 2
    const dx = x1 - x0
    const dy = y1 - y0
    const len2 = dx * dx + dy * dy || 1
    const steep = Math.abs(dy) > Math.abs(dx)
    // Along the major axis, a column (or row) of pixels across the band.
    const [a0, a1] = steep ? [Math.min(y0, y1), Math.max(y0, y1)] : [Math.min(x0, x1), Math.max(x0, x1)]
    const slope = steep ? (dy === 0 ? 0 : dx / dy) : dx === 0 ? 0 : dy / dx
    const reach = r * Math.sqrt(1 + slope * slope) + 1.5
    for (let m = Math.floor(a0 - r - 1); m <= Math.ceil(a1 + r + 1); m++) {
      const mc = Math.max(a0, Math.min(a1, m + 0.5))
      const centre = steep ? x0 + (mc - y0) * slope : y0 + (mc - x0) * slope
      for (let n = Math.floor(centre - reach); n <= Math.ceil(centre + reach); n++) {
        const x = steep ? n : m
        const y = steep ? m : n
        const px = x + 0.5
        const py = y + 0.5
        let t = ((px - x0) * dx + (py - y0) * dy) / len2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const ex = px - (x0 + t * dx)
        const ey = py - (y0 + t * dy)
        const cover = r + 0.5 - Math.sqrt(ex * ex + ey * ey)
        if (cover > 0) this.blend(x, y, color, alpha * (cover > 1 ? 1 : cover))
      }
    }
  }

  /** A polyline; `dash` paints `[on, off]` pixel runs along it. */
  path(points: [number, number][], width: number, color: Rgb, opts: { alpha?: number; dash?: [number, number] } = {}) {
    let walked = 0
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1]!
      const [bx, by] = points[i]!
      const seg = Math.hypot(bx - ax, by - ay)
      if (!opts.dash) {
        this.line(ax, ay, bx, by, width, color, opts.alpha)
        continue
      }
      const [on, off] = opts.dash
      for (let s = 0; s < seg; ) {
        const phase = (walked + s) % (on + off)
        const run = phase < on ? Math.min(on - phase, seg - s) : Math.min(on + off - phase, seg - s)
        if (phase < on) {
          const t0 = s / seg
          const t1 = (s + run) / seg
          this.line(ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1, width, color, opts.alpha)
        }
        s += Math.max(run, 0.5)
      }
      walked += seg
    }
  }

  /**
   * A filled polygon, even-odd, with a soft edge from 4x vertical sampling.
   * Each sample row adds its spans to a difference array, so a row costs its
   * width once however many spans and samples cross it.
   */
  polygon(points: [number, number][], color: Rgb, alpha = 1) {
    if (points.length < 3) return
    const ys = points.map(p => p[1])
    const w = this.width
    const diff = new Float32Array(w + 2)
    const edge = new Float32Array(w + 1)
    const xs: number[] = []
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(this.height, Math.ceil(Math.max(...ys))); y++) {
      let lo = w
      let hi = -1
      for (let sub = 0.125; sub < 1; sub += 0.25) {
        const sy = y + sub
        xs.length = 0
        for (let i = 0; i < points.length; i++) {
          const [ax, ay] = points[i]!
          const [bx, by] = points[(i + 1) % points.length]!
          if (ay <= sy !== by <= sy) xs.push(ax + ((sy - ay) * (bx - ax)) / (by - ay))
        }
        xs.sort((a, b) => a - b)
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const from = Math.max(0, Math.min(w, xs[k]!))
          const to = Math.max(0, Math.min(w, xs[k + 1]!))
          if (to <= from) continue
          const fl = Math.floor(from)
          const tl = Math.floor(to)
          if (fl === tl) edge[fl]! += (to - from) / 4
          else {
            // Partial first and last pixels; whole pixels between through the difference array.
            edge[fl]! += (fl + 1 - from) / 4
            if (tl < w) edge[tl]! += (to - tl) / 4
            diff[fl + 1]! += 0.25
            diff[tl]! -= 0.25
          }
          if (fl < lo) lo = fl
          if (tl > hi) hi = Math.min(w - 1, tl)
        }
      }
      let run = 0
      for (let x = lo; x <= hi; x++) {
        run += diff[x]!
        const c = run + edge[x]!
        if (c > 0.004) this.blend(x, y, color, alpha * (c > 1 ? 1 : c))
        diff[x] = 0
        edge[x] = 0
      }
      diff[hi + 1] = 0
    }
  }

  disc(cx: number, cy: number, r: number, color: Rgb, alpha = 1) {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++)
        this.blend(x, y, color, alpha * Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy))))
  }

  /** The canvas as a whole PNG file, base64: what an Image's `{ png }` source takes. */
  png(): string {
    return toBase64(encodePng(this.width, this.height, this.data))
  }
}

// ----------------------------------------------------------------- PNG

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Bits written least significant first, as DEFLATE wants them. */
class BitWriter {
  private buf = new Uint8Array(1 << 16)
  private len = 0
  private acc = 0
  private n = 0
  bits(value: number, count: number) {
    this.acc |= value << this.n
    this.n += count
    while (this.n >= 8) {
      this.byte(this.acc & 0xff)
      this.acc >>>= 8
      this.n -= 8
    }
  }
  private byte(b: number) {
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.len++] = b
  }
  finish(): Uint8Array {
    if (this.n > 0) this.bits(0, 8 - this.n)
    return this.buf.slice(0, this.len)
  }
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]

/** The fixed Huffman code, bit-reversed for writing LSB first: code and length per symbol 0 to 287. */
const FIXED = (() => {
  const code = new Uint16Array(288)
  const len = new Uint8Array(288)
  for (let sym = 0; sym < 288; sym++) {
    const [c, n] = sym < 144 ? [0x30 + sym, 8] : sym < 256 ? [0x190 + sym - 144, 9] : sym < 280 ? [sym - 256, 7] : [0xc0 + sym - 280, 8]
    let rev = 0
    for (let i = 0; i < n; i++) rev |= ((c >> i) & 1) << (n - 1 - i)
    code[sym] = rev
    len[sym] = n
  }
  return { code, len }
})()
/** The length symbol for each run of 3 to 258, and its extra bits. */
const RUN = (() => {
  const sym = new Uint16Array(259)
  for (let run = 3; run <= 258; run++) {
    let k = LEN_BASE.length - 1
    while (LEN_BASE[k]! > run) k--
    sym[run] = k
  }
  return sym
})()

/**
 * Streams PNG image data (Sub-filtered rows) into one fixed-Huffman DEFLATE
 * block, with zlib's header and Adler-32. Bytes are fed one at a time, or a
 * run of zeros at once: a pixel equal to the one before it filters to four
 * zeros, so flat areas cost one step a pixel and nothing per byte.
 */
class Deflater {
  private w = new BitWriter()
  private last = -1
  private run = 0
  private a = 1
  private b = 0
  private since = 0
  constructor() {
    this.w.bits(0x78, 8)
    this.w.bits(0x01, 8)
    this.w.bits(1, 1) // final block
    this.w.bits(1, 2) // fixed Huffman
  }
  private literal(byte: number) {
    this.w.bits(FIXED.code[byte]!, FIXED.len[byte]!)
  }
  private flush() {
    let run = this.run
    while (run > 0) {
      if (run < 3) {
        for (let i = 0; i < run; i++) this.literal(this.last)
        break
      }
      const take = Math.min(258, run)
      const k = RUN[take]!
      this.w.bits(FIXED.code[257 + k]!, FIXED.len[257 + k]!)
      if (LEN_EXTRA[k]) this.w.bits(take - LEN_BASE[k]!, LEN_EXTRA[k]!)
      this.w.bits(0, 5) // distance code 0: distance 1
      run -= take
      // A tail under 3 left over from a 258 split goes out as literals.
      if (run > 0 && run < 3) {
        for (let i = 0; i < run; i++) this.literal(this.last)
        run = 0
      }
    }
    this.run = 0
  }
  byte(v: number) {
    this.a += v
    this.b += this.a
    if (++this.since === 5552) {
      this.a %= 65521
      this.b %= 65521
      this.since = 0
    }
    if (v === this.last) {
      this.run++
      return
    }
    this.flush()
    this.literal(v)
    this.last = v
  }
  zeros(count: number) {
    if (count <= 0) return
    if (this.last !== 0) {
      this.byte(0)
      count--
    }
    this.a %= 65521
    this.b = (this.b + ((this.a * (count % 65521)) % 65521)) % 65521
    this.since = 0
    this.run += count
  }
  finish(): Uint8Array {
    this.flush()
    this.w.bits(FIXED.code[256]!, FIXED.len[256]!)
    const body = this.w.finish()
    const out = new Uint8Array(body.length + 4)
    out.set(body)
    new DataView(out.buffer).setUint32(body.length, (((this.b % 65521) << 16) | (this.a % 65521)) >>> 0)
    return out
  }
}

/** An RGBA image as a PNG file: Sub-filtered rows in one IDAT. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height)
  const z = new Deflater()
  for (let y = 0; y < height; y++) {
    const row = y * width
    z.byte(1) // Sub
    const s0 = row * 4
    for (let k = 0; k < 4; k++) z.byte(rgba[s0 + k]!)
    let x = 1
    while (x < width) {
      if (px[row + x] === px[row + x - 1]) {
        let same = 1
        while (x + same < width && px[row + x + same] === px[row + x - 1]) same++
        z.zeros(same * 4)
        x += same
      } else {
        const s = (row + x) * 4
        for (let k = 0; k < 4; k++) z.byte((rgba[s + k]! - rgba[s + k - 4]!) & 0xff)
        x++
      }
    }
  }
  const ihdr = new Uint8Array(13)
  const hv = new DataView(ihdr.buffer)
  hv.setUint32(0, width)
  hv.setUint32(4, height)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA, no interlace
  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', z.finish()), chunk('IEND', new Uint8Array(0))]
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  const out = new Uint8Array(sig.length + chunks.reduce((n, c) => n + c.length, 0))
  out.set(sig)
  let at = sig.length
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** zlib data for `data`, through the same encoder the PNG uses. */
export function zlib(data: Uint8Array): Uint8Array {
  const z = new Deflater()
  for (const v of data) z.byte(v)
  return z.finish()
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

// ----------------------------------------------------------------- charts

export type PixelChart = {
  png: string
  width: number
  height: number
  /** The y labels drawn beside the picture as text, top to bottom: max, half, 0. */
  ticks: number[]
  /** Dates under the picture, each with where it falls across it (0 to 1). */
  dates: { label: string; at: number }[]
  alt: string
}

const GRID = 0x5a6460
const PAD = { t: 8, b: 6, l: 4, r: 10 }

function gridLines(c: Canvas, y: (v: number) => number, ymax: number) {
  for (const v of [0, Math.round(ymax / 2), ymax]) c.fillRect(PAD.l, Math.round(y(v)), c.width - PAD.l - PAD.r, 1, GRID, v === 0 ? 0.9 : 0.35)
}

/**
 * The burn-up: scope (grey) and done (green, with a soft fill under it) per
 * day, and ahead of today the forecast as a cone from fast to slow with a
 * dashed line to the median date. `reveal` (0 to 1) paints only the part left
 * of that fraction of the days, for the draw-in when the pane opens.
 */
export function burnupPixels(history: Snapshot[], fc: Forecast | null, width: number, height: number, reveal = 1): PixelChart | null {
  const series = daily(history)
  const first = series[0]
  const last = series[series.length - 1]
  if (!first || !last || series.length < 2 || width < 32 || height < 24) return null
  const range = fc?.kind === 'range' ? fc : null
  const end = range ? range.slow : last.day
  const span = Math.max(1, daysBetween(first.day, end))
  const ymax = Math.max(1, ...series.map(s => s.total))
  const x = (day: number) => PAD.l + (day / span) * (width - PAD.l - PAD.r)
  const y = (v: number) => height - PAD.b - (v / ymax) * (height - PAD.t - PAD.b)
  const c = new Canvas(width, height)
  gridLines(c, y, ymax)

  const shown = Math.max(1, Math.round(reveal * (series.length - 1)))
  const part = series.slice(0, shown + 1)
  const pts = (key: 'done' | 'total') => part.map((s, i) => [x(i), y(s[key])] as [number, number])
  const done = pts('done')
  c.polygon([...done, [x(part.length - 1), y(0)], [x(0), y(0)]], COLOR.done, 0.16)
  const today = series.length - 1
  if (range && reveal >= 1) {
    const at = (day: string) => x(daysBetween(first.day, day))
    c.polygon([[x(today), y(last.done)], [at(range.optimistic), y(last.total)], [at(range.slow), y(last.total)]], COLOR.done, 0.14)
    c.path([[x(today), y(last.done)], [at(range.median), y(last.total)]], 2, COLOR.done, { dash: [7, 5] })
    c.disc(at(range.median), y(last.total), 5, COLOR.done)
  }
  c.path(pts('total'), 2, COLOR.scope)
  c.path(done, 3, COLOR.done)
  const tip = done[done.length - 1]!
  c.disc(tip[0], tip[1], 4.5, COLOR.done)

  const dates = [
    { label: shortDay(first.day), at: 0 },
    ...(range ? [{ label: shortDay(last.day), at: today / span }] : []),
    { label: shortDay(end), at: 1 },
  ]
  const eta = range ? `, forecast ${shortDay(range.median)} (${shortDay(range.optimistic)} to ${shortDay(range.slow)})` : ''
  const alt = `Burn-up: ${last.done} of ${last.total} tasks done by ${shortDay(last.day)}${eta}.`
  return { png: c.png(), width, height, ticks: [ymax, Math.round(ymax / 2), 0], dates, alt }
}

const STATES = ['done', 'doing', 'blocked', 'todo'] as const

const countsOf = (s: Snapshot) => {
  const doing = s.doing ?? 0
  const blocked = s.blocked ?? 0
  return { done: s.done, doing, blocked, todo: Math.max(0, s.total - s.done - doing - blocked) }
}

/** The flow chart: tasks by state per day as stacked areas, bottom to top done, in progress, blocked, to do. */
export function flowPixels(history: Snapshot[], width: number, height: number, reveal = 1): PixelChart | null {
  const series = daily(history)
  const first = series[0]
  const last = series[series.length - 1]
  if (!first || !last || series.length < 2 || width < 32 || height < 24) return null
  const n = series.length - 1
  const ymax = Math.max(1, ...series.map(s => s.total))
  const x = (i: number) => PAD.l + (i / n) * (width - PAD.l - PAD.r)
  const y = (v: number) => height - PAD.b - (v / ymax) * (height - PAD.t - PAD.b)
  const c = new Canvas(width, height)
  const shown = Math.max(1, Math.round(reveal * n))
  const counts = series.slice(0, shown + 1).map(countsOf)
  let below = counts.map(() => 0)
  for (const key of STATES) {
    const above = counts.map((k, i) => below[i]! + k[key])
    const top = above.map((v, i) => [x(i), y(v)] as [number, number])
    const bottom = below.map((v, i) => [x(i), y(v)] as [number, number]).reverse()
    c.polygon([...top, ...bottom], key === 'todo' ? 0x6b716e : COLOR[key], key === 'todo' ? 0.55 : 0.92)
    // A thin bright edge on top of each band keeps neighbours apart.
    if (above.some((v, i) => v !== below[i])) c.path(top, 1, COLOR[key === 'todo' ? 'scope' : key], { alpha: 0.9 })
    below = above
  }
  gridLines(c, y, ymax)
  const now = countsOf(last)
  const alt = `Flow on ${shortDay(last.day)}: ${now.done} done, ${now.doing} in progress, ${now.blocked} blocked, ${now.todo} to do.`
  return {
    png: c.png(),
    width,
    height,
    ticks: [ymax, Math.round(ymax / 2), 0],
    dates: [
      { label: shortDay(first.day), at: 0 },
      { label: shortDay(last.day), at: 1 },
    ],
    alt,
  }
}

/**
 * The last picture painted for each chart, so a redraw with the same numbers
 * (a turn ending, a file read again) costs nothing.
 */
const painted = new Map<string, { key: string; chart: PixelChart | null }>()
export function cachedPixels(name: string, key: string, paint: () => PixelChart | null): PixelChart | null {
  const hit = painted.get(name)
  if (hit && hit.key === key) return hit.chart
  const chart = paint()
  painted.set(name, { key, chart })
  return chart
}

/** The dates under a picture `columns` wide, each centred where it falls and none touching another. */
export function dateRow(dates: { label: string; at: number }[], columns: number): string {
  const row = Array.from({ length: columns }, () => ' ')
  const taken: [number, number][] = []
  for (const d of dates) {
    const col = Math.max(0, Math.min(columns - d.label.length, Math.round(d.at * (columns - 1)) - Math.floor(d.label.length / 2)))
    if (taken.some(([a, b]) => col <= b + 1 && col + d.label.length >= a - 1)) continue
    taken.push([col, col + d.label.length - 1])
    ;[...d.label].forEach((ch, i) => (row[col + i] = ch))
  }
  return row.join('').trimEnd()
}

/** Whether this terminal draws pictures, from its environment: kitty or Ghostty, not inside tmux. */
export function drawsPixels(env: { term?: string; termProgram?: string; kitty?: string; tmux?: string }): boolean {
  if (env.tmux) return false
  return /kitty|ghostty/i.test(env.term ?? '') || /kitty|ghostty/i.test(env.termProgram ?? '') || !!env.kitty
}
