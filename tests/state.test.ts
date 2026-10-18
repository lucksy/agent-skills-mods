import { describe, expect, test } from 'claude-code/testing'

import { buildState, stateJson, toState, type ProjectIo, type State } from '../packages/core/state'
import { renderJson } from '../packages/core/cli'
import { burnup, chartLegends, flow, throughput } from '../packages/core/chart'
import { flowCharts } from '../packages/core/dashboard/flow'
import { dayOf, forecast, forecastHistory, type Snapshot } from '../packages/core/forecast'
import { parseTasks } from '../packages/core/parse'
import { hashText } from '../packages/core/serve'
import { burnupSvg, flowSvg } from '../packages/core/svg'
import { CHECKLIST, GOOD_SPEC, PLAN_INDEX, SPEC, TODO_CP_DONE, TODO_T2_DONE, TODO_T3_DONE, TODO_NONE_DONE, TODO_TEMPLATE, gitOutput } from './fixtures'

// State v1 (J2): the one shape every surface reads, built the same way from the
// plugin's parts and from the CLI's file reads.

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

describe('State v1 (J2)', () => {
  test('buildState reads every spec file, the task list and the history, as schema 1', async () => {
    const s = await buildState(io({ 'SPEC.md': SPEC, 'SPEC-auth.md': GOOD_SPEC, 'tasks/todo.md': TODO_T3_DONE }, HISTORY))
    expect(s.schema).toBe(1)
    expect(s.today).toBe('2026-10-09')
    expect(s.specs.map(x => [x.file, x.spec.title])).toEqual([
      ['SPEC.md', 'API keys'],
      ['SPEC-auth.md', 'Rate limits'],
    ])
    expect(s.specFile).toBe('SPEC.md')
    expect(s.spec?.title).toBe('API keys')
    expect([s.list?.done, s.list?.total, s.list?.current?.id]).toEqual([3, 4, 'T4'])
    expect(s.forecast?.kind).toBe('range')
    expect(s.snapshots.length).toBeGreaterThan(1)
    expect(s.needsYou).toContain('approve SPEC.md')
    expect(Array.isArray(s.alerts)).toBe(true)
  })

  test('the spec in focus can be any of them', async () => {
    const s = await buildState(io({ 'SPEC.md': SPEC, 'specs/limits.md': GOOD_SPEC, 'tasks/todo.md': TODO_TEMPLATE }), { specFile: 'specs/limits.md' })
    expect(s.specFile).toBe('specs/limits.md')
    expect(s.spec?.title).toBe('Rate limits')
    expect(s.specs.map(x => x.file)).toEqual(['SPEC.md', 'specs/limits.md'])
  })

  test('toState from the same parts gives the same state: the plugin and the CLI agree', async () => {
    const s = await buildState(io({ 'SPEC.md': SPEC, 'tasks/todo.md': TODO_T3_DONE }, HISTORY))
    const again = toState({
      cwd: s.cwd,
      today: s.today,
      specs: s.specs,
      specFile: s.specFile,
      list: s.list,
      listFile: s.listFile,
      plan: s.plan,
      forecast: s.forecast,
      snapshots: s.snapshots,
      dates: s.dates,
      history: s.history,
      commits: s.commits,
    })
    expect(again).toEqual(s)
  })

  test('an empty folder is a state too', async () => {
    const s = await buildState(io({}))
    expect([s.schema, s.spec, s.list, s.specs, s.needsYou, s.alerts]).toEqual([1, null, null, [], [], []])
  })
})

describe('the JSON contract (J3)', () => {
  test('--json prints State v1 and keeps every field it printed before', async () => {
    const s = await buildState(io({ 'specs/limits.md': GOOD_SPEC, 'tasks/todo.md': TODO_TEMPLATE }), { specFile: 'specs/limits.md' })
    const json = JSON.parse(renderJson(s))
    // Fields printed before State v1.
    expect(Object.keys(json)).toEqual(expect.arrayContaining(['cwd', 'spec', 'tasks', 'forecast', 'needsYou', 'history']))
    expect(Object.keys(json.spec)).toEqual(expect.arrayContaining(['file', 'title', 'approval', 'areas', 'openQuestions']))
    expect(Object.keys(json.tasks)).toEqual(expect.arrayContaining(['file', 'done', 'total', 'current', 'items']))
    expect(Object.keys(json.tasks.items[0])).toEqual(expect.arrayContaining(['id', 'title', 'phase', 'status', 'deps', 'open', 'date']))
    // Added by State v1.
    expect(json).toMatchObject({ schema: 1, today: '2026-10-09', specs: [{ file: 'specs/limits.md', title: 'Rate limits' }] })
    expect(Object.keys(json)).toEqual(expect.arrayContaining(['alerts', 'snapshots', 'plan']))
    expect(json).toEqual(JSON.parse(JSON.stringify(stateJson(s))))
  })

  test('each task carries its Status line state, why it is blocked and its checkpoint', async () => {
    const todo = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · started 2026-10-07 · step test\n')
    const json = stateJson(await buildState(io({ 'tasks/todo.md': todo })))
    const t2 = json.tasks!.items.find(t => t.id === 'T2')!
    expect(t2.state).toMatchObject({ status: 'in progress', started: '2026-10-07', step: 'test' })
    expect(t2.checkpoint).toMatchObject({ title: 'After Tasks 1-2', open: ['All tests pass', 'Review with human before proceeding'] })
  })
})

// ceremonies T2: with no Size lines every task weighs 1, so the forecast, the
// charts' series and --json stay byte for byte what 0.39.0 printed. Each hash
// below was taken from these outputs before the ETA learned points.
describe('no sizes, no change (ceremonies T2)', () => {
  const FIXTURES: [string, string][] = [
    ['TODO_TEMPLATE', TODO_TEMPLATE],
    ['TODO_T2_DONE', TODO_T2_DONE],
    ['TODO_CP_DONE', TODO_CP_DONE],
    ['TODO_T3_DONE', TODO_T3_DONE],
    ['TODO_NONE_DONE', TODO_NONE_DONE],
    ['PLAN_INDEX', PLAN_INDEX],
    ['CHECKLIST', CHECKLIST],
  ]
  /** A history.json as the plugin stored one before 0.40.0: counts only, a month long. */
  const STORED: Snapshot[] = Array.from({ length: 30 }, (_, i) => ({ day: dayOf(Date.parse('2026-09-10T00:00:00Z') + i * 86_400_000), done: Math.floor(i / 4), total: 10 + Math.floor(i / 10), doing: i % 3, blocked: i % 5 === 0 ? 1 : 0 }))
  const outputs = (s: State) => {
    const fc = s.forecast
    // T11's inbox is a field added to --json since 0.39.0; every other byte is as before.
    const { inbox: _, ...json } = JSON.parse(renderJson(s)) as Record<string, unknown>
    return JSON.stringify({
      json: JSON.stringify(json, null, 2),
      drift: forecastHistory(s.snapshots),
      burnup: burnup(s.snapshots, fc, 40, 8),
      flow: flow(s.snapshots, 40, 8),
      legends: chartLegends(s.snapshots, fc),
      pace: throughput(s.snapshots),
      // A date at a chart's edge hangs inward since 0.40.1 (text-anchor start/end); every other byte is as before.
      svg: [burnupSvg(s.snapshots, fc), flowSvg(s.snapshots)].map(c => c && { ...c, source: c.source.replace(/text-anchor="(start|end)">(\d+ \w{3})</g, 'text-anchor="middle">$2<') }),
      dashboard: flowCharts(s),
    })
  }
  const HASHES: Record<string, string> = {
    TODO_TEMPLATE: '9901e27e321b8bd0',
    TODO_T2_DONE: 'bb89952784b55cc6',
    TODO_CP_DONE: '9d53d9ffa1fc6b89',
    TODO_T3_DONE: '32b93a17b8d363aa',
    TODO_NONE_DONE: 'eb86b6d4a819f5b7',
    PLAN_INDEX: '0b831b06fccb9ad4',
    CHECKLIST: '757633d7b07456d5',
    STORED: 'e9102489dadfc7f3',
  }

  for (const [name, text] of FIXTURES) {
    test(`${name}: forecast, chart series and --json as before`, async () => {
      const s = await buildState(io({ 'SPEC.md': SPEC, 'tasks/todo.md': text }, HISTORY))
      expect(hashText(outputs(s))).toBe(HASHES[name]!)
    })
  }

  test('a stored history without points: forecast, drift and charts as before', () => {
    const list = parseTasks(TODO_TEMPLATE)
    const fc = forecast(STORED, Date.parse('2026-10-09T10:00:00Z'))
    const s = toState({ cwd: '/p', today: '2026-10-09', specs: [], specFile: null, list, listFile: 'tasks/todo.md', plan: null, forecast: fc, snapshots: STORED, dates: {}, history: null })
    expect(fc).toEqual({ kind: 'range', optimistic: '2026-10-24', median: '2026-10-30', slow: '2026-11-08', basis: 'from 7 tasks in 29 days', added: 2 })
    expect(hashText(outputs(s))).toBe(HASHES.STORED!)
  })
})

// ceremonies T2: the history rebuild weighs each older copy of the list by today's sizes.
describe('history in points (ceremonies T2)', () => {
  /** T1–T3 are L, T4 and T5 S: 7 points in 5 tasks. Older copies have no Size lines yet. */
  const PLAN = (done: number[], sized: boolean) =>
    `# Tasks: gateway\n${[['Auth', 'L'], ['Keys', 'L'], ['Quotas', 'L'], ['Docs', 'S'], ['Notes', 'S']]
      .map(([title, size], i) => `\n## Task ${i + 1}: ${title}\n${sized ? `**Size:** ${size}\n` : ''}- [${done.includes(i + 1) ? 'x' : ' '}] ${title} works\n`)
      .join('')}`
  const SIZED_HISTORY = git([['2026-10-07', PLAN([1, 2, 3], false)], ['2026-10-04', PLAN([1], false)], ['2026-10-01', PLAN([], false)]])

  test('older copies written before the sizes are weighed by them, and the ETA is in points', async () => {
    const s = await buildState(io({ 'tasks/todo.md': PLAN([1, 2, 3], true) }, SIZED_HISTORY))
    expect(s.snapshots.map(x => [x.day, x.done, x.total, x.points, x.totalPoints])).toEqual([
      ['2026-10-01', 0, 5, 0, 7],
      ['2026-10-04', 1, 5, 2, 7],
      ['2026-10-07', 3, 5, 6, 7],
      ['2026-10-09', 3, 5, 6, 7],
    ])
    // 6 points in 8 days: 0.75 a day, 1 point left: ⌈1 / 0.75⌉ = 2 days in every case.
    expect(s.forecast).toEqual({ kind: 'range', optimistic: '2026-10-11', median: '2026-10-11', slow: '2026-10-11', basis: 'from 6 points in 8 days', added: 0 })
    // The same plan with no sizes: 3 tasks in 8 days, 2 left, as 0.39.0 counted it.
    const plain = await buildState(io({ 'tasks/todo.md': PLAN([1, 2, 3], false) }, SIZED_HISTORY))
    expect(plain.snapshots.every(x => x.points === undefined)).toBe(true)
    expect(plain.forecast).toMatchObject({ median: '2026-10-15', basis: 'from 3 tasks in 8 days' })
  })
})
