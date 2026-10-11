import { describe, expect, test } from 'claude-code/testing'

import { runAction, type ActionInput } from '../packages/core/actions'
import { diagnose } from '../packages/core/doctor'
import { parseSprint, setSprint } from '../packages/core/format'
import { readCopiesSince, type Runner } from '../packages/core/history'
import { parseBacklog, parseDeps, parsePlan, parseTasks, withBlockers } from '../packages/core/parse'
import { endAfter, notReady, pastSprints, pickSprint, readiness, readyText, sprintBase, sprintLine, sprintNow, sprintReportText, sprintReview, sprintReviewText, sprintText, versionsOf, workingDays } from '../packages/core/sprint'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'
import { bandText } from '../packages/core/view'
import { gitOutput, TODO_TEMPLATE } from './fixtures'
import { sprintPace, sprintPlan, sprintPlanText, workingDaysBack } from '../packages/core/sprint'
import type { Snapshot } from '../packages/core/forecast'

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

// ceremonies T6 (C1, C5): starting a sprint, and the sprint now.

/** A task section: id, title, Status word, optional size. */
const section = (n: number, title: string, status = 'todo', size?: 'S' | 'M' | 'L') =>
  `## Task ${n}: ${title}\n**Status:** ${status}\n${size ? `**Size:** ${size}\n` : ''}- [${status.startsWith('done') ? 'x' : ' '}] ${title.toLowerCase()} works\n`

const FM = (extra = '') => `---\nplan: gateway\ncreated: 2026-10-01\n${extra}---\n# Tasks: gateway\n\n`
const SPRINT = 'sprint: 2026-10-12..2026-10-23\ncommit: T2, T3, T4\n'

/** Before the sprint: T9 still here (deferred before the start). */
const V_FRI = FM() + [section(1, 'Scaffold', 'done · done 2026-10-05'), section(2, 'Schema', 'todo', 'L'), section(3, 'Keys', 'todo', 'S'), section(4, 'Rate limit'), section(5, 'Docs'), section(9, 'Audit')].join('\n')
/** The sprint's first day: started, T9 deferred, T6 added before the start commit. */
const V_MON = FM(SPRINT) + [section(1, 'Scaffold', 'done · done 2026-10-05'), section(2, 'Schema', 'in progress · started 2026-10-12', 'L'), section(3, 'Keys', 'todo', 'S'), section(4, 'Rate limit'), section(5, 'Docs'), section(6, 'Metrics')].join('\n')
/** T2 done, T7 added after the start. */
const V_WED = V_MON.replace('in progress · started 2026-10-12', 'done · done 2026-10-14').replace('- [ ] schema works', '- [x] schema works') + '\n' + section(7, 'Alerts', 'done · done 2026-10-14')
/** T9 pulled back from the backlog after the start. */
const V_THU = V_WED + '\n' + section(9, 'Audit')
/** Now: T3 done too, not yet committed. */
const NOW_TEXT = V_THU.replace('## Task 3: Keys\n**Status:** todo', '## Task 3: Keys\n**Status:** done · done 2026-10-16').replace('- [ ] keys works', '- [x] keys works')
const TODAY = '2026-10-16'

const HISTORY = gitOutput([
  ['2026-10-15', V_THU],
  ['2026-10-14', V_WED],
  ['2026-10-12', V_MON],
  ['2026-10-09', V_FRI],
  ['2026-10-01', FM() + section(1, 'Scaffold')],
])

/** A runner that answers as git would for HISTORY, recording each call's argv and input. */
function fakeGit(calls: { argv: string[]; stdin: string }[] = []): Runner {
  return async (argv, opts) => {
    calls.push({ argv, stdin: opts?.stdin ?? '' })
    if (argv[1] === 'log') return { exitCode: 0, stdout: HISTORY.log, stderr: '' }
    return { exitCode: 0, stdout: HISTORY.answer(argv, opts?.stdin ?? ''), stderr: '' }
  }
}

function input(todo: string, today = TODAY): ActionInput {
  return { todo, plan: null, spec: null, list: parseTasks(todo), today, team: null, email: null, pending: {}, keepFormat: true }
}

describe('the sprint lines (T6)', () => {
  test('sprint: and commit: parse into dates and ids; a malformed sprint line is no sprint', () => {
    expect(parseSprint({ sprint: '2026-10-12..2026-10-23', commit: 'T2, t3,T4 T2' })).toEqual({ start: '2026-10-12', end: '2026-10-23', commit: ['T2', 'T3', 'T4'] })
    expect(parseSprint({ sprint: '2026-10-12', commit: 'T2' })).toBeNull()
    expect(parseSprint({})).toBeNull()
    expect(parseTasks(V_MON).meta).toEqual({ plan: 'gateway', created: '2026-10-01', sprint: { start: '2026-10-12', end: '2026-10-23', commit: ['T2', 'T3', 'T4'] } })
    // No sprint, no key: a list reads exactly as before.
    expect(parseTasks(V_FRI).meta).toEqual({ plan: 'gateway', created: '2026-10-01' })
  })

  test('setSprint writes exactly the two lines, in place of a previous sprint, keeping every other byte', () => {
    const once = setSprint(V_FRI, { start: '2026-10-12', end: '2026-10-23', commit: ['T2', 'T3'] })
    expect(once).toBe(V_FRI.replace('created: 2026-10-01\n', 'created: 2026-10-01\nsprint: 2026-10-12..2026-10-23\ncommit: T2, T3\n'))
    const twice = setSprint(once, { start: '2026-10-26', end: '2026-11-06', commit: ['T5'] })
    expect(twice).toBe(V_FRI.replace('created: 2026-10-01\n', 'created: 2026-10-01\nsprint: 2026-10-26..2026-11-06\ncommit: T5\n'))
    // A list without front matter gets a block of just those two lines.
    expect(setSprint('## Task 1: A\n- [ ] a\n', { start: '2026-10-12', end: '2026-10-23', commit: ['T1'] })).toBe('---\nsprint: 2026-10-12..2026-10-23\ncommit: T1\n---\n## Task 1: A\n- [ ] a\n')
  })
})

describe('the sprint-start action (T6)', () => {
  test('writes sprint: today..end and commit:, and says the days and points', () => {
    const r = runAction('sprint-start', { end: '2026-10-23', ids: ['t2', '3', 'T4'] }, input(V_FRI, '2026-10-12'))
    expect(r.ok).toBe(true)
    expect(r.reply).toBe('Sprint started: 12 Oct – 23 Oct, 10 working days. Committed T2, T3, T4 (3½ points).')
    expect(r.writes).toEqual([{ file: 'tasks/todo.md', text: V_FRI.replace('created: 2026-10-01\n', `created: 2026-10-01\n${SPRINT}`) }])
  })

  test('a new sprint replaces the old one and says so', () => {
    const r = runAction('sprint-start', { end: '2026-11-06', ids: ['T5'] }, input(V_THU, '2026-10-26'))
    expect(r.reply).toBe('Sprint started: 26 Oct – 6 Nov, 10 working days. Committed T5 (1 point). It replaces the sprint of 12 Oct – 23 Oct.')
    expect(r.writes[0]!.text).toBe(V_THU.replace(SPRINT, 'sprint: 2026-10-26..2026-11-06\ncommit: T5\n'))
  })

  test('refuses an end before today, a bad date, no tasks, an unknown task and a done one; writes nothing', () => {
    const refused = (args: Record<string, unknown>) => {
      const r = runAction('sprint-start', args, input(V_FRI, '2026-10-12'))
      expect(r.ok).toBe(false)
      expect(r.writes).toEqual([])
      return r.reply
    }
    expect(refused({ end: '2026-10-09', ids: ['T2'] })).toBe('2026-10-09 is before today (2026-10-12): a sprint starts today and ends on or after it.')
    expect(refused({ end: '2026-02-30', ids: ['T2'] })).toBe('"2026-02-30" is not a date. Say when the sprint ends as YYYY-MM-DD: /progress sprint start 2026-10-12 T4 T5.')
    expect(refused({ end: '2026-10-23', ids: [] })).toBe('Say which tasks it commits to: /progress sprint start 2026-10-23 T4 T5 T7.')
    expect(refused({ end: '2026-10-23', ids: ['T2', 'T12'] })).toBe('No "## Task 12:" section in tasks/todo.md. Tasks: T1, T2, T3, T4, T5, T9.')
    expect(refused({ end: '2026-10-23', ids: ['T1', 'T2'] })).toBe('T1 Scaffold is done already: a sprint commits to work still to do.')
    expect(refused({ ids: ['T2'] })).toBe('Say when it ends and what it commits to: /progress sprint start 2026-10-24 T4 T5 T7.')
  })

  test('an end date today is a one-day sprint', () => {
    expect(runAction('sprint-start', { end: '2026-10-12', ids: ['T2'] }, input(V_FRI, '2026-10-12')).reply).toBe('Sprint started: 12 Oct – 12 Oct, 1 working day. Committed T2 (2 points).')
  })
})

describe('working days (T6)', () => {
  test('Mon–Fri, both ends included, no holidays', () => {
    expect(workingDays('2026-10-12', '2026-10-23')).toBe(10)
    expect(workingDays('2026-10-16', '2026-10-23')).toBe(6)
    expect(workingDays('2026-10-17', '2026-10-18')).toBe(0)
    expect(workingDays('2026-10-23', '2026-10-12')).toBe(0)
    expect(endAfter('2026-10-12', 10)).toBe('2026-10-23')
    expect(endAfter('2026-10-17', 1)).toBe('2026-10-19')
  })
})

describe('the sprint now (T6)', () => {
  test('reads only the copies since the start, and the last one before it; a second read uses the cache', async () => {
    const calls: { argv: string[]; stdin: string }[] = []
    const cache = new Map<string, string | null>()
    const copies = await readCopiesSince(fakeGit(calls), 'tasks/todo.md', { since: '2026-10-12', cache })
    expect(copies.map(c => c.day)).toEqual(['2026-10-15', '2026-10-14', '2026-10-12', '2026-10-09'])
    // The copy from 1 Oct was never asked for.
    expect(calls.some(c => c.stdin.includes(`${'4'.padStart(40, 'a')}:`))).toBe(false)
    const before = calls.length
    expect((await readCopiesSince(fakeGit(calls), 'tasks/todo.md', { since: '2026-10-12', cache })).length).toBe(4)
    expect(calls.slice(before).map(c => c.argv[1])).toEqual(['log'])
  })

  test('scope added: a task added after the start and one pulled after it count; one added before does not', async () => {
    const versions = versionsOf(await readCopiesSince(fakeGit(), 'tasks/todo.md', { since: '2026-10-12' }))
    expect(sprintBase(versions, parseTasks(NOW_TEXT).meta!.sprint!)?.day).toBe('2026-10-12')
    const now = sprintNow(parseTasks(NOW_TEXT), versions, TODAY)!
    expect(now).toEqual({
      start: '2026-10-12',
      end: '2026-10-23',
      commit: ['T2', 'T3', 'T4'],
      phase: 'running',
      days: 10,
      daysLeft: 6,
      committed: { ids: ['T2', 'T3', 'T4'], done: ['T2', 'T3'], points: 3.5, donePoints: 2.5 },
      gone: [],
      added: { ids: ['T7', 'T9'], done: ['T7'] },
    })
    expect(sprintLine(now)).toBe('sprint · 6d left · 2/3 committed · +2')
  })

  test('a task pulled the same day the sprint started, in a later commit, counts as added', async () => {
    // Real-session check: `sprint start` and a pull, committed an hour apart on the first day.
    const PULLED = V_MON + '\n' + section(8, 'Alerting', 'todo', 'S')
    const SAME_DAY = gitOutput([['2026-10-12T15:00', PULLED], ['2026-10-12T14:00', V_MON], ['2026-10-09', V_FRI]])
    const run: Runner = async (argv, opts) => ({ exitCode: 0, stdout: argv[1] === 'log' ? SAME_DAY.log : SAME_DAY.answer(argv, opts?.stdin ?? ''), stderr: '' })
    const versions = versionsOf(await readCopiesSince(run, 'tasks/todo.md', { since: '2026-10-12' }))
    expect(versions.map(v => v.list.tasks.length)).toEqual([6, 6, 7])
    const now = sprintNow(parseTasks(PULLED), versions, '2026-10-12')!
    expect(now.added.ids).toEqual(['T8'])
    expect(sprintLine(now)).toBe('sprint · 10d left · 0/3 committed · +1')
  })

  test('before the sprint\'s commit, the last copy from before its first day is the base', () => {
    const versions = versionsOf([{ hash: 'a', day: '2026-10-09', ms: Date.parse('2026-10-09T12:00:00Z'), text: V_FRI }])
    // Started today and not committed yet: T6 was added since Friday's copy.
    const now = sprintNow(parseTasks(V_MON), versions, '2026-10-12')!
    expect(now.added.ids).toEqual(['T6'])
    expect(sprintLine(now)).toBe('sprint · 10d left · 0/3 committed · +1')
  })

  test('without git history nothing counts as added; a deferred committed task is gone, not open', () => {
    const now = sprintNow(parseTasks(V_THU.replace('commit: T2, T3, T4', 'commit: T2, T3, T4, T8')), [], TODAY)!
    expect(now.added.ids).toEqual([])
    expect(now.gone).toEqual(['T8'])
    expect(now.committed.ids).toEqual(['T2', 'T3', 'T4'])
  })

  test('after the end date the line reads `sprint ended <date>`; with no sprint there is none', () => {
    const ended = sprintNow(parseTasks(NOW_TEXT), [], '2026-10-24')!
    expect(ended.phase).toBe('ended')
    expect(ended.daysLeft).toBe(0)
    expect(sprintLine(ended)).toBe('sprint ended 23 Oct')
    expect(sprintNow(parseTasks(V_FRI), [], TODAY)).toBeNull()
    expect(sprintNow(parseTasks(TODO_TEMPLATE), [], TODAY)).toBeNull()
  })

  test('the full view: dates and days left, committed against done in tasks and points, each task, and what was added', async () => {
    const versions = versionsOf(await readCopiesSince(fakeGit(), 'tasks/todo.md', { since: '2026-10-12' }))
    const list = parseTasks(NOW_TEXT)
    expect(sprintText(sprintNow(list, versions, TODAY), list, TODAY).split('\n')).toEqual([
      'Sprint · 12 Oct – 23 Oct · 6 of 10 working days left',
      'Committed: 2 of 3 done · 2½ of 3½ points',
      '  ✓ T2 Schema (L)',
      '  ✓ T3 Keys (S)',
      '  ○ T4 Rate limit',
      'Added since the start: +2, 1 done',
      '  ✓ T7 Alerts',
      '  ○ T9 Audit',
    ])
    expect(sprintText(null, parseTasks(V_FRI), '2026-10-12')).toBe('No sprint running. To start one that ends in two weeks: /progress sprint start 2026-10-23 T2 T3 T4')
  })

  test('the band ends with the sprint line; without a sprint it is as before', () => {
    const list = parseTasks(NOW_TEXT)
    const now = sprintNow(list, [], TODAY)
    expect(bandText(list, now)).toBe('● T4 Rate limit · 1 criterion left · 4/8 done · sprint · 6d left · 2/3 committed')
    expect(bandText(list)).toBe('● T4 Rate limit · 1 criterion left · 4/8 done')
  })
})

describe('the sprint in State v1 (T6)', () => {
  const io = (files: Record<string, string>, run?: Runner): ProjectIo => ({
    cwd: '/p',
    now: Date.parse(`${TODAY}T10:00:00Z`),
    read: async rel => files[rel] ?? null,
    list: async rel => Object.keys(files).filter(f => !f.slice(rel ? rel.length + 1 : 0).includes('/') && f.startsWith(rel)).map(f => f.slice(rel ? rel.length + 1 : 0)),
    run,
  })

  test('--json has the sprint with its scope added from git, and no sprint key without one', async () => {
    const json = stateJson(await buildState(io({ 'tasks/todo.md': NOW_TEXT }, fakeGit())))
    expect(json.sprint?.added.ids).toEqual(['T7', 'T9'])
    expect(json.sprint?.committed).toEqual({ ids: ['T2', 'T3', 'T4'], done: ['T2', 'T3'], points: 3.5, donePoints: 2.5 })
    expect('sprint' in stateJson(await buildState(io({ 'tasks/todo.md': V_FRI }, fakeGit())))).toBe(false)
  })
})

// ceremonies T8 (C5): past sprints from tasks/todo.md's history, and the sprint review.

type Row = { n: number; title: string; done?: string; size?: 'S' | 'M' | 'L' }
/** A plan as committed: its sprint lines, its tasks (done ones ticked, with a verification box) and a checkpoint after T2. */
function committedPlan(sprint: string | null, rows: Row[], signed: string | null = null): string {
  const tasks = rows.map(r => {
    const x = r.done ? 'x' : ' '
    const section = `## Task ${r.n}: ${r.title}\n**Status:** ${r.done ? `done · done ${r.done}` : 'todo'}\n${r.size ? `**Size:** ${r.size}\n` : ''}\n**Acceptance criteria:**\n- [${x}] ${r.title} works\n\n**Verification:**\n- [${x}] Tests pass\n`
    return r.n === 2 ? `${section}\n## Checkpoint: After T2\n${signed ? `**Signed off:** @amila ${signed}\n` : ''}- [${signed ? 'x' : ' '}] Review with human\n` : section
  })
  return `---\nplan: gateway\n${sprint ?? ''}---\n# Tasks: gateway\n\n${tasks.join('\n')}`
}
const A = 'sprint: 2026-09-28..2026-10-09\ncommit: T1, T2, T3\n'
const B = 'sprint: 2026-10-12..2026-10-23\ncommit: T3, T4, T6\n'
const R4: Row[] = [{ n: 1, title: 'Scaffold', size: 'S' }, { n: 2, title: 'Schema', size: 'L' }, { n: 3, title: 'Keys' }, { n: 4, title: 'Rate limit' }]
const done = (rows: Row[], ids: Record<number, string>) => rows.map(r => (ids[r.n] ? { ...r, done: ids[r.n] } : r))
const TWO_SPRINTS: [string, string][] = [
  ['2026-10-23', committedPlan(B, [...done(R4, { 1: '2026-10-02', 2: '2026-10-07', 3: '2026-10-16', 4: '2026-10-23' }), { n: 5, title: 'Docs', done: '2026-10-09' }, { n: 6, title: 'Metrics' }, { n: 7, title: 'Alerts', done: '2026-10-23' }], '2026-10-07')],
  ['2026-10-16', committedPlan(B, [...done(R4, { 1: '2026-10-02', 2: '2026-10-07', 3: '2026-10-16' }), { n: 5, title: 'Docs', done: '2026-10-09' }, { n: 6, title: 'Metrics' }], '2026-10-07')],
  ['2026-10-12', committedPlan(B, [...done(R4, { 1: '2026-10-02', 2: '2026-10-07' }), { n: 5, title: 'Docs', done: '2026-10-09' }, { n: 6, title: 'Metrics' }], '2026-10-07')],
  ['2026-10-09', committedPlan(A, [...done(R4, { 1: '2026-10-02', 2: '2026-10-07' }), { n: 5, title: 'Docs', done: '2026-10-09' }], '2026-10-07')],
  ['2026-10-07', committedPlan(A, [...done(R4, { 1: '2026-10-02', 2: '2026-10-07' }), { n: 5, title: 'Docs' }], '2026-10-07')],
  ['2026-10-02', committedPlan(A, [...done(R4, { 1: '2026-10-02' }), { n: 5, title: 'Docs' }])],
  ['2026-09-28', committedPlan(A, R4)],
  ['2026-09-25', committedPlan(null, R4)],
]
const PAST = gitOutput(TWO_SPRINTS)
const pastGit: Runner = async (argv, opts) => ({ exitCode: 0, stdout: argv[1] === 'log' ? PAST.log : PAST.answer(argv, opts?.stdin ?? ''), stderr: '' })
const LATER = '2026-10-26'

describe('past sprints and the review (T8)', () => {
  const read = async () => versionsOf(await readCopiesSince(pastGit, 'tasks/todo.md'))
  const current = parseTasks(TWO_SPRINTS[0]![1])

  test('both sprints are rebuilt from the history, oldest first, with nothing written', async () => {
    const calls: { argv: string[]; stdin: string }[] = []
    const versions = versionsOf(await readCopiesSince(async (argv, opts) => (calls.push({ argv, stdin: opts?.stdin ?? '' }), pastGit(argv, opts)), 'tasks/todo.md'))
    expect(pastSprints(versions, current)).toEqual([
      { start: '2026-09-28', end: '2026-10-09', commit: ['T1', 'T2', 'T3'] },
      { start: '2026-10-12', end: '2026-10-23', commit: ['T3', 'T4', 'T6'] },
    ])
    // Only reads: one log, then cat-file.
    expect(calls.map(c => c.argv.slice(0, 2).join(' '))).toEqual(['git log', 'git cat-file', 'git cat-file'])
  })

  test('the first sprint: committed against done on its end date, added, carry over and the demo checklist', async () => {
    const r = sprintReview(pastSprints(await read(), current)[0]!, current, await read(), LATER)
    expect([r.phase, r.committed.ids, r.committed.done, r.committed.points, r.committed.donePoints]).toEqual(['ended', ['T1', 'T2', 'T3'], ['T1', 'T2'], 3.5, 2.5])
    expect(r.added).toEqual({ ids: ['T5'], done: ['T5'] })
    expect(r.carryOver).toEqual(['T3'])
    expect(r.demo).toEqual([
      { id: 'T1', title: 'Scaffold', boxes: ['Scaffold works'] },
      { id: 'T2', title: 'Schema', boxes: ['Schema works'] },
      { id: 'T5', title: 'Docs', boxes: ['Docs works'] },
    ])
    expect(r.checkpoints).toEqual([{ title: 'After T2', day: '2026-10-07' }])
  })

  test('the second sprint: a task added at its start is not scope added; one added later is; the checkpoint was signed before it', async () => {
    const r = sprintReview(pastSprints(await read(), current)[1]!, current, await read(), LATER)
    expect([r.committed.done, r.added.ids, r.added.done, r.carryOver, r.checkpoints]).toEqual([['T3', 'T4'], ['T7'], ['T7'], ['T6'], []])
    expect(r.demo.map(d => d.id)).toEqual(['T3', 'T4', 'T7'])
    expect(sprintReviewText(r).split('\n')).toEqual([
      'Sprint review · 12 Oct – 23 Oct · ended 23 Oct',
      '2 of 3 committed done (2 of 3 points) · +1 added · 1 carries over',
      'Done',
      '  ✓ T3 Keys',
      '  ✓ T4 Rate limit',
      '  ✓ T7 Alerts (added)',
      'Carries over',
      '  ○ T6 Metrics',
      'Demo checklist',
      '  - [ ] T3 Keys: Keys works',
      '  - [ ] T4 Rate limit: Rate limit works',
      '  - [ ] T7 Alerts: Alerts works',
    ])
  })

  test('a running sprint reviews so far: what is open is not carried over yet', async () => {
    const versions = await read()
    const r = sprintReview(current.meta!.sprint!, current, versions, '2026-10-20')
    // A running sprint is read from the plan as it is now.
    expect([r.phase, r.carryOver, r.committed.done]).toEqual(['running', ['T6'], ['T3', 'T4']])
    expect(sprintReviewText(r).split('\n').slice(0, 2)).toEqual(['Sprint review so far · 12 Oct – 23 Oct · 4 of 10 working days left', '2 of 3 committed done (2 of 3 points) · +1 added · 1 still open'])
  })

  test('picking a sprint by a day in it; the last ended one by default', async () => {
    const versions = await read()
    expect(pickSprint(versions, current, '2026-10-01', LATER)?.start).toBe('2026-09-28')
    expect(pickSprint(versions, current, '2026-10-12', LATER)?.start).toBe('2026-10-12')
    expect(pickSprint(versions, current, null, LATER)?.start).toBe('2026-10-12')
    expect(pickSprint(versions, current, '2026-11-02', LATER)).toBeNull()
    expect(pickSprint([], parseTasks(TODO_TEMPLATE), null, LATER)).toBeNull()
  })
})

describe('the review in replies (T8)', () => {
  const read = async () => versionsOf(await readCopiesSince(pastGit, 'tasks/todo.md'))
  const current = parseTasks(TWO_SPRINTS[0]![1])

  test('/progress report sprint: the last ended sprint, one picked by a day, or why there is none', async () => {
    const versions = await read()
    expect(sprintReportText(versions, current, null, LATER).split('\n')[0]).toBe('Sprint review · 12 Oct – 23 Oct · ended 23 Oct')
    expect(sprintReportText(versions, current, '2026-10-01', LATER).split('\n')).toEqual([
      'Sprint review · 28 Sep – 9 Oct · ended 9 Oct',
      '2 of 3 committed done (2½ of 3½ points) · +1 added · 1 carries over',
      'Done',
      '  ✓ T1 Scaffold (S)',
      '  ✓ T2 Schema (L)',
      '  ✓ T5 Docs (added)',
      'Carries over',
      '  ○ T3 Keys',
      'Demo checklist',
      '  - [ ] T1 Scaffold: Scaffold works',
      '  - [ ] T2 Schema: Schema works',
      '  - [ ] T5 Docs: Docs works',
      '  - [ ] Checkpoint "After T2" (signed off 7 Oct)',
    ])
    expect(sprintReportText(versions, current, '2026-11-02', LATER)).toBe('No sprint ran on 2026-11-02. Sprints: 28 Sep – 9 Oct, 12 Oct – 23 Oct.')
    expect(sprintReportText([], parseTasks(TODO_TEMPLATE), null, LATER)).toBe('No sprint to review: tasks/todo.md has never had a sprint. /progress sprint start <end> T4 T5 starts one.')
  })

  test('once the sprint has ended, /progress sprint and --sprint show its review and how to start the next', async () => {
    const versions = await read()
    const r = sprintReview(current.meta!.sprint!, current, versions, LATER)
    const text = sprintText(sprintNow(current, versions, LATER), current, LATER, r)
    expect(text.startsWith('Sprint review · 12 Oct – 23 Oct · ended 23 Oct\n')).toBe(true)
    expect(text.endsWith('\n\nThe sprint has ended. To start the next, for two weeks: /progress sprint start 2026-11-06 T6')).toBe(true)
  })
})

// ceremonies T7 (C1): the sprint plan, against the pace of the last 10 working days.

/** A plan task with acceptance and verification boxes (`verify: false` leaves the second out). */
const planTask = (n: number, title: string, opts: { status?: string; size?: 'S' | 'M' | 'L'; deps?: string; verify?: boolean } = {}) =>
  [
    `## Task ${n}: ${title}`,
    `**Status:** ${opts.status ?? 'todo'}`,
    ...(opts.size ? [`**Size:** ${opts.size}`] : []),
    '**Acceptance criteria:**',
    `- [${opts.status?.startsWith('done') ? 'x' : ' '}] ${title.toLowerCase()} works`,
    ...(opts.verify === false ? [] : ['**Verification:**', `- [${opts.status?.startsWith('done') ? 'x' : ' '}] Tests pass`]),
    ...(opts.deps ? [`**Dependencies:** ${opts.deps}`] : []),
    '',
  ].join('\n')

const PLAN_TODO =
  FM() +
  [
    planTask(1, 'Scaffold', { status: 'done · done 2026-10-02', size: 'S' }),
    planTask(2, 'Keys', { status: 'in progress · started 2026-10-08', size: 'M' }),
    planTask(3, 'Rate limit', { size: 'L', deps: 'T4' }),
    planTask(4, 'Schema', { size: 'M' }),
    planTask(5, 'Quotas', { size: 'M', deps: 'T6' }),
    planTask(6, 'Audit', { size: 'S', verify: false }),
    planTask(7, 'Export'),
    planTask(8, 'Alerts', { size: 'L' }),
    planTask(9, 'Docs', { size: 'M' }),
  ].join('\n')
const PLAN_DAY = '2026-10-12' // a Monday

/**
 * Hand-checked: 10 working days before Mon 12 Oct is Mon 28 Sep, so the pace runs
 * from the 28 Sep snapshot (21 Sep is older). Usual: 13 − 2 = 11 points over 10
 * working days = 1.1/day. Last 5 working days (from Mon 5 Oct): 13 − 8 = 5 over 5
 * = 1.0/day. Slow: max(min(1.1, 1.0), 0.44) × 0.7 = 0.7/day. Over 5 days the
 * capacity is 3½ (0.7 × 5) to 5½ (1.1 × 5) points; over 10, 7 to 11.
 */
const PACED: Snapshot[] = [
  { day: '2026-09-21', done: 0, total: 12, points: 0, totalPoints: 15 },
  { day: '2026-09-28', done: 2, total: 12, points: 2, totalPoints: 15 },
  { day: '2026-10-05', done: 6, total: 12, points: 8, totalPoints: 15 },
  { day: '2026-10-12', done: 9, total: 12, points: 13, totalPoints: 15 },
]

const parts = (snapshots: Snapshot[], todo = PLAN_TODO) => ({ list: parseTasks(todo), plan: null, backlog: null, snapshots, today: PLAN_DAY })

describe('the pace a sprint is planned against (T7)', () => {
  test('working days back skip weekends', () => {
    expect(workingDaysBack('2026-10-12', 10)).toBe('2026-09-28')
    expect(workingDaysBack('2026-10-12', 1)).toBe('2026-10-09')
    expect(workingDaysBack('2026-10-11', 5)).toBe('2026-10-05')
  })

  test('in points over the last 10 working days, the slow case from the last 5', () => {
    const pace = sprintPace(PACED, PLAN_DAY)
    expect(pace.kind === 'pace' && { unit: pace.unit, usual: pace.usual.toFixed(2), slow: pace.slow.toFixed(2), days: pace.days }).toEqual({ unit: 'points', usual: '1.10', slow: '0.70', days: 10 })
  })

  test('in tasks when only the newest snapshot has points; in points when the newest run alone says a pace', () => {
    // Points on 12 Oct only: 9 − 2 = 7 tasks over 10 days = 0.7; last 5 days 3 over 5 = 0.6; slow 0.6 × 0.7 = 0.42.
    const late = PACED.map(s => (s.day === '2026-10-12' ? s : { day: s.day, done: s.done, total: s.total }))
    const tasks = sprintPace(late, PLAN_DAY)
    expect(tasks.kind === 'pace' && [tasks.unit, tasks.usual.toFixed(2), tasks.slow.toFixed(2)]).toEqual(['tasks', '0.70', '0.42'])
    // Points from 5 Oct: 3 tasks done since, 13 − 8 = 5 points over 5 days = 1.0; slow 0.7.
    const run = PACED.map(s => (s.day >= '2026-10-05' ? s : { day: s.day, done: s.done, total: s.total }))
    const points = sprintPace(run, PLAN_DAY)
    expect(points.kind === 'pace' && [points.unit, points.usual.toFixed(2), points.slow.toFixed(2), points.days]).toEqual(['points', '1.00', '0.70', 5])
  })

  test('under 3 tasks done in the window, or under 2 working days, there is no pace', () => {
    expect(sprintPace([PACED[1]!, { ...PACED[3]!, done: 4 }], PLAN_DAY)).toEqual({ kind: 'none', reason: '2 of 3 tasks done in the last 10 working days' })
    expect(sprintPace([{ ...PACED[3]!, day: '2026-10-09', done: 0 }, PACED[3]!], PLAN_DAY)).toEqual({ kind: 'none', reason: 'under 2 working days of history' })
    expect(sprintPace([], PLAN_DAY)).toEqual({ kind: 'none', reason: 'no history yet' })
  })
})

describe('the sprint plan (T7)', () => {
  test('under way first, then ready tasks in dependency order; the slow case fills, then the usual case, then it stops', () => {
    // T2 1 → 1, T4 1 → 2 (both within 3½), T3 2 → 4 and T7 1 → 5 (within 5½ only), T8 2 → 7 is past 5½.
    const plan = sprintPlan(parts(PACED), 5)!
    expect(plan.capacity).toEqual({ slow: 3.5, usual: 5.5 })
    expect(plan.proposed.map(r => [r.task.id, r.points, r.running, r.fit])).toEqual([
      ['T2', 1, 1, 'slow'],
      ['T4', 1, 2, 'slow'],
      ['T3', 2, 4, 'usual'],
      ['T7', 1, 5, 'usual'],
    ])
    expect(plan.over.map(t => t.id)).toEqual(['T8', 'T9'])
    expect(plan.end).toBe('2026-10-16')
  })

  test('a task whose dependency is proposed earlier is proposed; one whose dependency is not ready is not', () => {
    const plan = sprintPlan(parts(PACED), 10)!
    expect(plan.proposed.map(r => r.task.id)).toEqual(['T2', 'T4', 'T3', 'T7', 'T8', 'T9'])
    expect(plan.notReady.map(r => [r.task.id, r.reasons])).toEqual([
      ['T5', ['waits on T6']],
      ['T6', ['no verification']],
    ])
  })

  test('a dependency committed to a sprint that has not ended counts as met', () => {
    const todo = PLAN_TODO.replace('created: 2026-10-01\n', 'created: 2026-10-01\nsprint: 2026-10-05..2026-10-16\ncommit: T6\n')
    const list = parseTasks(todo)
    const plan = sprintPlan({ ...parts(PACED, todo), sprint: sprintNow(list, [], PLAN_DAY) }, 10)!
    expect(plan.notReady.map(r => r.task.id)).toEqual(['T6'])
    expect(plan.proposed.map(r => r.task.id)).toContain('T5')
  })

  test('the text: capacity and pace, a row per task with its running total, past capacity, not ready, the start line', () => {
    expect(sprintPlanText(sprintPlan(parts(PACED), 5), parseTasks(PLAN_TODO)).split('\n')).toEqual([
      'Sprint plan · 5 working days · capacity ≈ 3½–5½ points (pace 1.1/day, slow case 0.7)',
      '  T2  Keys        M  1  running 1  in progress',
      '  T4  Schema      M  1  running 2',
      '  T3  Rate limit  L  2  running 4  usual case only',
      '  T7  Export      -  1  running 5  usual case only',
      '  - no size: counts as 1 point',
      'Ready, past capacity: T8, T9',
      'Not ready:',
      '  ✗ T5  Quotas      waits on T6',
      '  ✗ T6  Audit       no verification',
      'To start it: /progress sprint start 2026-10-16 T2 T4 T3 T7',
    ])
  })

  test('with under 3 tasks done it says so and proposes every ready task by count', () => {
    const plan = sprintPlan(parts([PACED[1]!, { ...PACED[3]!, done: 4 }]), 10)!
    expect(plan.capacity).toBeNull()
    const text = sprintPlanText(plan, parseTasks(PLAN_TODO)).split('\n')
    expect(text[0]).toBe('Sprint plan · 10 working days · no pace yet (2 of 3 tasks done in the last 10 working days), so by count: every ready task, keep what fits')
    expect(text.at(-1)).toBe('To start it: /progress sprint start 2026-10-23 T2 T4 T3 T7 T8 T9')
  })

  test('a running sprint is named; nothing ready, everything done and no task list each say so', () => {
    const todo = PLAN_TODO.replace('created: 2026-10-01\n', 'created: 2026-10-01\nsprint: 2026-10-05..2026-10-16\ncommit: T2\n')
    const list = parseTasks(todo)
    const sprint = sprintNow(list, [], PLAN_DAY)
    expect(sprintPlanText(sprintPlan({ ...parts(PACED, todo), sprint }, 10), list, sprint).split('\n')[1]).toBe("The sprint to 16 Oct hasn't ended: starting this one replaces it.")
    const stuck = FM() + planTask(1, 'Audit', { verify: false })
    expect(sprintPlanText(sprintPlan(parts(PACED, stuck), 10), parseTasks(stuck)).split('\n').slice(1)).toEqual(['Nothing is ready to propose.', 'Not ready:', '  ✗ T1  Audit  no verification'])
    const done = FM() + planTask(1, 'Scaffold', { status: 'done · done 2026-10-02' })
    expect(sprintPlanText(sprintPlan(parts(PACED, done), 10), parseTasks(done))).toBe('Every task is done: there is nothing left to plan.')
    expect(sprintPlanText(null, null)).toBe('No task list yet: a sprint plan reads the tasks in tasks/todo.md.')
  })

  test('State v1 is a plan input as it is', async () => {
    const state = await buildState({ cwd: '/p', now: Date.parse(`${PLAN_DAY}T10:00:00Z`), read: async rel => (rel === 'tasks/todo.md' ? PLAN_TODO : null), list: async () => [] })
    expect(sprintPlan(state, 10)?.pace.kind).toBe('none')
  })
})
