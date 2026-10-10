// The Flow view (K4): are we getting faster or slower? It leads with the pace
// and the forecast, then four charts drawn by Nivo (packages/charts): the
// burn-up with the forecast cone, cumulative flow, cycle time per done task,
// and how long each task in progress has run against the usual days per task.
//
// Every series, number and word is built here from State, where tests check
// it; the bundle only draws. Each datum carries its tooltip as words (`tip`),
// each chart its one-line summary, which is all a page without JS shows. With
// under two days of history a chart says what it needs and has no mount, so a
// page without charts carries no bundle. Pure.

import { daily, throughput } from '../chart'
import { forecastHistory, shortDay, type Forecast, type Snapshot } from '../forecast'
import { taskDays, type ReportInput } from '../report'
import type { State } from '../state'
// chartMount lives in html.ts, not page.ts: page.ts imports this view, so a
// runtime import back would make a cycle the engine may evaluate this side first.
import { chartMount, esc, plainInline, plural, type ChartSpec } from './html'

/** A named axis format the bundle maps to a function: JSON cannot carry one. */
export type AxisFormat = 'day' | 'int' | 'days'

/** A chart as this view describes it: the page's ChartSpec plus what the bundle's named extras read. */
export type FlowSpec = ChartSpec & {
  /** Tick labels: `day` writes YYYY-MM-DD (or a Date) as `5 Oct`; `int` hides fractions; `days` adds ` d`. */
  format?: { x?: AxisFormat; y?: AxisFormat }
  /** Line series drawn dashed: the forecast. */
  dashed?: string[]
  /** Two line series whose gap is filled: the forecast's fast-to-slow range. */
  cone?: [string, string]
  /** Reference lines across the value axis, each named. */
  guides?: { value: number; label: string }[]
}

export type FlowChart = {
  key: 'burnup' | 'cfd' | 'cycle' | 'aging' | 'drift'
  title: string
  /** What the bundle draws; null when there is too little to draw. */
  spec: FlowSpec | null
  /** One line: the latest numbers, or what the chart needs. */
  summary: string
  /** Glyph, colour token and words for each series: colour never carries the meaning alone. */
  legend: { glyph: string; token: string; label: string }[]
}

/** Charts need this many days of snapshots. */
const MIN_DAYS = 2
const DAY = 86_400_000
const days = (a: string, b: string) => Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY))
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/** Shared Nivo props: room for the axes, a day axis along the bottom. */
const MARGIN = { top: 12, right: 20, bottom: 32, left: 40 }
const TIME_X = { type: 'time', format: '%Y-%m-%d', precision: 'day', useUTC: true }
const AXES = { axisBottom: { tickValues: 4, tickSize: 4, tickPadding: 6 }, axisLeft: { tickValues: 4, tickSize: 4, tickPadding: 6 } }

/** What a chart needs when the history is too short. */
function needsHistory(name: string, series: Snapshot[]): string {
  const since = series[0] ? `; tracking began ${shortDay(series[0].day)}` : ''
  return `The ${name} needs ${MIN_DAYS} days of history${since}.`
}

// ------------------------------------------------------------------ burn-up

/** Scope and done per day (the series `/progress charts` draws), then the forecast from today to the fast, likely and slow dates. */
export function burnupChart(s: State): FlowChart {
  const series = daily(s.snapshots)
  const legend = [
    { glyph: '━', token: '--ink3', label: 'scope' },
    { glyph: '━', token: '--done', label: 'done' },
  ]
  const base = { key: 'burnup' as const, title: 'Burn-up', legend }
  if (series.length < MIN_DAYS) return { ...base, spec: null, summary: needsHistory('burn-up', series) }
  const first = series[0]!
  const last = series.at(-1)!
  const fc = s.forecast
  const range = fc?.kind === 'range' ? fc : null
  const data: { id: string; data: { x: string; y: number; tip: string }[] }[] = [
    { id: 'scope', data: series.map(d => ({ x: d.day, y: d.total, tip: `${shortDay(d.day)} · scope ${plural(d.total, 'task')}` })) },
    { id: 'done', data: series.map(d => ({ x: d.day, y: d.done, tip: `${shortDay(d.day)} · ${d.done} done of ${d.total}` })) },
  ]
  const colors = ['--ink3', '--done']
  if (range) {
    const today = { x: last.day, y: last.done, tip: `${shortDay(last.day)} · ${last.done} done of ${last.total}` }
    const end = (day: string, what: string) => ({ x: day, y: last.total, tip: `${shortDay(day)} · ${what}, all ${last.total} done` })
    data.push(
      { id: 'likely', data: [today, end(range.median, 'likely finish')] },
      { id: 'fast', data: [today, end(range.optimistic, 'fast finish')] },
      { id: 'slow', data: [today, end(range.slow, 'slow finish')] },
    )
    colors.push('--done', '--ink3', '--ink3')
    legend.push({ glyph: '┅', token: '--done', label: 'likely finish' }, { glyph: '┅', token: '--ink3', label: 'fast to slow' })
  }
  const added = last.total - first.total
  const ahead =
    range ? `Forecast ≈ ${shortDay(range.median)} (fast ${shortDay(range.optimistic)}, slow ${shortDay(range.slow)}).`
    : fc?.kind === 'done' ? 'Every task is done.'
    : fc?.kind === 'not-enough' ? `No forecast yet: ${fc.reason}.`
    : 'No forecast yet.'
  const spec: FlowSpec = {
    kind: 'line',
    data,
    colors,
    format: { x: 'day', y: 'int' },
    ...(range ? { dashed: ['likely', 'fast', 'slow'], cone: ['fast', 'slow'] as [string, string] } : {}),
    props: { margin: MARGIN, xScale: TIME_X, yScale: { type: 'linear', min: 0, max: 'auto' }, ...AXES, enablePoints: false, useMesh: true, enableGridX: false, lineWidth: 2 },
  }
  return {
    ...base,
    spec,
    summary: `${last.done} of ${last.total} tasks done by ${shortDay(last.day)}; scope ${last.total}, ${added < 0 ? '−' : '+'}${Math.abs(added)} since ${shortDay(first.day)}. ${ahead}`,
  }
}

// ------------------------------------------------------------------ cumulative flow

const STATES = [
  { key: 'done', label: 'done', token: '--done', glyph: '✓' },
  { key: 'doing', label: 'in progress', token: '--doing', glyph: '●' },
  { key: 'blocked', label: 'blocked', token: '--blocked', glyph: '■' },
  { key: 'todo', label: 'to do', token: '--todo', glyph: '○' },
] as const

/** A day's tasks by state; snapshots from before 0.5.0 keep no in progress or blocked, which count as 0. */
const countsOf = (d: Snapshot) => {
  const doing = d.doing ?? 0
  const blocked = d.blocked ?? 0
  return { done: d.done, doing, blocked, todo: Math.max(0, d.total - d.done - doing - blocked) }
}

/** Tasks by state per day, stacked bottom to top: done, in progress, blocked, to do (as `/progress charts` stacks them). */
export function cumulativeFlowChart(s: State): FlowChart {
  const series = daily(s.snapshots)
  // The page's state glyphs, as the Overview and the Board use them.
  const legend = STATES.map(k => ({ glyph: k.glyph, token: k.token, label: k.label }))
  const base = { key: 'cfd' as const, title: 'Cumulative flow', legend }
  if (series.length < MIN_DAYS) return { ...base, spec: null, summary: needsHistory('flow chart', series) }
  const counts = series.map(d => ({ day: d.day, c: countsOf(d) }))
  const data = STATES.map(k => ({
    id: k.label,
    data: counts.map(({ day, c }) => ({ x: day, y: c[k.key], head: shortDay(day), tip: `${c[k.key]} ${k.label}` })),
  }))
  const now = counts.at(-1)!
  return {
    ...base,
    spec: {
      kind: 'line',
      data,
      colors: STATES.map(k => k.token),
      format: { x: 'day', y: 'int' },
      props: {
        margin: MARGIN,
        xScale: TIME_X,
        yScale: { type: 'linear', min: 0, max: 'auto', stacked: true },
        ...AXES,
        enableArea: true,
        areaOpacity: 1,
        areaBaselineValue: 0,
        enablePoints: false,
        enableSlices: 'x',
        enableGridX: false,
        lineWidth: 1,
      },
    },
    summary: `On ${shortDay(now.day)}: ${STATES.map(k => `${now.c[k.key]} ${k.label}`).join(', ')}.`,
  }
}

// ------------------------------------------------------------------ cycle time

/** What `/progress report` hands taskDays and daysPerTask, from State. */
const reportInput = (s: State): ReportInput => ({
  spec: s.spec,
  list: s.list,
  plan: s.plan,
  forecast: s.forecast,
  snapshots: s.snapshots,
  specFile: s.specFile,
  dates: s.dates,
  today: s.today,
  charts: { burnup: null, flow: null },
})

/** Days per done task (taskDays, the bars `/progress charts` shows), placed on the day each was done. */
export function cycleTimeChart(s: State): FlowChart {
  const series = daily(s.snapshots)
  const legend = [{ glyph: '●', token: '--done', label: 'a done task' }]
  const base = { key: 'cycle' as const, title: 'Cycle time', legend }
  if (series.length < MIN_DAYS) return { ...base, spec: null, summary: needsHistory('cycle time chart', series) }
  const byId = new Map((s.list?.tasks ?? []).map(t => [t.id, t]))
  const points = taskDays(reportInput(s))
    .filter(t => !t.isRunning)
    .flatMap(t => {
      const task = byId.get(t.id)
      const date = s.dates[t.id]
      const day = task?.state?.done ?? (date && !date.isEstimate ? date.day : null)
      return day ? [{ ...t, day }] : []
    })
  if (!points.length) return { ...base, spec: null, summary: 'No task has finished since tracking began, so there is no cycle time yet.' }
  const sorted = points.map(p => p.days).sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  const longest = points.reduce((a, b) => (b.days > a.days ? b : a))
  const latest = points.reduce((a, b) => (b.day >= a.day ? b : a))
  return {
    ...base,
    spec: {
      kind: 'scatter',
      data: [{ id: 'done tasks', data: points.map(p => ({ x: p.day, y: p.days, tip: `${p.id} ${plainInline(p.title)} · ${p.days} d · done ${shortDay(p.day)}` })) }],
      colors: ['--done'],
      format: { x: 'day', y: 'days' },
      props: { margin: MARGIN, xScale: TIME_X, yScale: { type: 'linear', min: 0, max: 'auto' }, ...AXES, nodeSize: 10, enableGridX: false, useMesh: true },
    },
    summary: `${plural(points.length, 'task')} timed: median ${num(median)} d, longest ${longest.id} at ${longest.days} d; latest ${latest.id}, ${latest.days} d (done ${shortDay(latest.day)}).`,
  }
}

// ------------------------------------------------------------------ aging work in progress

/**
 * The usual days per task, as the band's alert reckons it (view.ts alerts()):
 * days since the plan began over tasks done, at least 1. Null before 2 are done.
 */
export function usualDays(s: State): number | null {
  const list = s.list
  const began = list?.meta?.created ?? s.snapshots[0]?.day
  if (!list || !began || list.done < 2) return null
  return Math.max(1, days(began, s.today) / list.done)
}

/** Days in progress for each open task its Status line says has started, against the usual; over twice the usual is marked. */
export function agingWipChart(s: State): FlowChart {
  const series = daily(s.snapshots)
  const usual = usualDays(s)
  const legend = [
    { glyph: '●', token: '--doing', label: 'in progress' },
    { glyph: '▲', token: '--blocked', label: 'over twice the usual' },
  ]
  const base = { key: 'aging' as const, title: 'Aging work in progress', legend }
  if (series.length < MIN_DAYS) return { ...base, spec: null, summary: needsHistory('aging chart', series) }
  const open = (s.list?.tasks ?? [])
    .filter(t => t.status !== 'done' && t.state?.status === 'in progress' && t.state.started)
    .map(t => ({ t, ran: days(t.state!.started!, s.today) }))
  if (!open.length) return { ...base, spec: null, summary: 'Nothing is in progress with a start date. A task shows here once its Status line says in progress · started YYYY-MM-DD.' }
  // Oldest at the top: Nivo draws horizontal bars from the bottom up.
  open.sort((a, b) => a.ran - b.ran || a.t.id.localeCompare(b.t.id))
  const isOver = (ran: number) => usual !== null && ran > usual * 2
  const rows = open.map(({ t, ran }) =>
    isOver(ran)
      ? { task: t.id, over: ran, label: `▲ ${ran} d`, tip: `${t.id} ${plainInline(t.title)} · ${ran} d in progress, over twice the usual ${Math.round(usual!)} d` }
      : { task: t.id, days: ran, label: `${ran} d`, tip: `${t.id} ${plainInline(t.title)} · ${ran} d in progress` },
  )
  const over = open.filter(o => isOver(o.ran)).reverse()
  const oldest = open.at(-1)!
  const verdict =
    usual === null ? `The oldest is ${oldest.t.id} at ${oldest.ran} d; the usual days per task are known once 2 tasks are done.`
    : over.length ? `Over twice the usual ${Math.round(usual)} d a task: ${over.map(o => `${o.t.id} at ${o.ran} d`).join(', ')}.`
    : `None over twice the usual ${Math.round(usual)} d a task; the oldest is ${oldest.t.id} at ${oldest.ran} d.`
  return {
    ...base,
    spec: {
      kind: 'bar',
      data: rows,
      colors: ['--doing', '--blocked'],
      format: { x: 'days' },
      ...(usual === null ? {} : { guides: [{ value: Math.round(usual * 10) / 10, label: 'usual' }, { value: Math.round(usual * 20) / 10, label: '2× usual' }] }),
      height: Math.max(120, 48 + rows.length * 32),
      props: {
        keys: ['days', 'over'],
        indexBy: 'task',
        layout: 'horizontal',
        groupMode: 'stacked',
        margin: { top: 12, right: 24, bottom: 32, left: 48 },
        padding: 0.3,
        valueScale: { type: 'linear', min: 0, max: 'auto' },
        axisBottom: { tickValues: 4, tickSize: 4, tickPadding: 6 },
        axisLeft: { tickSize: 0, tickPadding: 8 },
        enableGridY: false,
        enableGridX: true,
        labelSkipWidth: 28,
      },
    },
    summary: `${plural(open.length, 'task')} in progress. ${verdict}`,
  }
}

// ------------------------------------------------------------------ ETA drift

type Range = Extract<Forecast, { kind: 'range' }>

/**
 * How the finish date moved (T10): for each day that had a range forecast, the
 * likely date, with the fast-to-slow range as a cone around it. Dates up the
 * side, days along the bottom: a line climbing means the finish keeps slipping.
 */
export function etaDriftChart(s: State): FlowChart {
  const legend = [
    { glyph: '━', token: '--doing', label: 'likely finish' },
    { glyph: '┅', token: '--ink3', label: 'fast to slow' },
  ]
  const base = { key: 'drift' as const, title: 'ETA drift', legend }
  const ranges = forecastHistory(s.snapshots).filter((p): p is { day: string; forecast: Range } => p.forecast.kind === 'range')
  if (ranges.length < 2) {
    const so = ranges[0] ? `the first was on ${shortDay(ranges[0].day)}` : 'there is none yet, as a forecast needs 3 tasks done'
    return { ...base, spec: null, summary: `ETA drift needs a forecast on 2 days; ${so}.` }
  }
  // Dates up the side as milliseconds on a linear scale, which runs upward (a time
  // scale on y runs down): a finish that slips climbs. The bundle labels them as days.
  const ms = (day: string) => Date.parse(`${day}T00:00:00Z`)
  const tip = (p: (typeof ranges)[number]) => `${shortDay(p.day)} · likely ${shortDay(p.forecast.median)}, range ${shortDay(p.forecast.optimistic)}–${shortDay(p.forecast.slow)}`
  const data = [
    { id: 'likely', data: ranges.map(p => ({ x: p.day, y: ms(p.forecast.median), tip: tip(p) })) },
    { id: 'fast', data: ranges.map(p => ({ x: p.day, y: ms(p.forecast.optimistic), tip: `${shortDay(p.day)} · fast case ${shortDay(p.forecast.optimistic)}` })) },
    { id: 'slow', data: ranges.map(p => ({ x: p.day, y: ms(p.forecast.slow), tip: `${shortDay(p.day)} · slow case ${shortDay(p.forecast.slow)}` })) },
  ]
  // About four ticks on whole days, a whole number of days apart, with a step's room above and below.
  const lo = Math.min(...ranges.map(p => ms(p.forecast.optimistic)))
  const hi = Math.max(...ranges.map(p => ms(p.forecast.slow)))
  const step = Math.max(1, Math.ceil((hi - lo) / DAY / 4)) * DAY
  const tickValues: number[] = []
  for (let t = lo; t <= hi + step / 2; t += step) tickValues.push(t)
  const first = ranges[0]!
  const last = ranges.at(-1)!
  const moved = days(first.forecast.median, last.forecast.median) - days(last.forecast.median, first.forecast.median)
  const summary =
    moved === 0
      ? `The likely finish has held at ${shortDay(last.forecast.median)} since ${shortDay(first.day)}.`
      : `The likely finish moved ${moved > 0 ? `${moved} d later` : `${-moved} d sooner`} since ${shortDay(first.day)}: from ${shortDay(first.forecast.median)} to ${shortDay(last.forecast.median)}.`
  const spec: FlowSpec = {
    kind: 'line',
    data,
    colors: ['--doing', '--ink3', '--ink3'],
    format: { x: 'day', y: 'day' },
    dashed: ['fast', 'slow'],
    cone: ['fast', 'slow'],
    props: {
      margin: { ...MARGIN, left: 56 },
      xScale: TIME_X,
      yScale: { type: 'linear', min: lo - step / 2, max: Math.max(hi, tickValues.at(-1)!) + step / 2 },
      ...AXES,
      axisLeft: { ...AXES.axisLeft, tickValues },
      enablePoints: true,
      pointSize: 6,
      useMesh: true,
      enableGridX: false,
      lineWidth: 2,
    },
  }
  return { ...base, spec, summary }
}

// ------------------------------------------------------------------ the view

/** The five charts, in the order the view shows them. */
export function flowCharts(s: State): FlowChart[] {
  return [burnupChart(s), cumulativeFlowChart(s), cycleTimeChart(s), agingWipChart(s), etaDriftChart(s)]
}

export function flowHtml(s: State): string {
  const list = s.list
  if (!list || list.total === 0) {
    return `<div class="card empty" role="status"><h3>No task list yet</h3><p>The flow charts draw from <code>tasks/todo.md</code> and its history: burn-up, cumulative flow, cycle time and aging work in progress. Plan the work to create it.</p></div>`
  }
  const cards = flowCharts(s)
    .map(c => {
      const id = `flow-${c.key}`
      const body = c.spec
        ? `${chartMount(c.spec, c.summary)}
<ul class="flow-legend" aria-hidden="true">${c.legend.map(l => `<li><span class="g ${tokenClass(l.token)}">${l.glyph}</span> ${esc(l.label)}</li>`).join('')}</ul>`
        : `<p class="flow-needs">${esc(c.summary)}</p>`
      return `<section class="card flow-chart" aria-labelledby="${id}"><h3 id="${id}">${esc(c.title)}</h3>
${body}</section>`
    })
    .join('\n')
  return `<p class="flow-lead">${esc(leadText(s))}</p>
<div class="flow-grid">
${cards}
</div>`
}

/** The view's answer first: the pace so far and where it lands. */
function leadText(s: State): string {
  const pace = throughput(s.snapshots)
  const first = s.snapshots[0]
  const fc = s.forecast
  const ahead =
    fc?.kind === 'range' ? ` At that pace: likely ${shortDay(fc.median)}, between ${shortDay(fc.optimistic)} and ${shortDay(fc.slow)}.`
    : fc?.kind === 'done' ? ' Every task is done.'
    : ''
  if (!pace || !first) return `Tracking began ${shortDay(first?.day ?? s.today)}; the charts fill in from the second day of history.`
  const perWeek = Math.round(pace.rate * 7 * 10) / 10
  return `${plural(pace.done, 'task')} done in ${plural(pace.days, 'day')} since ${shortDay(first.day)}, ${num(perWeek)} a week.${ahead}`
}

const tokenClass = (token: string) => `k${token.slice(1)}`

/** This view's CSS, added to the page's stylesheet. */
export const FLOW_STYLE = `
.flow-lead{margin:0 0 var(--s4);font-size:15px}
.flow-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s4);align-items:start}
.flow-chart{min-width:0}
.flow-chart .chart{margin:0;min-width:0}
.chart-box{width:100%;min-width:0}
.chart-text{margin:var(--s2) 0 0;color:var(--ink2);font-size:13px}
.flow-needs{margin:0;color:var(--ink2)}
.flow-legend{display:none;flex-wrap:wrap;gap:var(--s1) var(--s3);list-style:none;margin:var(--s2) 0 0;padding:0;font-size:12.5px;color:var(--ink2)}
.chart.has-chart+.flow-legend{display:flex}
.flow-legend .g{font-weight:700;margin-right:2px}
.k-done{color:var(--done)}.k-doing{color:var(--doing)}.k-blocked{color:var(--blocked)}.k-todo{color:var(--ink3)}.k-ink3{color:var(--ink3)}
@media (max-width:860px){.flow-grid{grid-template-columns:1fr}}
`
