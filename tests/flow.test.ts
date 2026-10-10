import { describe, expect, test } from 'claude-code/testing'

import { chartMount, dashboardHtml } from '../packages/core/dashboard/page'
import { chartMount as htmlChartMount } from '../packages/core/dashboard/html'
import { agingWipChart, burnupChart, cumulativeFlowChart, cycleTimeChart, etaDriftChart, flowCharts, flowHtml, usualDays } from '../packages/core/dashboard/flow'
import { CHARTS_JS } from '../packages/core/dashboard/charts-bundle'
import { chartLegends, daily, throughput } from '../packages/core/chart'
import { forecastHistory, shortDay } from '../packages/core/forecast'
import { taskDays } from '../packages/core/report'
import { buildState, type ProjectIo, type State } from '../packages/core/state'
import { SPEC, TODO_NONE_DONE, TODO_T2_DONE, TODO_T3_DONE, gitOutput } from './fixtures'

// The Flow view (K4): burn-up, cumulative flow, cycle time and aging WIP, each a
// Nivo chart whose series and words are built here, in core, and tested.

const NOW = Date.parse('2026-10-09T10:00:00Z')
const io = (files: Record<string, string>, run?: ProjectIo['run']): ProjectIo => ({
  cwd: '/work/keys',
  now: NOW,
  read: async rel => files[rel] ?? null,
  list: async rel => Object.keys(files).filter(f => (rel ? f.startsWith(`${rel}/`) && !f.slice(rel.length + 1).includes('/') : !f.includes('/'))).map(f => f.split('/').pop()!),
  run,
})
const git = (copies: [string, string | null][]): ProjectIo['run'] => {
  const out = gitOutput(copies)
  return async (argv, opts) => ({ exitCode: 0, stdout: argv[1] === 'log' ? (argv.some(a => a.includes('%B')) ? '' : out.log) : out.answer(argv, opts?.stdin), stderr: '' })
}
const HISTORY = git([['2026-10-08', TODO_T3_DONE], ['2026-10-03', TODO_T2_DONE], ['2026-09-29', TODO_NONE_DONE]])
const project = () => buildState(io({ 'SPEC.md': SPEC, 'tasks/todo.md': TODO_T3_DONE }, HISTORY))

// T1 and T2 done; T3 under way since 15 Sep (long over the usual), T4 since 8 Oct.
const status = (text: string, task: string, line: string) => text.replace(`## Task ${task}\n`, `## Task ${task}\n**Status:** ${line}\n`)
const TODO_WIP = status(status(TODO_T2_DONE, '3: Issue and revoke keys', 'in progress · started 2026-09-15 · step build'), '4: Rate limit per key', 'in progress · started 2026-10-08 · step test')
const wip = () => buildState(io({ 'tasks/todo.md': TODO_WIP }, git([['2026-10-08', TODO_WIP], ['2026-10-03', TODO_T2_DONE], ['2026-09-29', TODO_NONE_DONE]])))

/** The text of an element, tags dropped and entities read back. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const section = (html: string, id: string) => html.match(new RegExp(`<section[^>]*id="view-${id}"[\\s\\S]*?</section>\\s*<!-- /view-${id} -->`))?.[0] ?? ''
/** The chart specs in some HTML, read back from their mounts. */
const mounts = (html: string) => [...html.matchAll(/data-chart="([^"]*)"/g)].map(m => JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')))
type Series = { id: string; data: { x: string; y: number; tip?: string }[] }
const series = (spec: { data: unknown[] }, id: string) => (spec.data as Series[]).find(d => d.id === id)!
const reportInput = (s: State) => ({ spec: s.spec, list: s.list, plan: s.plan, forecast: s.forecast, snapshots: s.snapshots, specFile: s.specFile, dates: s.dates, today: s.today, charts: { burnup: null, flow: null } })

describe('Flow view (K4): with history', () => {
  test('five charts, each a heading, a mount and a summary; the page carries the bundle', async () => {
    const s = await project()
    const html = section(dashboardHtml(s), 'flow')
    expect([...html.matchAll(/<h3 [^>]*>([^<]+)<\/h3>/g)].map(m => m[1])).toEqual(['Burn-up', 'Cumulative flow', 'Cycle time', 'Aging work in progress', 'ETA drift'])
    // The fixture has no task with a Status line under way: aging WIP says so, without a mount.
    expect(mounts(html).map(m => m.kind)).toEqual(['line', 'line', 'scatter', 'line'])
    expect(mounts(section(dashboardHtml(await wip()), 'flow')).map(m => m.kind)).toEqual(['line', 'line', 'scatter', 'bar'])
    expect(dashboardHtml(s)).toContain(`<script>${CHARTS_JS}</script>`)
    // Every chart has its one-line text alternative.
    expect((html.match(/<p class="chart-text">/g) ?? []).length).toBe(4)
  })

  test('it leads with the pace and the forecast, the numbers /progress charts shows', async () => {
    const s = await project()
    const pace = throughput(s.snapshots)!
    const lead = text(flowHtml(s).match(/<p class="flow-lead">[\s\S]*?<\/p>/)![0])
    expect(lead).toContain(`${pace.done} tasks done in ${pace.days} days since ${shortDay(s.snapshots[0]!.day)}`)
    expect(s.forecast?.kind).toBe('range')
    if (s.forecast?.kind === 'range') expect(lead).toContain(`likely ${shortDay(s.forecast.median)}`)
  })

  test('burn-up: scope and done per day, the same series as /progress charts, then the forecast cone', async () => {
    const s = await project()
    const c = burnupChart(s)
    const days = daily(s.snapshots)
    expect(c.spec).not.toBeNull()
    const spec = c.spec!
    expect(spec.kind).toBe('line')
    expect(series(spec, 'scope').data.map(p => [p.x, p.y])).toEqual(days.map(d => [d.day, d.total]))
    expect(series(spec, 'done').data.map(p => [p.x, p.y])).toEqual(days.map(d => [d.day, d.done]))
    const fc = s.forecast!
    if (fc.kind !== 'range') throw new Error('expected a range forecast')
    const last = days.at(-1)!
    expect(series(spec, 'likely').data.map(p => [p.x, p.y])).toEqual([[last.day, last.done], [fc.median, last.total]])
    expect(series(spec, 'fast').data.at(-1)).toMatchObject({ x: fc.optimistic, y: last.total })
    expect(series(spec, 'slow').data.at(-1)).toMatchObject({ x: fc.slow, y: last.total })
    // The fast-to-slow range is filled; the forecast lines are dashed.
    expect((spec as { cone?: string[] }).cone).toEqual(['fast', 'slow'])
    expect((spec as { dashed?: string[] }).dashed).toEqual(['likely', 'fast', 'slow'])
    // Tooltips read as words.
    expect(series(spec, 'done').data.at(-1)!.tip).toBe(`${shortDay(last.day)} · ${last.done} done of ${last.total}`)
    expect(series(spec, 'likely').data.at(-1)!.tip).toBe(`${shortDay(fc.median)} · likely finish, all ${last.total} done`)
    // The summary names the latest numbers: done of scope, scope change, the forecast range.
    expect(c.summary).toBe(`${last.done} of ${last.total} tasks done by ${shortDay(last.day)}; scope ${last.total}, +${last.total - days[0]!.total} since ${shortDay(days[0]!.day)}. Forecast ≈ ${shortDay(fc.median)} (fast ${shortDay(fc.optimistic)}, slow ${shortDay(fc.slow)}).`)
  })

  test('cumulative flow: done, in progress, blocked and to do per day, stacked from the bottom', async () => {
    const s = await project()
    // An old snapshot keeps no doing or blocked: both count as 0. Quiet days carry the day before.
    const snapshots = [
      { day: '2026-10-01', done: 0, total: 4 },
      { day: '2026-10-03', done: 1, total: 4, doing: 1, blocked: 1 },
      { day: '2026-10-05', done: 2, total: 5, doing: 1, blocked: 0 },
    ]
    const c = cumulativeFlowChart({ ...s, snapshots })
    const spec = c.spec!
    expect(spec.kind).toBe('line')
    expect((spec.data as Series[]).map(d => d.id)).toEqual(['done', 'in progress', 'blocked', 'to do'])
    expect(spec.colors).toEqual(['--done', '--doing', '--blocked', '--todo'])
    expect(spec.props).toMatchObject({ enableArea: true, yScale: { type: 'linear', stacked: true } })
    const days = daily(snapshots)
    expect(days.length).toBe(5)
    expect(series(spec, 'done').data.map(p => [p.x, p.y])).toEqual(days.map(d => [d.day, d.done]))
    expect(series(spec, 'done').data.map(p => p.y)).toEqual([0, 0, 1, 1, 2])
    expect(series(spec, 'in progress').data.map(p => p.y)).toEqual([0, 0, 1, 1, 1])
    expect(series(spec, 'blocked').data.map(p => p.y)).toEqual([0, 0, 1, 1, 0])
    expect(series(spec, 'to do').data.map(p => p.y)).toEqual([4, 4, 1, 1, 2])
    expect(series(spec, 'to do').data.at(-1)).toMatchObject({ tip: '2 to do', head: '5 Oct' })
    expect(c.summary).toBe('On 5 Oct: 2 done, 1 in progress, 0 blocked, 2 to do.')
    // The summary has the same counts as the terminal chart's legend.
    const legend = chartLegends(snapshots, null)!.flow.map(p => p.text)
    expect(c.summary).toBe(`On ${shortDay(days.at(-1)!.day)}: ${legend.map(l => l.replace(/^(.*) (\d+)$/, '$2 $1')).join(', ')}.`)
  })

  test('cycle time: days per done task, the numbers /progress charts shows', async () => {
    const s = await project()
    const c = cycleTimeChart(s)
    const spec = c.spec!
    expect(spec.kind).toBe('scatter')
    const per = taskDays(reportInput(s)).filter(t => !t.isRunning)
    const points = (spec.data as Series[])[0]!.data
    expect(points.map(p => p.y)).toEqual(per.map(t => t.days))
    expect(points.length).toBeGreaterThan(0)
    for (const p of points) expect(p.x).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const lastTask = per.at(-1)!
    expect(points.at(-1)!.tip).toBe(`${lastTask.id} ${lastTask.title} · ${lastTask.days} d · done ${shortDay(points.at(-1)!.x)}`)
    expect(c.summary).toContain(`${per.length} task${per.length === 1 ? '' : 's'} timed`)
    expect(c.summary).toContain(`latest ${lastTask.id}, ${lastTask.days} d`)
  })
})

describe('Flow view (K4): aging work in progress', () => {
  test('days in progress per started task, against the usual days per task', async () => {
    const s = await wip()
    const usual = usualDays(s)!
    // T1 and T2 done in the 10 days since 29 Sep: 5 days a task, as the band reckons it.
    expect(usual).toBe(5)
    const c = agingWipChart(s)
    const spec = c.spec!
    expect(spec.kind).toBe('bar')
    const rows = spec.data as { task: string; days?: number; over?: number; tip: string; label: string }[]
    expect(rows.map(r => [r.task, r.days ?? r.over])).toEqual([['T4', 1], ['T3', 24]])
    expect((spec as { guides?: { value: number }[] }).guides!.map(g => g.value)).toEqual([5, 10])
  })

  test('a task over twice the usual days is marked, the same threshold as the band alert', async () => {
    const s = await wip()
    expect(s.alerts.some(a => a.startsWith('T3 has run 24d, over twice the usual 5d'))).toBe(true)
    const rows = agingWipChart(s).spec!.data as { task: string; days?: number; over?: number; label: string; tip: string }[]
    const t3 = rows.find(r => r.task === 'T3')!
    const t4 = rows.find(r => r.task === 'T4')!
    expect(t3.over).toBe(24)
    expect(t3.days).toBeUndefined()
    expect(t3.label).toBe('▲ 24 d')
    expect(t3.tip).toBe('T3 Issue and revoke keys · 24 d in progress, over twice the usual 5 d')
    expect(t4.days).toBe(1)
    expect(t4.over).toBeUndefined()
    expect(t4.tip).toBe('T4 Rate limit per key · 1 d in progress')
    expect(agingWipChart(s).summary).toBe('2 tasks in progress. Over twice the usual 5 d a task: T3 at 24 d.')
  })

  test('the threshold is strict: exactly twice the usual is not marked', async () => {
    // T4 started the day tracking began: 10 days, exactly twice the usual 5.
    const edge = TODO_WIP.replace('started 2026-10-08', 'started 2026-09-29')
    const s = await buildState(io({ 'tasks/todo.md': edge }, git([['2026-10-08', edge], ['2026-10-03', TODO_T2_DONE], ['2026-09-29', TODO_NONE_DONE]])))
    expect(usualDays(s)).toBe(5)
    const rows = agingWipChart(s).spec!.data as { task: string; days?: number; over?: number }[]
    expect(rows.find(r => r.task === 'T4')).toMatchObject({ days: 10 })
    expect(rows.find(r => r.task === 'T4')!.over).toBeUndefined()
  })

  test('nothing started says so, with no mount', async () => {
    const c = agingWipChart(await project())
    expect(c.spec).toBeNull()
    expect(c.summary).toMatch(/^Nothing is in progress with a start date/)
  })
})

describe('Flow view (K4): too little history', () => {
  test('each chart says what it needs, and the page carries no bundle', async () => {
    const s = await buildState(io({ 'tasks/todo.md': TODO_WIP }))
    expect(s.snapshots.length).toBe(1)
    for (const c of flowCharts(s)) {
      expect(c.spec).toBeNull()
      // ETA drift needs forecasts on two days, which needs history too; the others, the history itself.
      expect(c.summary).toMatch(c.key === 'drift' ? /^ETA drift needs a forecast on 2 days/ : /needs 2 days of history/)
    }
    const html = dashboardHtml(s)
    expect(section(html, 'flow')).not.toContain('data-chart=')
    expect(text(section(html, 'flow'))).toMatch(/Burn-up .*needs 2 days of history/)
    expect(html).not.toContain(CHARTS_JS)
    expect(html.match(/<script\b/g)!.length).toBe(2)
  })

  test('no task list, or none with tasks: one message saying how to start, never a throw', async () => {
    for (const files of [{}, { 'SPEC.md': SPEC }, { 'tasks/todo.md': '# Tasks\n' }]) {
      const t = text(section(dashboardHtml(await buildState(io(files))), 'flow'))
      expect(t).toContain('No task list yet')
      expect(t).toContain('tasks/todo.md')
    }
  })

  test('all done: the burn-up says so instead of a forecast', async () => {
    const all = TODO_T3_DONE.replace(/- \[ \]/g, '- [x]')
    const s = await buildState(io({ 'tasks/todo.md': all }, git([['2026-10-08', all], ['2026-10-03', TODO_T2_DONE], ['2026-09-29', TODO_NONE_DONE]])))
    const c = burnupChart(s)
    expect(c.summary).toContain('Every task is done.')
    expect((c.spec!.data as Series[]).map(d => d.id)).toEqual(['scope', 'done'])
  })
})

describe('Flow view (K4): safety', () => {
  test('a hostile task title is escaped in the mounts and the summaries', async () => {
    const hostile = (t: string) => t.replace('## Task 2: Prisma schema for keys', '## Task 2: </script><script>alert(1)</script> & "keys"')
    const s = await buildState(io({ 'tasks/todo.md': hostile(TODO_T3_DONE) }, git([['2026-10-08', hostile(TODO_T3_DONE)], ['2026-10-03', hostile(TODO_T2_DONE)], ['2026-09-29', hostile(TODO_NONE_DONE)]])))
    const html = flowHtml(s)
    expect(html).not.toContain('<script>alert(1)')
    expect(html).not.toContain('</script>')
    const tips = mounts(html).flatMap(m => JSON.stringify(m))
    expect(tips.join('')).toContain('</script><script>alert(1)</script>')
  })

  test("each chart is mounted with the page's one chartMount", async () => {
    // One function, shared through html.ts, so the two can never drift.
    expect(chartMount).toBe(htmlChartMount)
    for (const c of flowCharts(await wip())) if (c.spec) expect(flowHtml(await wip())).toContain(chartMount(c.spec, c.summary))
  })

  test('the same state gives the same bytes', async () => {
    const s = await project()
    expect(flowHtml(s)).toBe(flowHtml(s))
  })

  test('colour never carries meaning alone: each legend entry has a glyph and words', async () => {
    const html = flowHtml(await project())
    const legends = [...html.matchAll(/<ul class="flow-legend"[^>]*>([\s\S]*?)<\/ul>/g)].map(m => text(m[1]!).trim())
    expect(legends[0]).toMatch(/━ scope ━ done ┅ likely finish ┅ fast to slow/)
    expect(legends[1]).toBe('✓ done ● in progress ■ blocked ○ to do')
    const wipLegends = [...flowHtml(await wip()).matchAll(/<ul class="flow-legend"[^>]*>([\s\S]*?)<\/ul>/g)].map(m => text(m[1]!).trim())
    expect(wipLegends).toContainEqual(expect.stringMatching(/^● in progress ▲ over twice the usual/))
  })
})

describe('ETA drift (K4, T10)', () => {
  test('a point per day that had a range forecast: the likely date, with the fast-to-slow range around it', async () => {
    const s = await project()
    const ranges = forecastHistory(s.snapshots).filter(p => p.forecast.kind === 'range')
    expect(ranges.length).toBe(2)
    const c = etaDriftChart(s)
    expect(c.spec).not.toBeNull()
    // Dates up the side as numbers on a linear scale, which runs upward: a slipping finish climbs.
    const ms = (day: string) => Date.parse(`${day}T00:00:00Z`)
    const likely = series(c.spec!, 'likely')
    expect(likely.data.map(d => [d.x, d.y])).toEqual(ranges.map(p => [p.day, ms((p.forecast as { median: string }).median)]))
    expect(series(c.spec!, 'fast').data.map(d => d.y)).toEqual(ranges.map(p => ms((p.forecast as { optimistic: string }).optimistic)))
    expect(series(c.spec!, 'slow').data.map(d => d.y)).toEqual(ranges.map(p => ms((p.forecast as { slow: string }).slow)))
    expect(c.spec).toMatchObject({ kind: 'line', cone: ['fast', 'slow'], dashed: ['fast', 'slow'], format: { x: 'day', y: 'day' } })
    const props = c.spec!.props as { yScale: { type: string; min: number; max: number }; axisLeft: { tickValues: number[] } }
    expect(props.yScale.type).toBe('linear')
    // Ticks fall on whole days, evenly spaced, inside the scale.
    const ticks = props.axisLeft.tickValues
    expect(ticks.length).toBeGreaterThan(2)
    for (const t of ticks) expect(t % 86_400_000).toBe(0)
    expect(new Set(ticks.slice(1).map((t, i) => t - ticks[i]!)).size).toBe(1)
    expect(ticks[0]! >= props.yScale.min && ticks.at(-1)! <= props.yScale.max).toBe(true)
    // Days before the forecast had three tasks to go on are left out.
    expect(likely.data.map(d => d.x)).not.toContain('2026-09-29')
    // Tooltips in words.
    const last = ranges.at(-1)!.forecast as { median: string; optimistic: string; slow: string }
    expect(likely.data.at(-1)!.tip).toBe(`${shortDay(ranges.at(-1)!.day)} · likely ${shortDay(last.median)}, range ${shortDay(last.optimistic)}–${shortDay(last.slow)}`)
  })

  test('the summary says how far the likely date moved since the first forecast', async () => {
    const s = await project()
    const ranges = forecastHistory(s.snapshots).filter(p => p.forecast.kind === 'range')
    const [a, b] = [ranges[0]!, ranges.at(-1)!].map(p => (p.forecast as { median: string }).median)
    const moved = Math.round((Date.parse(b!) - Date.parse(a!)) / 86_400_000)
    expect(moved).not.toBe(0)
    const c = etaDriftChart(s)
    expect(c.summary).toBe(`The likely finish moved ${moved > 0 ? `${moved} d later` : `${-moved} d sooner`} since ${shortDay(ranges[0]!.day)}: from ${shortDay(a!)} to ${shortDay(b!)}.`)
    expect(c.legend.map(l => `${l.glyph} ${l.label}`)).toEqual(['━ likely finish', '┅ fast to slow'])
  })

  test('the same likely date both days reads as no change', async () => {
    // 3 done in 3 days, then 4 in 4: one a day both times, 3 then 2 to go, so both forecasts land on 7 Oct.
    const steady = [
      { day: '2026-10-01', done: 0, total: 6 },
      { day: '2026-10-04', done: 3, total: 6 },
      { day: '2026-10-05', done: 4, total: 6 },
    ]
    const medians = forecastHistory(steady).filter(p => p.forecast.kind === 'range').map(p => (p.forecast as { median: string }).median)
    expect(medians).toEqual(['2026-10-07', '2026-10-07'])
    expect(etaDriftChart({ ...(await project()), snapshots: steady }).summary).toBe('The likely finish has held at 7 Oct since 4 Oct.')
  })

  test('under two range forecasts it says what it needs, with no mount', async () => {
    const s = await wip()
    expect(forecastHistory(s.snapshots).filter(p => p.forecast.kind === 'range').length).toBeLessThan(2)
    const c = etaDriftChart(s)
    expect(c.spec).toBeNull()
    expect(c.summary).toMatch(/^ETA drift needs a forecast on 2 days; /)
    expect(text(section(dashboardHtml(s), 'flow'))).toContain(c.summary)
  })

  test('flowCharts ends with it', async () => {
    expect(flowCharts(await project()).map(c => c.key)).toEqual(['burnup', 'cfd', 'cycle', 'aging', 'drift'])
  })
})
