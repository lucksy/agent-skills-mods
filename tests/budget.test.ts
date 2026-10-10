import { describe, expect, test } from 'claude-code/testing'

import { CHARTS_JS } from '../packages/core/dashboard/charts-bundle'
import { flowCharts } from '../packages/core/dashboard/flow'
import { chartMount, dashboardHtml, VIEW_IDS } from '../packages/core/dashboard/page'
import { parsePlan, parseSpec, parseTasks } from '../packages/core/parse'
import { buildState, toState, type ProjectIo } from '../packages/core/state'
import { forecast, type Snapshot } from '../packages/core/forecast'
import { GOOD_SPEC, SPEC, TODO_NONE_DONE, TODO_T2_DONE, TODO_T3_DONE, TODO_TEMPLATE, gitOutput } from './fixtures'

// T12: every view holds up on empty and partial projects, every chart has a
// spoken label, and a long plan stays inside the page's size and time limits.

const NOW = Date.parse('2026-10-09T10:00:00Z')
const io = (files: Record<string, string>): ProjectIo => ({
  cwd: '/work/keys',
  now: NOW,
  read: async rel => files[rel] ?? null,
  list: async rel => Object.keys(files).filter(f => (rel ? f.startsWith(`${rel}/`) && !f.slice(rel.length + 1).includes('/') : !f.includes('/'))).map(f => f.split('/').pop()!),
})
const panel = (html: string, id: string) => html.match(new RegExp(`<section[^>]*id="view-${id}"[\\s\\S]*?</section>\\s*<!-- /view-${id} -->`))?.[0] ?? ''

/** A plan of `n` tasks over `days` days: about one task done a day, the rest open, the last few waiting. */
function longPlan(n: number, days: number) {
  const done = Math.min(n - 5, Math.floor(days * 0.6))
  const todo = Array.from({ length: n }, (_, i) => {
    const id = i + 1
    const box = id <= done ? 'x' : ' '
    const phase = id % 15 === 1 ? `## Phase ${Math.ceil(id / 15)}: Part ${Math.ceil(id / 15)}\n\n` : ''
    return `${phase}## Task ${id}: Step ${id} of the long plan\n- [${box}] Build step ${id}\n- [${box}] Test step ${id}\n**Dependencies:** ${id > 1 ? `T${id - 1}` : 'None'}\n`
  }).join('\n')
  const start = Date.parse('2026-07-11T00:00:00Z')
  const snapshots: Snapshot[] = Array.from({ length: days }, (_, d) => ({
    day: new Date(start + d * 86_400_000).toISOString().slice(0, 10),
    done: Math.floor((done * (d + 1)) / days),
    total: n,
    doing: 1,
    blocked: 0,
  }))
  return { todo, snapshots, today: snapshots.at(-1)!.day }
}

describe('empty and partial projects (T12)', () => {
  const cases: [string, Record<string, string>][] = [
    ['an empty folder', {}],
    ['a spec only', { 'SPEC.md': SPEC }],
    ['a task list only, one day of history', { 'tasks/todo.md': TODO_TEMPLATE }],
    ['every task done', { 'SPEC.md': SPEC, 'tasks/todo.md': TODO_T3_DONE.replace(/- \[ \]/g, '- [x]') }],
    ['one task', { 'tasks/todo.md': '## Task 1: Only one\n- [ ] do it\n' }],
    ['a task list with no tasks', { 'tasks/todo.md': '# Tasks\n\nNothing yet.\n' }],
    ['two specs, no plan', { 'SPEC.md': SPEC, 'SPEC-limits.md': GOOD_SPEC }],
  ]
  for (const [name, files] of cases) {
    test(`${name}: every view renders with words, never empty`, async () => {
      const html = dashboardHtml(await buildState(io(files)))
      for (const id of VIEW_IDS) {
        const p = panel(html, id)
        expect(p).not.toBe('')
        // Something to read under the heading: a message or the view itself.
        expect(p.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length).toBeGreaterThan(id.length + 20)
      }
    })
  }
})

describe('accessibility (T12)', () => {
  test('every chart is an image to a screen reader, labelled with its summary', async () => {
    const { todo, snapshots, today } = longPlan(30, 40)
    const list = parseTasks(todo)
    const s = toState({ cwd: '/p', today, specs: [], specFile: null, list, listFile: 'tasks/todo.md', plan: null, forecast: forecast(snapshots, Date.parse(`${today}T10:00:00Z`)), snapshots, dates: {}, history: null })
    for (const c of flowCharts(s).filter(c => c.spec)) {
      const mount = chartMount(c.spec!, c.summary)
      expect(mount).toMatch(/^<div class="chart" role="img" aria-label="[^"]+"/)
      expect(mount).toContain(`aria-label="${c.summary.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`)
    }
  })

  test('cycle time keeps its dots off the axis ends: a day of room each side', async () => {
    const copies = gitOutput([['2026-10-08', TODO_T3_DONE], ['2026-10-03', TODO_T2_DONE], ['2026-09-29', TODO_NONE_DONE]])
    const run: ProjectIo['run'] = async (argv, opts) => ({ exitCode: 0, stdout: argv[1] === 'log' ? (argv.some(a => a.includes('%B')) ? '' : copies.log) : copies.answer(argv, opts?.stdin), stderr: '' })
    const s = await buildState({ ...io({ 'tasks/todo.md': TODO_T3_DONE }), run })
    const cycle = flowCharts(s).find(c => c.key === 'cycle')!
    expect(cycle.spec).not.toBeNull()
    const xs = (cycle.spec!.data as { data: { x: string }[] }[]).flatMap(d => d.data.map(p => Date.parse(`${p.x}T00:00:00Z`)))
    const scale = (cycle.spec!.props as { xScale: { min: string; max: string } }).xScale
    expect(Date.parse(`${scale.min}T00:00:00Z`)).toBe(Math.min(...xs) - 86_400_000)
    expect(Date.parse(`${scale.max}T00:00:00Z`)).toBe(Math.max(...xs) + 86_400_000)
  })
})

describe('budget (T12): 60 tasks, 90 days of history', () => {
  const { todo, snapshots, today } = longPlan(60, 90)
  const state = () => {
    const list = parseTasks(todo)
    return toState({
      cwd: '/p',
      today,
      specs: [{ file: 'SPEC.md', spec: parseSpec(SPEC) }],
      specFile: 'SPEC.md',
      list,
      listFile: 'tasks/todo.md',
      plan: parsePlan('# Plan\n'),
      forecast: forecast(snapshots, Date.parse(`${today}T10:00:00Z`)),
      snapshots,
      dates: {},
      history: 'history since 11 Jul: 90 days from git',
    })
  }

  test('renders in under 200 ms', () => {
    const s = state()
    dashboardHtml(s) // warm up
    const t0 = Date.now()
    const html = dashboardHtml(s)
    expect(Date.now() - t0).toBeLessThan(200)
    expect(html).toContain('data-view="overview"')
  })

  test('the page is under 250 KB without the chart bundle, and the bundle under 600 KB', () => {
    const html = dashboardHtml(state())
    expect(html).toContain(CHARTS_JS)
    const page = html.length - CHARTS_JS.length
    expect(page).toBeLessThan(250 * 1024)
    expect(CHARTS_JS.length).toBeLessThan(600 * 1024)
  })
})
