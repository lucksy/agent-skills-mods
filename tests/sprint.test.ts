import { describe, expect, test } from 'claude-code/testing'

import { diagnose } from '../packages/core/doctor'
import { parseBacklog, parseDeps, parsePlan, parseTasks, withBlockers } from '../packages/core/parse'
import { notReady, readiness, readyText } from '../packages/core/sprint'
import { TODO_TEMPLATE } from './fixtures'

// ceremonies T5: why a task isn't ready to start. Blocking reasons keep it out
// of a sprint proposal; a size and an owner are only recommended.

const TODO = `---
plan: gateway
---
# Tasks

## Task 1: Scaffold
**Status:** done · started 2026-10-01 · done 2026-10-02
**Size:** S
**Acceptance criteria:**
- [x] builds
**Verification:**
- [x] Tests pass

## Task 2: Keys
**Status:** in progress · @amila · started 2026-10-03
**Size:** M
**Acceptance criteria:**
- [ ] table
**Verification:**
- [ ] Tests pass

## Task 3: Rate limit
**Status:** todo · @bob
**Size:** M
**Acceptance criteria:**
- [ ] 429 after 60 req/min
**Verification:**
- [ ] Tests pass
**Dependencies:** T1

## Task 4: Quotas
**Status:** todo · @bob
**Acceptance criteria:**
- [ ] per tenant
**Dependencies:** T2

## Task 5: Audit log
**Status:** todo
**Size:** L
**Verification:**
- [ ] Tests pass

## Task 6: Export
**Status:** todo · @sara
**Size:** S
**Acceptance criteria:**
- [ ] CSV
**Verification:**
- [ ] Tests pass
**Dependencies:** B3

## Task 7: Review queue
**Status:** in review · @sara · started 2026-10-04
**Acceptance criteria:**
- [ ] queue
**Verification:**
- [ ] Tests pass

## Task 8: Docs
**Status:** todo · @amila
**Size:** S
**Acceptance criteria:**
- [ ] README
**Verification:**
- [ ] Tests pass
**Dependencies:** T9
`

const PLAN = `# Plan

## Open Questions

- Q1: Should T3 count bursts? The default is no.
  → A: No · @lucksy 2026-10-11
- Q2: Is T8 needed before launch?
`

const BACKLOG = `# Backlog

## B3: Per-tenant quotas
- [ ] Quota per tenant

## B4: Old docs
**Was:** T9 · deferred 2026-10-05 @amila
- [ ] docs
`

const list = parseTasks(TODO)
const plan = parsePlan(PLAN)
const backlog = parseBacklog(BACKLOG)
const task = (id: string) => list.tasks.find(t => t.id === id)!
const of = (id: string) => readiness(task(id), list, plan, backlog)

describe('readiness (T5)', () => {
  test('a task with boxes of both kinds, its dependencies done, a size and an owner is ready', () => {
    expect(of('T3')).toEqual({ blocking: [], recommended: [] })
  })

  test('an answered question no longer blocks the task it names', () => {
    expect(plan.openQuestions.some(q => q.startsWith('Q1'))).toBe(false)
    expect(of('T3').blocking).toEqual([])
  })

  test('no verification boxes, and a dependency not done, block', () => {
    expect(of('T4')).toEqual({ blocking: ['no verification', 'waits on T2'], recommended: ['no size'] })
  })

  test('no acceptance boxes blocks; no owner is recommended once the plan has owners', () => {
    expect(of('T5')).toEqual({ blocking: ['no acceptance'], recommended: ['no owner'] })
  })

  test('a dependency on a backlog item blocks, named by its B id', () => {
    expect(of('T6').blocking).toEqual(['waits on backlog B3'])
  })

  test('a dependency on a deferred task blocks, named by the backlog item it is now', () => {
    expect(of('T8').blocking).toEqual(['waits on Q2', 'waits on backlog B4'])
  })

  test('an open question naming the task blocks, by its number', () => {
    expect(readiness(task('T8'), list, parsePlan('## Open Questions\n- Should T8 wait?\n'), backlog).blocking[0]).toBe('waits on a question')
  })

  test('a question from the spec, put on the list by withBlockers, blocks too', () => {
    const blocked = withBlockers(list, [{ file: 'SPEC.md', text: 'Q4: Does T3 need a flag?' }])
    expect(readiness(blocked.tasks.find(t => t.id === 'T3')!, blocked, null, null).blocking).toEqual(['waits on Q4 in SPEC.md'])
  })

  test('a dependency missing from the list and the backlog blocks and says so', () => {
    expect(readiness(task('T8'), list, null, null).blocking).toEqual(['waits on T9 (not in the list)'])
  })

  test('without an owner anywhere in the plan, no owner is not a reason', () => {
    const solo = parseTasks(TODO_TEMPLATE)
    expect(readiness(solo.tasks.find(t => t.id === 'T4')!, solo, null, null)).toEqual({ blocking: ['no verification'], recommended: ['no size'] })
  })

  test('ids counted as done (committed to the sprint, or earlier in a proposal) no longer block', () => {
    expect(readiness(task('T4'), list, plan, backlog, new Set(['T2'])).blocking).toEqual(['no verification'])
  })

  test('a Dependencies line can name a backlog item; T ids are read as before', () => {
    expect(parseDeps('T1, B3 and Task 4')).toEqual(['T1', 'B3', 'T4'])
    expect(parseDeps('None')).toEqual([])
  })

  test('the doctor warns about a dependency on a backlog item rather than calling it missing', () => {
    const findings = diagnose({ todo: TODO, plan: null, specs: [], today: '2026-10-11', keepFormat: false })
    expect(findings.map(f => f.message)).toContain('T6 depends on B3 in the backlog: pull it before T6 can start')
    expect(findings.some(f => f.message.includes('B3, which is not in the list'))).toBe(false)
  })
})

describe('/progress ready (T5)', () => {
  test('done, in progress and in review tasks are never listed', () => {
    const ids = notReady(list, plan, backlog).map(r => r.task.id)
    expect(ids).toEqual(['T4', 'T5', 'T6', 'T8'])
  })

  test('a task with boxes ticked but no Status line is under way, so not listed', () => {
    const ids = notReady(parseTasks(TODO_TEMPLATE), null, null).map(r => r.task.id)
    expect(ids).toEqual(['T3', 'T4'])
  })

  test('the text: blocking reasons first, recommended after a dot; ✗ can\'t start, ○ can', () => {
    expect(readyText(list, plan, backlog)).toBe(
      [
        'Not ready · 4 of 5 tasks not yet started',
        '  ✗ T4  Quotas     no verification, waits on T2 · no size',
        '  ✗ T5  Audit log  no acceptance · no owner',
        '  ✗ T6  Export     waits on backlog B3',
        '  ✗ T8  Docs       waits on Q2, backlog B4',
        '✗ can\'t start yet · ○ can start; a size and an owner are recommended',
      ].join('\n'),
    )
  })

  test('a task missing only what is recommended is marked ○', () => {
    const text = readyText(parseTasks(TODO.replace('**Acceptance criteria:**\n- [ ] per tenant\n', '**Acceptance criteria:**\n- [ ] per tenant\n**Verification:**\n- [ ] ok\n').replace('**Dependencies:** T2\n', '')), plan, backlog)
    expect(text).toContain('  ○ T4  Quotas     no size\n')
  })

  test('every task ready, and no task list', () => {
    expect(readyText(parseTasks(TODO.split('## Task 4')[0]!), plan, backlog)).toBe('✓ every task is ready')
    expect(readyText(null, null, null)).toBe('No task list yet: readiness reads the tasks in tasks/todo.md.')
    expect(readyText(parseTasks('- [ ] a\n- [ ] b\n'), null, null)).toBe('No "## Task N:" sections in tasks/todo.md, so there is no readiness to check.')
  })
})
