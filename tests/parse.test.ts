import { describe, expect, test } from 'claude-code/testing'

import { parsePlan, parseSpec, parseTasks } from '../hooks/lib/parse'
import { checkOverwrite } from '../hooks/lib/guard'
import { forecast, record, shortDay, type Snapshot } from '../hooks/lib/forecast'
import { mergeHistory, parseLog, snapshotsFromGit, splitBatch } from '../hooks/lib/history'
import { bandText, blockChain, completionToast, forecastText, progressBrief, taskInPrompt, nextText, statusText, timelineRows } from '../hooks/lib/view'
import {
  CHECKLIST,
  GOOD_SPEC,
  PLAN_INDEX,
  SPEC,
  TODO_CP_DONE,
  TODO_T2_DONE,
  TODO_T3_DONE,
  TODO_TEMPLATE,
  TODO_NONE_DONE,
  gitOutput,
  WEAK_SPEC,
} from './fixtures'

describe('parseTasks', () => {
  test('template: ## Task N sections, dependencies and checkpoints', async () => {
    const list = parseTasks(TODO_TEMPLATE)
    expect(list.kind).toBe('tasks')
    expect(list.total).toBe(4)
    expect(list.done).toBe(1)
    expect(list.tasks.map(t => t.status)).toEqual(['done', 'next', 'blocked', 'todo'])
    expect(list.current?.id).toBe('T2')
    expect(list.tasks[2]?.deps).toEqual(['T2'])
    expect(list.tasks[3]?.deps).toEqual(['T1'])
    expect(list.tasks[1]?.checkpoint?.title).toBe('After Tasks 1-2')
    expect(list.tasks[0]?.phase).toBe('Phase 1: Foundation')
    expect(list.tasks[2]?.phase).toBe('Phase 2: Core')
  })

  test('plan index: - [ ] Task N lines under phases', async () => {
    const list = parseTasks(PLAN_INDEX)
    expect(list.kind).toBe('tasks')
    expect(list.total).toBe(4)
    expect(list.done).toBe(2)
    expect(list.current?.id).toBe('T3')
    expect(list.checkpoints.length).toBe(2)
    expect(list.tasks[1]?.checkpoint?.title).toBe('Foundation')
  })

  test('free-form checklist falls back to plain boxes', async () => {
    const list = parseTasks(CHECKLIST)
    expect(list.kind).toBe('checklist')
    expect(list.total).toBe(3)
    expect(list.done).toBe(1)
    expect(list.current?.title).toBe('write the parser')
  })

  test('never throws on text with no tasks', async () => {
    expect(parseTasks('').kind).toBe('empty')
    expect(parseTasks('# Notes\n\nnothing here\n```\n- [ ] in a fence\n```').total).toBe(0)
  })
})

describe('parseSpec', () => {
  test('six areas, boundaries and front matter', async () => {
    const spec = parseSpec(SPEC)
    expect(spec.title).toBe('API keys')
    expect(spec.status).toBe('draft')
    expect(spec.areas.map(a => `${a.key}:${a.state}`)).toEqual([
      'objective:present',
      'commands:present',
      'structure:empty',
      'style:missing',
      'testing:present',
      'boundaries:present',
    ])
    expect(spec.boundaries.always).toEqual(['run tests before commits', 'validate inputs'])
    expect(spec.boundaries.ask).toEqual(['database schema changes'])
    expect(spec.boundaries.never).toEqual(['commit secrets', 'log API keys'])
    expect(spec.openQuestions).toEqual(['Should keys expire by default?'])
  })

  test('weak sections are flagged with one reason each (A2)', async () => {
    const hints = (text: string) => Object.fromEntries(parseSpec(text).areas.map(a => [a.key, a.hint]))
    expect(hints(WEAK_SPEC)).toEqual({
      objective: '1 of 2 success criteria have no number or condition: "Delivery is reliable"',
      commands: 'no runnable command line',
      structure: null,
      style: 'no example code block',
      testing: null,
      boundaries: null,
    })
    const good = parseSpec(GOOD_SPEC)
    expect(good.successCriteria).toEqual(['60 requests per minute per key by default', 'Over the limit returns 429 with Retry-After'])
    expect(good.areas.map(a => a.hint)).toEqual([null, null, null, null, null, null])
    // No criteria anywhere; missing and empty areas carry no hint, their state says it.
    expect(hints(SPEC)).toMatchObject({ objective: 'no success criteria', commands: null, structure: null, style: null })
  })

  test('plan doc: tracker line and open questions', async () => {
    const plan = parsePlan(PLAN_INDEX + '\nTasks tracked in Linear project NOTIF.\n')
    expect(plan.trackedIn).toBe('Linear project NOTIF')
    expect(plan.openQuestions[0]).toBe('Upstash or self-hosted Redis?')
  })
})

describe('checkOverwrite', () => {
  test('ticking a box in a full rewrite is allowed', async () => {
    const ticked = TODO_TEMPLATE.replace('- [ ] Migration runs', '- [x] Migration runs')
    expect(checkOverwrite(TODO_TEMPLATE, ticked).isAllowed).toBe(true)
  })

  test('adding a task is allowed', async () => {
    const more = TODO_TEMPLATE + '\n## Task 5: Docs\n- [ ] README\n'
    expect(checkOverwrite(TODO_TEMPLATE, more).isAllowed).toBe(true)
  })

  test('a different plan over unfinished tasks is refused', async () => {
    const v = checkOverwrite(TODO_TEMPLATE, PLAN_INDEX)
    expect(v.isAllowed).toBe(false)
    if (!v.isAllowed) {
      expect(v.open).toBe(3)
      expect(v.lost.map(t => t.id)).toEqual(['T2', 'T3', 'T4'])
    }
  })

  test('a finished plan may be replaced', async () => {
    const done = TODO_TEMPLATE.replace(/- \[ \]/g, '- [x]')
    expect(checkOverwrite(done, PLAN_INDEX).isAllowed).toBe(true)
  })
})

describe('history from git (F5)', () => {
  const current = parseTasks(TODO_T3_DONE)

  test('one snapshot per day from its last commit, stopping at an older plan', async () => {
    const { log, cat } = gitOutput([
      ['2026-10-08', TODO_T3_DONE],
      ['2026-10-03', TODO_T2_DONE],
      ['2026-10-03', TODO_TEMPLATE],
      ['2026-09-29', TODO_NONE_DONE],
      ['2026-09-20', PLAN_INDEX],
      ['2026-09-10', TODO_NONE_DONE],
    ])
    const commits = parseLog(log)
    expect(commits.length).toBe(6)
    expect(snapshotsFromGit(commits, splitBatch(cat), current)).toEqual([
      { day: '2026-09-29', done: 0, total: 4 },
      { day: '2026-10-03', done: 2, total: 4 },
      { day: '2026-10-08', done: 3, total: 4 },
    ])
  })

  test('a commit without the file ends the walk; the mod\'s own snapshots win a shared day', async () => {
    const { log, cat } = gitOutput([
      ['2026-10-08', TODO_T3_DONE],
      ['2026-10-01', null],
      ['2026-09-29', TODO_NONE_DONE],
    ])
    expect(splitBatch(cat)).toEqual([TODO_T3_DONE, null, TODO_NONE_DONE])
    const fromGit = snapshotsFromGit(parseLog(log), splitBatch(cat), current)
    expect(fromGit).toEqual([{ day: '2026-10-08', done: 3, total: 4 }])
    const stored = [{ day: '2026-10-08', done: 4, total: 4 }]
    expect(mergeHistory(stored, [{ day: '2026-10-02', done: 1, total: 4 }, ...fromGit])).toEqual([
      { day: '2026-10-02', done: 1, total: 4 },
      { day: '2026-10-08', done: 4, total: 4 },
    ])
  })
})

describe('forecast', () => {
  const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}`
  const now = Date.parse('2026-10-12T10:00:00Z')

  test('under 3 tasks done says not enough history', async () => {
    const h: Snapshot[] = [
      { day: day(1), done: 0, total: 9 },
      { day: day(5), done: 2, total: 9 },
    ]
    const f = forecast(h, now)
    expect(f.kind).toBe('not-enough')
    expect(forecastText(f)).toMatch(/not enough history/)
  })

  test('a range with basis, ordered optimistic ≤ median ≤ slow, and added scope', async () => {
    let h: Snapshot[] = []
    h = record(h, { day: day(1), done: 0, total: 7 })
    h = record(h, { day: day(6), done: 2, total: 8 })
    h = record(h, { day: day(12), done: 4, total: 9 })
    const f = forecast(h, now)
    expect(f.kind).toBe('range')
    if (f.kind === 'range') {
      expect(f.optimistic <= f.median && f.median <= f.slow).toBe(true)
      expect(f.basis).toBe('from 4 tasks in 11 days')
      expect(f.added).toBe(2)
      expect(forecastText(f)).toBe(`ETA ${shortDay(f.median)} (fast ${shortDay(f.optimistic)}, slow ${shortDay(f.slow)}) · from 4 tasks in 11 days · +2 added since tracking began`)
    }
  })

  test('record keeps one snapshot per day', async () => {
    const h = record([{ day: day(1), done: 0, total: 3 }], { day: day(1), done: 1, total: 3 })
    expect(h).toEqual([{ day: day(1), done: 1, total: 3 }])
  })
})

describe('views', () => {
  test('status entry and band', async () => {
    const list = parseTasks(TODO_TEMPLATE)
    expect(statusText(parseSpec(SPEC), list)).toBe('spec ♦ awaiting approval · plan 1/4')
    expect(statusText(parseSpec(SPEC.replace('draft', 'approved')), list)).toBe('spec ✓ approved · plan 1/4')
    expect(statusText(null, null)).toBe(undefined)
    expect(bandText(list)).toBe('● T2 Prisma schema for keys · 2 criteria left · 1/4 done · checkpoint after this task')
    expect(bandText(null)).toBe(undefined)
    expect(bandText(parseTasks(TODO_TEMPLATE.replace(/- \[ \]/g, '- [x]')))).toBe(undefined)
  })

  test('/progress next names the task, its criteria and the checkpoint', async () => {
    const text = nextText(parseTasks(TODO_TEMPLATE), null)
    expect(text).toMatch(/^Next: T2 Prisma schema for keys/)
    expect(text).toMatch(/\[ \] Migration runs on a clean database/)
    expect(text).toMatch(/Checkpoint after this task: After Tasks 1-2/)
    expect(nextText(null, null)).toMatch(/Run \/plan/)
  })

  test('completion toast: checkpoint first, one per edit, none for unticking (B4)', async () => {
    const [t0, t2, cp, t3] = [TODO_TEMPLATE, TODO_T2_DONE, TODO_CP_DONE, TODO_T3_DONE].map(parseTasks)
    expect(completionToast(t0!, t2!)).toBe('♦ Checkpoint reached: After Tasks 1-2 · All tests pass · Review with human before proceeding')
    expect(completionToast(cp!, t3!)).toBe('✓ T3 done Issue and revoke keys · Next: T4 Rate limit per key')
    // Ticking the checkpoint's own boxes finishes no task.
    expect(completionToast(t2!, cp!)).toBe(undefined)
    expect(completionToast(t3!, cp!)).toBe(undefined)
    expect(completionToast(null, t3!)).toBe(undefined)
    // A new plan that reuses T1..Tn is not progress on the old one.
    expect(completionToast(t0!, parseTasks(PLAN_INDEX))).toBe(undefined)
    const all = TODO_T3_DONE.replace(/- \[ \]/g, '- [x]')
    expect(completionToast(t3!, parseTasks(all))).toBe('✓ T4 done Rate limit per key · all tasks done')
  })

  test('block chain follows undone dependencies (C1)', async () => {
    const list = parseTasks(
      '## Task 1: A\n- [x] a\n## Task 2: B\n- [ ] b\n## Task 3: C\n**Dependencies:** Task 2\n- [ ] c\n## Task 4: D\n**Dependencies:** Task 1, Task 3\n- [ ] d\n',
    )
    const t4 = list.tasks.find(t => t.id === 'T4')!
    expect(blockChain(list, t4)).toBe('T4 ← T3 ← T2')
  })

  test('progress brief: the facts the model answers from (C1)', async () => {
    const list = parseTasks(TODO_TEMPLATE)
    const brief = progressBrief({
      spec: parseSpec(SPEC),
      list,
      plan: parsePlan(PLAN_INDEX),
      listFile: 'tasks/todo.md',
      forecast: null,
    })!
    const lines = brief.split('\n').slice(2)
    expect(lines).toEqual([
      'SPEC.md: awaiting approval; Project structure empty, Code style missing; weak: Objective: no success criteria.',
      '- open question (SPEC.md): Should keys expire by default?',
      'tasks/todo.md: 1/4 tasks done.',
      '- current: T2 Prisma schema for keys (Phase 1: Foundation); open: Migration runs on a clean database; Tests pass: pnpm test keys',
      '- checkpoint after T2: After Tasks 1-2 (All tests pass; Review with human before proceeding)',
      '- blocked: T3 Issue and revoke keys, chain T3 ← T2',
      '- not started: T4 Rate limit per key',
      '- open question (tasks/plan.md): Upstash or self-hosted Redis?',
    ])
    expect(progressBrief({ spec: null, list: null, plan: null, listFile: null, forecast: null })).toBe(undefined)
  })

  test('the task a prompt is about (C1)', async () => {
    const list = parseTasks(TODO_TEMPLATE)
    expect(taskInPrompt('why is T3 blocked?', list)).toBe('T3')
    expect(taskInPrompt('what about task 4', list)).toBe('T4')
    expect(taskInPrompt("what's left before the checkpoint?", list)).toBe('T2')
    expect(taskInPrompt('where are we', list)).toBe('T2')
    expect(taskInPrompt('fix the lint errors', list)).toBe(null)
    expect(taskInPrompt('is T9 done', list)).toBe(null)
    expect(taskInPrompt('why is T3 blocked?', null)).toBe(null)
  })

  test('timeline rows: phases, glyphs and a checkpoint that needs you', async () => {
    const done12 = TODO_TEMPLATE.replace('- [ ] Migration', '- [x] Migration').replace('- [ ] Tests pass: `pnpm test keys`', '- [x] Tests pass: `pnpm test keys`')
    const rows = timelineRows(parseTasks(done12))
    const text = rows.map(r => (r.kind === 'task' ? `${r.glyph} ${r.id}` : r.kind === 'phase' ? `# ${r.text}` : `${r.glyph} ${r.text}`))
    expect(text).toEqual([
      '# Phase 1: Foundation',
      '✓ T1',
      '✓ T2',
      '♦ Checkpoint: After Tasks 1-2 (needs you)',
      '# Phase 2: Core',
      '● T3',
      '○ T4',
    ])
  })
})
