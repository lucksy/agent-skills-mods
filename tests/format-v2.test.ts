import { describe, expect, test } from 'claude-code/testing'

import { FORMAT_RULES, addHandoff, parseStatusLine, setOwner, setReview, stampTodo, statusLine, taskStates, tickTask } from '../packages/core/format'
import { nowCounts } from '../packages/core/report'
import { parseTasks } from '../packages/core/parse'
import { bandText, boardRows, progressBrief, taskDetail, timelineRows } from '../packages/core/view'
import { dashboardHtml } from '../packages/core/dashboard/page'
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

describe('auto-claim (T4)', () => {
  test('a queued owner fills an empty owner and never replaces one', () => {
    const change = { T2: { status: 'in progress' as const, step: 'build' as const, owner: '@sara' } }
    expect(taskStates(stampTodo(TODO_TEMPLATE, '2026-10-09', { changes: change })).T2!.owner).toBe('@sara')
    const owned = setOwner(TODO_TEMPLATE, 'T2', '@amila')
    expect(taskStates(stampTodo(owned, '2026-10-09', { changes: change })).T2!.owner).toBe('@amila')
  })
})

describe('in review (T5)', () => {
  const started = setOwner(TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · started 2026-10-07 · step test\n'), 'T2', '@amila')

  test('setReview sets in review with the PR and reviewer given, keeping owner and dates', () => {
    expect(taskStates(setReview(started, 'T2', { pr: '#42', reviewer: '@bob' })).T2).toEqual({ status: 'in review', owner: '@amila', started: '2026-10-07', pr: '#42', reviewer: '@bob' })
    // Only what is given changes: a second review keeps the PR.
    const again = setReview(setReview(started, 'T2', { pr: '#42' }), 'T2', { reviewer: '@ann' })
    expect(taskStates(again).T2).toMatchObject({ pr: '#42', reviewer: '@ann' })
  })

  test('in review shows in the board pane, the timeline, /progress task and the CLI, and counts as under way', () => {
    const list = parseTasks(setReview(started, 'T2', { pr: '#42', reviewer: '@bob' }))
    const row = boardRows(list).find(r => r.kind === 'task' && r.id === 'T2') as { right: string }
    expect(row.right).toBe('review #42 @bob')
    const tl = timeline({ spec: null, list, plan: null, forecast: null, dates: {}, today: '2026-10-09' }).rows.map(plain)
    expect(tl.find(r => r.includes('T2 Prisma'))).toMatch(/▬▬▬ in review · PR #42 · @bob {2}@amila$/)
    expect(taskDetail(list, 'T2', { today: '2026-10-09', dates: {}, commits: [] })!.split('\n')[1]).toMatch(/^in review · @amila · PR #42 · reviewer @bob · started 7 Oct/)
    const cli = timelineRows(list).find(r => r.kind === 'task' && r.id === 'T2') as { detail: string }
    expect(cli.detail).toBe('@amila · in review · PR #42 · @bob')
    expect(nowCounts(list)).toMatchObject({ doing: 1 })
  })
})

describe('handoffs (T7)', () => {
  const owned = setOwner(TODO_TEMPLATE, 'T2', '@sara')

  test('addHandoff sets the new owner and adds a dated note under the Status line, keeping earlier notes', () => {
    const once = addHandoff(owned, 'T2', { day: '2026-10-09', from: '@sara', to: '@bob', note: 'migration done, tests left' })
    expect(once).toContain('## Task 2: Prisma schema for keys\n**Status:** todo · @bob\n**Handoff:** 2026-10-09 @sara → @bob: migration done, tests left\n')
    const twice = addHandoff(once, 'T2', { day: '2026-10-10', from: '@bob', to: '@ann', note: 'over to you' })
    expect(twice).toContain('**Status:** todo · @ann\n**Handoff:** 2026-10-09 @sara → @bob: migration done, tests left\n**Handoff:** 2026-10-10 @bob → @ann: over to you\n')
    // Nothing else moved.
    expect(twice.replace(/\*\*Handoff:\*\*.*\n/g, '').replace('**Status:** todo · @ann\n', '**Status:** todo · @sara\n')).toBe(owned)
  })

  test('without an owner before, the note says who handed it over; the parser reads every note', () => {
    const t = addHandoff(TODO_TEMPLATE, 'T3', { day: '2026-10-09', from: null, to: '@bob', note: 'yours' })
    expect(t).toContain('## Task 3: Issue and revoke keys\n**Status:** todo · @bob\n**Handoff:** 2026-10-09 → @bob: yours\n')
    const list = parseTasks(addHandoff(t, 'T3', { day: '2026-10-10', from: '@bob', to: '@ann', note: 'a `code` note' }))
    expect(list.tasks.find(x => x.id === 'T3')!.handoffs).toEqual([
      { day: '2026-10-09', from: null, to: '@bob', note: 'yours' },
      { day: '2026-10-10', from: '@bob', to: '@ann', note: 'a `code` note' },
    ])
    // A Handoff line is not a box, a dependency or a heading: the task is otherwise the same.
    expect(list.tasks.find(x => x.id === 'T3')!.boxes.length).toBe(1)
  })

  test('the latest note shows in /progress task, on the dashboard card, and in the agent\'s state when the task is current', async () => {
    const text = addHandoff(owned, 'T2', { day: '2026-10-09', from: '@sara', to: '@bob', note: 'migration done, tests left' })
    const list = parseTasks(text)
    expect(taskDetail(list, 'T2', { today: '2026-10-09', dates: {}, commits: [] })).toContain('Handoff 9 Oct @sara → @bob: migration done, tests left')
    const files: Record<string, string> = { 'tasks/todo.md': text }
    const io: ProjectIo = { cwd: '/p', now: Date.parse('2026-10-09T10:00:00Z'), read: async r => files[r] ?? null, list: async () => [] }
    const html = dashboardHtml(await buildState(io), { view: 'board' })
    expect(html).toMatch(/data-task="T2"[\s\S]*?<p class="c-note">↪ @sara → @bob: migration done, tests left<\/p>/)
    const brief = progressBrief({ spec: null, specFile: null, list, listFile: 'tasks/todo.md', plan: null, forecast: null })!
    expect(brief).toContain('- handoff to @bob on 2026-10-09 from @sara: migration done, tests left')
  })
})

describe('the rules Claude is told, v2 (T13)', () => {
  test('owners, in review, handoffs, approvals by role and module: are in the rules', () => {
    expect(FORMAT_RULES).toContain('in review · @sara · started YYYY-MM-DD · PR #42 · reviewer @bob')
    expect(FORMAT_RULES).toMatch(/keep every token/i)
    expect(FORMAT_RULES).toContain('**Handoff:** YYYY-MM-DD @from → @to: note')
    expect(FORMAT_RULES).toMatch(/approvals:.*role @handle YYYY-MM-DD/)
    expect(FORMAT_RULES).toMatch(/never sign for anyone/i)
    expect(FORMAT_RULES).toContain('module: <id>')
  })
})
