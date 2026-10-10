import { describe, expect, test } from 'claude-code/testing'

import { parseStatusLine, setOwner, stampTodo, statusLine, taskStates, tickTask } from '../packages/core/format'
import { parseTasks } from '../packages/core/parse'
import { bandText, boardRows, taskDetail, timelineRows } from '../packages/core/view'
import { plain, timeline } from '../packages/core/timeline'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'
import { TODO_TEMPLATE } from './fixtures'

// Progress format v2, T1: a Status line carries an owner, in review, a PR and a
// reviewer, and every way the plugin rewrites the line keeps them.

const V2 = '**Status:** in review · @amila · started 2026-10-07 · PR #42 · reviewer @bob'
/** T2 of the template with a v2 Status line under its heading. */
const withLine = (line: string, todo = TODO_TEMPLATE) => todo.replace('## Task 2: Prisma schema for keys\n', `## Task 2: Prisma schema for keys\n${line}\n`)

describe('Status line v2 (T1)', () => {
  test('owner, in review, PR and reviewer parse, and write back the same', () => {
    expect(parseStatusLine(V2)).toEqual({ status: 'in review', owner: '@amila', started: '2026-10-07', pr: '#42', reviewer: '@bob' })
    expect(statusLine(parseStatusLine(V2)!)).toBe(V2)
  })

  test('case and URLs are kept as written; tokens may come in any order', () => {
    const line = '**Status:** in progress · started 2026-10-07 · reviewer @Bob · step test · @Sara-K · PR https://github.com/acme/api/pull/42'
    expect(parseStatusLine(line)).toEqual({ status: 'in progress', owner: '@Sara-K', started: '2026-10-07', step: 'test', pr: 'https://github.com/acme/api/pull/42', reviewer: '@Bob' })
    expect(statusLine(parseStatusLine(line)!)).toBe('**Status:** in progress · @Sara-K · started 2026-10-07 · step test · PR https://github.com/acme/api/pull/42 · reviewer @Bob')
  })

  test('v1 lines parse and write as before', () => {
    for (const line of ['**Status:** todo', '**Status:** in progress · started 2026-10-09 · step test', '**Status:** done · started 2026-10-01 · done 2026-10-03', '**Status:** blocked']) {
      expect(statusLine(parseStatusLine(line)!)).toBe(line)
    }
    expect(parseStatusLine('**Status:** in progress · started 2026-10-09')).toEqual({ status: 'in progress', started: '2026-10-09' })
  })

  test('stamping keeps them: a step change, a new box ticked, the last box ticked', () => {
    const owned = withLine('**Status:** in progress · @amila · started 2026-10-07 · PR #42 · reviewer @bob')
    // The plugin's own step update.
    const stepped = stampTodo(owned, '2026-10-09', { changes: { T2: { status: 'in progress', step: 'test' } } })
    expect(taskStates(stepped).T2).toEqual({ status: 'in progress', owner: '@amila', started: '2026-10-07', step: 'test', pr: '#42', reviewer: '@bob' })
    // Every box ticked: done, still owned.
    const done = stampTodo(tickTask(owned, 'T2'), '2026-10-09')
    expect(taskStates(done).T2).toEqual({ status: 'done', owner: '@amila', started: '2026-10-07', done: '2026-10-09', pr: '#42', reviewer: '@bob' })
  })

  test('a task in review stays in review when work goes on, and is done when its last box is ticked', () => {
    const inReview = withLine(V2)
    const stepped = stampTodo(inReview, '2026-10-09', { changes: { T2: { status: 'in progress', step: 'build' } } })
    expect(taskStates(stepped).T2!.status).toBe('in review')
    expect(taskStates(stampTodo(tickTask(inReview, 'T2'), '2026-10-09')).T2!.status).toBe('done')
  })

  test('the parser gives each task its owner, reviewer and PR; in review counts as under way', () => {
    const list = parseTasks(withLine(V2))
    const t2 = list.tasks.find(t => t.id === 'T2')!
    expect([t2.owner, t2.reviewer, t2.pr]).toEqual(['@amila', '@bob', '#42'])
    expect(list.current?.id).toBe('T2')
    expect(list.tasks.find(t => t.id === 'T1')!.owner).toBeUndefined()
  })

  test('--json shows owner, reviewer and pr per task, alongside every field it had', async () => {
    const files: Record<string, string> = { 'tasks/todo.md': withLine(V2) }
    const io: ProjectIo = { cwd: '/p', now: Date.parse('2026-10-09T10:00:00Z'), read: async r => files[r] ?? null, list: async r => (r ? [] : []) }
    const json = stateJson(await buildState(io))
    const t2 = json.tasks!.items.find(t => t.id === 'T2')!
    expect(t2).toMatchObject({ owner: '@amila', reviewer: '@bob', pr: '#42', state: { status: 'in review' } })
    expect(Object.keys(t2)).toEqual(expect.arrayContaining(['id', 'title', 'phase', 'status', 'deps', 'open', 'date', 'state', 'blockedBy', 'checkpoint']))
    expect(json.tasks!.items.find(t => t.id === 'T1')).toMatchObject({ owner: null, reviewer: null, pr: null })
  })
})

describe('owners (T3)', () => {
  test('setOwner writes the owner on the Status line and keeps everything else', () => {
    const v2 = withLine(V2)
    const sara = setOwner(v2, 'T2', '@sara')
    expect(taskStates(sara).T2).toEqual({ status: 'in review', owner: '@sara', started: '2026-10-07', pr: '#42', reviewer: '@bob' })
    // Only that line changed.
    const diff = sara.split('\n').filter((l, i) => l !== v2.split('\n')[i])
    expect(diff).toEqual(['**Status:** in review · @sara · started 2026-10-07 · PR #42 · reviewer @bob'])
    expect(taskStates(setOwner(sara, 'T2', null)).T2!.owner).toBeUndefined()
    // A task without a Status line gets one.
    expect(taskStates(setOwner(TODO_TEMPLATE, 'T3', '@ann')).T3).toEqual({ status: 'todo', owner: '@ann' })
    expect(setOwner(TODO_TEMPLATE, 'T9', '@ann')).toBe(TODO_TEMPLATE)
  })

  test('owners show in the band, the board pane, /progress task, the CLI list and the run timeline', () => {
    const list = parseTasks(setOwner(setOwner(TODO_TEMPLATE, 'T2', '@sara'), 'T4', '@bob'))
    expect(bandText(list)).toMatch(/^● T2 Prisma schema for keys · @sara · /)
    const rows = boardRows(list).filter(r => r.kind === 'task') as { id: string; title: string }[]
    expect(rows.find(r => r.id === 'T2')!.title).toBe('Prisma schema for keys · @sara')
    expect(rows.find(r => r.id === 'T3')!.title).toBe('Issue and revoke keys')
    expect(taskDetail(list, 'T2', { today: '2026-10-09', dates: {}, commits: [] })!.split('\n')[1]).toMatch(/^current · @sara/)
    const cli = timelineRows(list).filter(r => r.kind === 'task') as { id: string; detail: string }[]
    expect(cli.find(r => r.id === 'T4')!.detail).toMatch(/^@bob/)
    const tl = timeline({ spec: null, list, plan: null, forecast: null, dates: {}, today: '2026-10-09' }).rows.map(plain)
    expect(tl.find(r => r.includes('T2 Prisma'))).toMatch(/@sara$/)
    expect(tl.find(r => r.includes('T3 Issue'))).not.toMatch(/@/)
  })
})
