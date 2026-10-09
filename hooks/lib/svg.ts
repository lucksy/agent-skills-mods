// Vector charts (F4, G1): the burn-up and flow charts as SVG for desktop, VS Code
// and the HTML report. Hover a day for its numbers (a <title> per day), with
// direct labels and a legend so no color stands alone. Pure.

import { daily } from './chart'
import { shortDay, type Forecast, type Snapshot } from './forecast'

export type SvgChart = { source: string; alt: string }

const W = 640
const DAY = 86_400_000
const parseDay = (day: string) => Date.parse(`${day}T00:00:00Z`)
const daysBetween = (a: string, b: string) => Math.round((parseDay(b) - parseDay(a)) / DAY)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const r1 = (n: number) => Math.round(n * 10) / 10

/** Palette from the proposal, checked in both themes; the page's theme picks one. */
export const SVG_STYLE = `
.c{--done:#0ca30c;--doing:#c98a00;--blocked:#d03b3b;--todo:#d9d8d3;--ink:#0b0b0b;--ink2:#52514e;--grid:#e6e5e0;--bg:#fcfcfb;font:12px system-ui,-apple-system,sans-serif}
@media (prefers-color-scheme:dark){.c{--done:#3fbf5a;--doing:#fab219;--blocked:#ff6b5e;--todo:#4a4a46;--ink:#fff;--ink2:#c3c2b7;--grid:#33332f;--bg:#1a1a19}}
.c text{fill:var(--ink2)} .c .lab{fill:var(--ink);font-weight:600}
.c .grid{stroke:var(--grid)} .c .hit{fill:transparent} .c .hit:hover{fill:var(--ink);opacity:.06}`

const frame = (h: number, body: string, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" class="c" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img" aria-label="${esc(label)}"><style>${SVG_STYLE}</style>${body}</svg>`

type Box = { l: number; r: number; t: number; b: number; h: number }

function axes(box: Box, ymax: number, dates: { x: number; text: string }[]): string {
  const y = (v: number) => box.h - box.b - (v / ymax) * (box.h - box.t - box.b)
  const ticks = [...new Set([0, Math.round(ymax / 2), ymax])]
    .map(v => `<line class="grid" x1="${box.l}" x2="${W - box.r}" y1="${r1(y(v))}" y2="${r1(y(v))}"/><text x="${box.l - 6}" y="${r1(y(v)) + 4}" text-anchor="end">${v}</text>`)
    .join('')
  const xs = dates.map(d => `<text x="${r1(d.x)}" y="${box.h - box.b + 16}" text-anchor="middle">${esc(d.text)}</text>`).join('')
  return ticks + xs
}

/** Scope and done per day, the forecast as a dashed line to the median date over a band from fast to slow. */
export function burnupSvg(history: Snapshot[], fc: Forecast | null): SvgChart | null {
  const series = daily(history)
  const first = series[0]
  const last = series[series.length - 1]
  if (!first || !last || series.length < 2) return null
  const range = fc?.kind === 'range' ? fc : null
  const end = range ? range.slow : last.day
  const span = Math.max(1, daysBetween(first.day, end))
  // Room above the top line for the ETA label.
  const box: Box = { l: 34, r: 74, t: 28, b: 26, h: 254 }
  const ymax = Math.max(1, ...series.map(s => s.total))
  const x = (i: number) => box.l + (i / span) * (W - box.l - box.r)
  const y = (v: number) => box.h - box.b - (v / ymax) * (box.h - box.t - box.b)
  const line = (key: 'done' | 'total') => series.map((s, i) => `${r1(x(i))},${r1(y(s[key]))}`).join(' ')
  const today = series.length - 1

  let ahead = ''
  if (range) {
    const at = (day: string) => x(daysBetween(first.day, day))
    ahead =
      `<polygon fill="var(--done)" opacity=".14" points="${r1(x(today))},${r1(y(last.done))} ${r1(at(range.optimistic))},${r1(y(last.total))} ${r1(at(range.slow))},${r1(y(last.total))}"/>` +
      `<line stroke="var(--done)" stroke-width="2" stroke-dasharray="5 4" x1="${r1(x(today))}" y1="${r1(y(last.done))}" x2="${r1(at(range.median))}" y2="${r1(y(last.total))}"/>` +
      `<circle fill="var(--bg)" stroke="var(--done)" stroke-width="2" r="4" cx="${r1(at(range.median))}" cy="${r1(y(last.total))}"/>` +
      `<text class="lab" x="${r1(at(range.median))}" y="${r1(y(last.total)) - 8}" text-anchor="middle">ETA ${shortDay(range.median)}</text>`
  }
  const step = (W - box.l - box.r) / span
  const hits = series
    .map(
      (s, i) =>
        `<rect class="hit" x="${r1(x(i) - step / 2)}" y="${box.t}" width="${r1(step)}" height="${box.h - box.t - box.b}"><title>${shortDay(s.day)}: ${s.done} done of ${s.total}</title></rect>`,
    )
    .join('')
  const dates = [
    { x: x(0), text: shortDay(first.day) },
    ...(range ? [{ x: x(today), text: shortDay(last.day) }] : []),
    { x: x(span), text: shortDay(end) },
  ]
  const body =
    axes(box, ymax, dates) +
    ahead +
    `<polyline fill="none" stroke="var(--ink2)" stroke-width="2" stroke-linejoin="round" points="${line('total')}"/>` +
    `<polyline fill="none" stroke="var(--done)" stroke-width="2.5" stroke-linejoin="round" points="${line('done')}"/>` +
    `<circle fill="var(--done)" r="4" cx="${r1(x(today))}" cy="${r1(y(last.done))}"/>` +
    `<text class="lab" x="${r1(x(today)) + 8}" y="${r1(y(last.done)) + 4}">done ${last.done}</text>` +
    `<text x="${r1(x(today)) + 8}" y="${r1(y(last.total)) + (last.done === last.total ? -10 : 4)}">scope ${last.total}</text>` +
    hits
  const eta = range ? `, forecast ${shortDay(range.median)} (${shortDay(range.optimistic)} to ${shortDay(range.slow)})` : ''
  const alt = `Burn-up: ${last.done} of ${last.total} tasks done by ${shortDay(last.day)}, from ${first.total} in scope on ${shortDay(first.day)}${eta}.`
  return { source: frame(box.h, body, alt), alt }
}

const STATES = [
  ['done', 'done'],
  ['doing', 'in progress'],
  ['blocked', 'blocked'],
  ['todo', 'to do'],
] as const

const countsOf = (s: Snapshot) => {
  const doing = s.doing ?? 0
  const blocked = s.blocked ?? 0
  return { done: s.done, doing, blocked, todo: Math.max(0, s.total - s.done - doing - blocked) }
}

/** Tasks by state per day as stacked areas, bottom to top: done, in progress, blocked, to do. */
export function flowSvg(history: Snapshot[]): SvgChart | null {
  const series = daily(history)
  const first = series[0]
  const last = series[series.length - 1]
  if (!first || !last || series.length < 2) return null
  const box: Box = { l: 34, r: 16, t: 14, b: 46, h: 220 }
  const ymax = Math.max(1, ...series.map(s => s.total))
  const n = series.length - 1
  const x = (i: number) => box.l + (i / n) * (W - box.l - box.r)
  const y = (v: number) => box.h - box.b - (v / ymax) * (box.h - box.t - box.b)
  const counts = series.map(countsOf)

  let below = counts.map(() => 0)
  const areas = STATES.map(([key]) => {
    const above = counts.map((c, i) => below[i]! + c[key])
    const top = above.map((v, i) => `${r1(x(i))},${r1(y(v))}`)
    const bottom = below.map((v, i) => `${r1(x(i))},${r1(y(v))}`).reverse()
    below = above
    return `<polygon fill="var(--${key})" points="${[...top, ...bottom].join(' ')}"/>`
  }).join('')
  const step = (W - box.l - box.r) / n
  const hits = series
    .map((s, i) => {
      const c = counts[i]!
      const tip = `${shortDay(s.day)}: ${STATES.map(([k, name]) => `${c[k]} ${name}`).join(' · ')}`
      return `<rect class="hit" x="${r1(x(i) - step / 2)}" y="${box.t}" width="${r1(step)}" height="${box.h - box.t - box.b}"><title>${tip}</title></rect>`
    })
    .join('')
  const now = counts[counts.length - 1]!
  const legend = STATES.map(
    ([k, name], i) =>
      `<rect x="${box.l + i * 130}" y="${box.h - 16}" width="10" height="10" rx="2" fill="var(--${k})"/><text x="${box.l + i * 130 + 14}" y="${box.h - 7}">${name} ${now[k]}</text>`,
  ).join('')
  const body = axes(box, ymax, [
    { x: x(0), text: shortDay(first.day) },
    { x: x(n), text: shortDay(last.day) },
  ]) + areas + legend + hits
  const alt = `Flow on ${shortDay(last.day)}: ${STATES.map(([k, name]) => `${now[k]} ${name}`).join(', ')}.`
  return { source: frame(box.h, body, alt), alt }
}
