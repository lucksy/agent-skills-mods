import { describe, expect, test } from 'claude-code/testing'

import { runAction, type ActionInput } from '../packages/core/actions'
import { parseSprint, setSprint } from '../packages/core/format'
import { readCopiesSince, type Runner } from '../packages/core/history'
import { parseTasks } from '../packages/core/parse'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'
import { endAfter, pastSprints, pickSprint, sprintBase, sprintLine, sprintNow, sprintReportText, sprintReview, sprintReviewText, sprintText, versionsOf, workingDays } from '../packages/core/sprint'
import { bandText } from '../packages/core/view'
import { gitOutput, TODO_TEMPLATE } from './fixtures'

// ceremonies T6 (C1, C5): starting a sprint, and the sprint now.

/** A task section: id, title, Status word, optional size. */
const task = (n: number, title: string, status = 'todo', size?: 'S' | 'M' | 'L') =>
  `## Task ${n}: ${title}\n**Status:** ${status}\n${size ? `**Size:** ${size}\n` : ''}- [${status.startsWith('done') ? 'x' : ' '}] ${title.toLowerCase()} works\n`

const FM = (extra = '') => `---\nplan: gateway\ncreated: 2026-10-01\n${extra}---\n# Tasks: gateway\n\n`
const SPRINT = 'sprint: 2026-10-12..2026-10-23\ncommit: T2, T3, T4\n'

/** Before the sprint: T9 still here (deferred before the start). */
const V_FRI = FM() + [task(1, 'Scaffold', 'done · done 2026-10-05'), task(2, 'Schema', 'todo', 'L'), task(3, 'Keys', 'todo', 'S'), task(4, 'Rate limit'), task(5, 'Docs'), task(9, 'Audit')].join('\n')
/** The sprint's first day: started, T9 deferred, T6 added before the start commit. */
const V_MON = FM(SPRINT) + [task(1, 'Scaffold', 'done · done 2026-10-05'), task(2, 'Schema', 'in progress · started 2026-10-12', 'L'), task(3, 'Keys', 'todo', 'S'), task(4, 'Rate limit'), task(5, 'Docs'), task(6, 'Metrics')].join('\n')
/** T2 done, T7 added after the start. */
const V_WED = V_MON.replace('in progress · started 2026-10-12', 'done · done 2026-10-14').replace('- [ ] schema works', '- [x] schema works') + '\n' + task(7, 'Alerts', 'done · done 2026-10-14')
/** T9 pulled back from the backlog after the start. */
const V_THU = V_WED + '\n' + task(9, 'Audit')
/** Now: T3 done too, not yet committed. */
const NOW_TEXT = V_THU.replace('## Task 3: Keys\n**Status:** todo', '## Task 3: Keys\n**Status:** done · done 2026-10-16').replace('- [ ] keys works', '- [x] keys works')
const TODAY = '2026-10-16'

const HISTORY = gitOutput([
  ['2026-10-15', V_THU],
  ['2026-10-14', V_WED],
  ['2026-10-12', V_MON],
  ['2026-10-09', V_FRI],
  ['2026-10-01', FM() + task(1, 'Scaffold')],
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

  test('before the sprint\'s commit, the last copy from before its first day is the base', () => {
    const versions = versionsOf([{ hash: 'a', day: '2026-10-09', text: V_FRI }])
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
function plan(sprint: string | null, rows: Row[], signed: string | null = null): string {
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
  ['2026-10-23', plan(B, [...done(R4, { 1: '2026-10-02', 2: '2026-10-07', 3: '2026-10-16', 4: '2026-10-23' }), { n: 5, title: 'Docs', done: '2026-10-09' }, { n: 6, title: 'Metrics' }, { n: 7, title: 'Alerts', done: '2026-10-23' }], '2026-10-07')],
  ['2026-10-16', plan(B, [...done(R4, { 1: '2026-10-02', 2: '2026-10-07', 3: '2026-10-16' }), { n: 5, title: 'Docs', done: '2026-10-09' }, { n: 6, title: 'Metrics' }], '2026-10-07')],
  ['2026-10-12', plan(B, [...done(R4, { 1: '2026-10-02', 2: '2026-10-07' }), { n: 5, title: 'Docs', done: '2026-10-09' }, { n: 6, title: 'Metrics' }], '2026-10-07')],
  ['2026-10-09', plan(A, [...done(R4, { 1: '2026-10-02', 2: '2026-10-07' }), { n: 5, title: 'Docs', done: '2026-10-09' }], '2026-10-07')],
  ['2026-10-07', plan(A, [...done(R4, { 1: '2026-10-02', 2: '2026-10-07' }), { n: 5, title: 'Docs' }], '2026-10-07')],
  ['2026-10-02', plan(A, [...done(R4, { 1: '2026-10-02' }), { n: 5, title: 'Docs' }])],
  ['2026-09-28', plan(A, R4)],
  ['2026-09-25', plan(null, R4)],
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
