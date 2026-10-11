import { describe, expect, test } from 'claude-code/testing'

import { runAction, type ActionInput } from '../packages/core/actions'
import { boardHtml } from '../packages/core/dashboard/board'
import { parseSizeLine, setSize, stampTodo } from '../packages/core/format'
import { forecast, snapshotOf, type Snapshot } from '../packages/core/forecast'
import { parseTasks } from '../packages/core/parse'
import { listPoints, pointsOf, weightOf } from '../packages/core/size'
import { stateJson, toState } from '../packages/core/state'
import { boardRows, taskDetail } from '../packages/core/view'
import { TODO_TEMPLATE } from './fixtures'

// ceremonies T1: an optional `**Size:** S|M|L` line under a task's Status line.
// S weighs ½ point, M 1, L 2; a task without one counts as 1, the same as M.

const SIZED = `# Tasks: gateway

## Task 1: Scaffold
**Status:** done · started 2026-10-01 · done 2026-10-02
**Size:** S

- [x] Builds

## Task 2: Rate limit
**Status:** in progress · @amila · started 2026-10-03
**Size:** L

- [x] Middleware
- [ ] 429 after 60 req/min

## Task 3: Docs
**Status:** todo

- [ ] README
`

function input(todo: string): ActionInput {
  return { todo, plan: null, spec: null, list: parseTasks(todo), today: '2026-10-11', team: null, email: null, pending: {}, keepFormat: true }
}

const task = (text: string, id: string) => parseTasks(text).tasks.find(t => t.id === id)!

describe('the Size line (T1)', () => {
  test('reads S, M and L in any case; anything else is not a Size line', () => {
    expect(parseSizeLine('**Size:** M')).toBe('M')
    expect(parseSizeLine('  **Size**: l')).toBe('L')
    expect(parseSizeLine('**Size:** XL')).toBeNull()
    expect(parseSizeLine('**Status:** todo')).toBeNull()
    expect(parseSizeLine('Size: M')).toBeNull()
  })

  test('the parser exposes it; a task without one has no size key, so old files parse exactly as before', () => {
    expect(task(SIZED, 'T1').size).toBe('S')
    expect(task(SIZED, 'T2').size).toBe('L')
    expect('size' in task(SIZED, 'T3')).toBe(false)
    for (const t of parseTasks(TODO_TEMPLATE).tasks) expect('size' in t).toBe(false)
  })

  test('written under the Status line, replaced in place, and cleared byte for byte', () => {
    const added = setSize(SIZED, 'T3', 'M')
    expect(added).toBe(SIZED.replace('## Task 3: Docs\n**Status:** todo\n', '## Task 3: Docs\n**Status:** todo\n**Size:** M\n'))
    expect(setSize(added, 'T3', 'S')).toBe(SIZED.replace('## Task 3: Docs\n**Status:** todo\n', '## Task 3: Docs\n**Status:** todo\n**Size:** S\n'))
    expect(setSize(added, 'T3', null)).toBe(SIZED)
    expect(setSize(SIZED, 'T9', 'M')).toBe(SIZED)
  })

  test('without a Status line it goes under the heading, and the format puts the Status line above it', () => {
    const sized = setSize(TODO_TEMPLATE, 'T4', 'L')
    expect(sized).toContain('## Task 4: Rate limit per key\n**Size:** L\n\n**Acceptance criteria:**')
    expect(stampTodo(sized, '2026-10-11')).toContain('## Task 4: Rate limit per key\n**Status:** todo\n**Size:** L\n')
    expect(task(sized, 'T4').size).toBe('L')
  })

  test('a Size line inside a code block is not the task\'s', () => {
    const text = '## Task 1: Docs\n**Status:** todo\n\n```md\n**Size:** L\n```\n- [ ] README\n'
    expect('size' in task(text, 'T1')).toBe(false)
    expect(setSize(text, 'T1', 'S')).toBe('## Task 1: Docs\n**Status:** todo\n**Size:** S\n\n```md\n**Size:** L\n```\n- [ ] README\n')
  })
})

describe('weights and points (T1)', () => {
  test('S ½, M 1, L 2, and no size 1', () => {
    expect([weightOf({ size: 'S' }), weightOf({ size: 'M' }), weightOf({ size: 'L' }), weightOf({})]).toEqual([0.5, 1, 2, 1])
  })

  test('a list\'s points, done and in total; with no sizes they are the counts', () => {
    expect(pointsOf(parseTasks(SIZED).tasks)).toBe(3.5)
    expect(listPoints(parseTasks(SIZED))).toEqual({ done: 0.5, total: 3.5 })
    const plain = parseTasks(TODO_TEMPLATE)
    expect(listPoints(plain)).toEqual({ done: plain.done, total: plain.total })
  })
})

describe('the size action (T1)', () => {
  test('writes, replaces and clears the line, and says so', () => {
    const set = runAction('size', { id: 't3', size: 'm' }, input(SIZED))
    expect(set).toEqual({ ok: true, reply: 'T3 Docs is size M (1 point).', writes: [{ file: 'tasks/todo.md', text: setSize(SIZED, 'T3', 'M') }] })
    const bigger = runAction('size', { id: 'T2', size: 'S' }, input(SIZED))
    expect(bigger.reply).toBe('T2 Rate limit is size S (½ point), was L.')
    const cleared = runAction('size', { id: '2', size: '-' }, input(SIZED))
    expect(cleared.reply).toBe('T2 Rate limit has no size now (was L): it counts as 1 point, like M.')
    expect(task(cleared.writes[0]!.text, 'T2').size).toBeUndefined()
  })

  test('the same size again, or clearing none, writes nothing', () => {
    expect(runAction('size', { id: 'T2', size: 'L' }, input(SIZED))).toEqual({ ok: true, reply: 'T2 Rate limit is already size L.', writes: [] })
    expect(runAction('size', { id: 'T3', size: '-' }, input(SIZED))).toEqual({ ok: true, reply: 'T3 Docs has no size.', writes: [] })
  })

  test('refuses an unknown task, a size other than S, M, L or -, and a missing one', () => {
    expect(runAction('size', { id: 'T9', size: 'M' }, input(SIZED))).toEqual({ ok: false, reply: 'No "## Task 9:" section in tasks/todo.md. Tasks: T1, T2, T3.', writes: [] })
    expect(runAction('size', { id: 'T3', size: 'XL' }, input(SIZED))).toEqual({ ok: false, reply: '"XL" is not a size. Use S, M or L, or - to clear it: /progress size T3 M.', writes: [] })
    expect(runAction('size', { id: 'T3' }, input(SIZED))).toEqual({ ok: false, reply: 'Say the size: /progress size T3 M (S, M or L; - clears it).', writes: [] })
    expect(runAction('size', {}, input(SIZED)).reply).toBe('Say which task and its size: /progress size T4 M (S, M or L; - clears it).')
  })

  test('a live write changes the Size line only', () => {
    const r = runAction('size', { id: 'T3', size: 'L' }, { ...input(TODO_TEMPLATE.replace('## Task 3: Issue and revoke keys\n', '## Task 3: Issue and revoke keys\n**Status:** todo\n')), scoped: true })
    expect(r.writes[0]!.text).toBe(TODO_TEMPLATE.replace('## Task 3: Issue and revoke keys\n', '## Task 3: Issue and revoke keys\n**Status:** todo\n**Size:** L\n'))
  })
})

describe('size where tasks are shown (T1)', () => {
  const list = parseTasks(SIZED)

  test('the board pane and /progress task', () => {
    const rows = boardRows(list).filter(r => r.kind === 'task') as { id: string; title: string }[]
    expect(rows.map(r => r.title)).toEqual(['Scaffold (S)', 'Rate limit (L) · @amila', 'Docs'])
    expect(taskDetail(list, 'T2', { today: '2026-10-11', dates: {}, commits: [] })!.split('\n')[1]).toBe('current · @amila · size L (2 points) · started 3 Oct · 8d so far')
    expect(taskDetail(list, 'T3', { today: '2026-10-11', dates: {}, commits: [] })!.split('\n')[1]).toBe('to do')
  })

  test('the dashboard\'s Board cards, and only on sized tasks', () => {
    const state = toState({ cwd: '/p', today: '2026-10-11', specs: [], specFile: null, list, listFile: 'tasks/todo.md', plan: null, forecast: null, snapshots: [], dates: {}, history: null })
    const html = boardHtml(state)
    expect(html).toContain('<span class="c-size" title="Size L: 2 points">size L</span>')
    expect(html).toContain('<span class="c-size" title="Size S: ½ point">size S</span>')
    expect((html.match(/c-size/g) ?? []).length).toBe(2)
  })

  test('--json gives a sized task its size, and leaves the key out of an unsized one', () => {
    const state = toState({ cwd: '/p', today: '2026-10-11', specs: [], specFile: null, list, listFile: 'tasks/todo.md', plan: null, forecast: null, snapshots: [], dates: {}, history: null })
    const items = stateJson(state).tasks!.items
    expect(items.map(t => t.size)).toEqual(['S', 'L', undefined])
    expect('size' in items[2]!).toBe(false)
  })
})

// ceremonies T2: the ETA in points. Snapshots carry points once a task has a
// size, and the forecast reads them; with no sizes nothing changes (state.test.ts).
describe('the ETA in points (T2)', () => {
  /** T1–T3 are L and done, T4 and T5 S and left: 6 of 7 points done, 3 of 5 tasks. */
  const NOW = Date.parse('2026-10-07T10:00:00Z')
  const HISTORY: Snapshot[] = [
    { day: '2026-10-01', done: 0, total: 5, points: 0, totalPoints: 7 },
    { day: '2026-10-07', done: 3, total: 5, points: 6, totalPoints: 7 },
  ]
  const counts = (h: Snapshot[]) => h.map(({ points: _p, totalPoints: _t, ...s }) => s)

  test('L tasks done and S tasks left: an earlier ETA than counting tasks, by hand', () => {
    // Tasks: 3 in 6 days is 0.5 a day, 2 left: ⌈2 / 0.625⌉ = 4 days, ⌈2 / 0.5⌉ = 4, ⌈2 / 0.35⌉ = 6.
    expect(forecast(counts(HISTORY), NOW)).toEqual({ kind: 'range', optimistic: '2026-10-11', median: '2026-10-11', slow: '2026-10-13', basis: 'from 3 tasks in 6 days', added: 0 })
    // Points: 6 in 6 days is 1 a day, 1 left: ⌈1 / 1.25⌉ = 1 day, ⌈1 / 1⌉ = 1, ⌈1 / 0.7⌉ = 2.
    expect(forecast(HISTORY, NOW)).toEqual({ kind: 'range', optimistic: '2026-10-08', median: '2026-10-08', slow: '2026-10-09', basis: 'from 6 points in 6 days', added: 0 })
  })

  test('a snapshot records points only once a task has a size', () => {
    expect(snapshotOf('2026-10-11', parseTasks(SIZED))).toEqual({ day: '2026-10-11', done: 1, total: 3, doing: 1, blocked: 0, points: 0.5, totalPoints: 3.5 })
    expect(Object.keys(snapshotOf('2026-10-11', parseTasks(TODO_TEMPLATE)))).toEqual(['day', 'done', 'total', 'doing', 'blocked'])
  })

  test('history stored before sizes: tasks until the days with points say a pace on their own', () => {
    const old = counts(HISTORY)
    // Only today has points: too little to say a pace, so the whole history counts tasks, as before.
    const mixed = [old[0]!, HISTORY[1]!]
    expect(forecast(mixed, NOW)).toEqual(forecast(old, NOW))
    // Points from the second day on: those days alone give the range.
    const later = [{ day: '2026-09-28', done: 0, total: 5 }, { day: '2026-10-01', done: 0, total: 5, points: 0, totalPoints: 7 }, HISTORY[1]!]
    expect(forecast(later, NOW)).toMatchObject({ median: '2026-10-08', basis: 'from 6 points in 6 days' })
  })

  test('an old history.json, read as JSON, still loads and forecasts in tasks', () => {
    const stored = JSON.parse('[{"day":"2026-10-01","done":0,"total":5},{"day":"2026-10-07","done":3,"total":5,"doing":1}]') as Snapshot[]
    expect(forecast(stored, NOW)).toMatchObject({ kind: 'range', basis: 'from 3 tasks in 6 days' })
  })
})
