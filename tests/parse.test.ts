import { describe, expect, test } from 'claude-code/testing'

import { parsePlan, parseSpec, parseTasks } from '../hooks/lib/parse'
import { checkOverwrite } from '../hooks/lib/guard'
import { forecast, record, type Snapshot } from '../hooks/lib/forecast'
import { bandText, forecastText, nextText, statusText, timelineRows } from '../hooks/lib/view'
import { CHECKLIST, PLAN_INDEX, SPEC, TODO_TEMPLATE } from './fixtures'

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
      expect(forecastText(f)).toMatch(/slow case/)
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
