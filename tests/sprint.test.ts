import { describe, expect, test } from 'claude-code/testing'

import { runAction, type ActionInput } from '../packages/core/actions'
import { parseSprint, setSprint } from '../packages/core/format'
import { readCopiesSince, type Runner } from '../packages/core/history'
import { parseTasks } from '../packages/core/parse'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'
import { endAfter, sprintBase, sprintLine, sprintNow, sprintText, versionsOf, workingDays } from '../packages/core/sprint'
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
