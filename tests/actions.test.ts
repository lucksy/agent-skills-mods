import { describe, expect, test } from 'claude-code/testing'

import { ACTION_NAMES, runAction, type ActionInput } from '../packages/core/actions'
import { parseSpec, parseTasks } from '../packages/core/parse'
import { parseTeam } from '../packages/core/team'
import { SPEC, TODO_TEMPLATE } from './fixtures'

// team-view T1: one table of actions behind every write. Each action checks its
// args and edits text, so the /progress verbs and the live server can't drift apart.

const TEAM = parseTeam(`---
approvals: product, eng
---
| Handle | Role | Email |
|---|---|---|
| @amila | lead, eng | amila@example.com |
| @pm | product | pm@example.com |
`)

/** An input as the plugin hands one in: the files, the list the board shows, today and who you are. */
function input(over: Partial<ActionInput> = {}): ActionInput {
  const todo = over.todo === undefined ? TODO_TEMPLATE : over.todo
  return {
    todo,
    plan: null,
    spec: null,
    list: todo === null ? null : parseTasks(todo),
    today: '2026-10-11',
    team: null,
    email: null,
    pending: {},
    keepFormat: true,
    ...over,
  }
}

describe('the actions table (T1)', () => {
  test('names every write the commands make today', () => {
    expect([...ACTION_NAMES]).toEqual(['start', 'done', 'block', 'unblock', 'tick', 'claim', 'assign', 'unassign', 'review', 'handoff', 'sign'])
  })

  test('an unknown action, or args of the wrong type, are refused and write nothing', () => {
    expect(runAction('rename', { id: 'T2' }, input())).toEqual({ ok: false, reply: 'No action "rename". Actions: start, done, block, unblock, tick, claim, assign, unassign, review, handoff, sign.', writes: [] })
    const r = runAction('start', { id: 4 }, input())
    expect(r.ok).toBe(false)
    expect(r.writes).toEqual([])
    expect(runAction('tick', { id: 'T2', index: 'one' }, input()).ok).toBe(false)
  })

  test('without tasks/todo.md, and for an unknown task, the replies are the commands\' own', () => {
    expect(runAction('start', { id: 'T2' }, input({ todo: null })).reply).toBe('No tasks/todo.md here.')
    expect(runAction('assign', { id: 'T9', who: '@sara' }, input()).reply).toBe('No "## Task 9:" section in tasks/todo.md. Tasks: T1, T2, T3, T4.')
    expect(runAction('handoff', { id: '9', to: '@bob', note: 'x' }, input()).reply).toBe('No "## Task 9:" section in tasks/todo.md. Tasks: T1, T2, T3, T4.')
  })

  test('start stamps the task in progress, owned by you when it has no owner', () => {
    const r = runAction('start', { id: 't3' }, input({ team: TEAM, email: 'amila@example.com' }))
    expect(r.ok).toBe(true)
    expect(r.reply).toBe('T3 Issue and revoke keys is in progress (started 11 Oct).')
    expect(r.writes.map(w => w.file)).toEqual(['tasks/todo.md'])
    const t3 = parseTasks(r.writes[0]!.text).tasks.find(t => t.id === 'T3')!
    expect(t3.state?.status).toBe('in progress')
    expect(t3.owner).toBe('@amila')
  })

  test('done ticks every box; block needs a why and adds the question to tasks/plan.md', () => {
    const done = runAction('done', { id: 'T2' }, input())
    expect(done.reply).toBe('T2 Prisma schema for keys is done: 2 box(es) ticked.')
    expect(parseTasks(done.writes[0]!.text).tasks.find(t => t.id === 'T2')!.status).toBe('done')
    expect(runAction('block', { id: 'T3', why: '' }, input())).toEqual({ ok: false, reply: 'Say why: /progress block T6 "Upstash or self-hosted?"', writes: [] })
    const block = runAction('block', { id: 'T3', why: 'Upstash?' }, input())
    expect(block.writes.map(w => w.file)).toEqual(['tasks/plan.md', 'tasks/todo.md'])
    expect(block.writes[0]!.text).toMatch(/Q1 \(T3\): Upstash\?/)
    expect(block.reply).toBe('T3 Issue and revoke keys is blocked. Added Q1 to tasks/plan.md: "Upstash?".')
  })

  test('tick toggles one box; a box that is not there is refused', () => {
    const r = runAction('tick', { id: 'T2', index: 1 }, input())
    expect(r.ok).toBe(true)
    expect(r.writes[0]!.text).toMatch(/- \[x\] Migration runs on a clean database/)
    expect(runAction('tick', { id: 'T2', index: 9 }, input()).ok).toBe(false)
  })

  test('assign names an unknown handle; claim needs to know who you are', () => {
    const a = runAction('assign', { id: 'T3', who: 'sara' }, input({ team: TEAM }))
    expect(a.reply).toBe('T3 Issue and revoke keys → @sara. @sara is not in tasks/team.md (/progress team).')
    expect(parseTasks(a.writes[0]!.text).tasks.find(t => t.id === 'T3')!.owner).toBe('@sara')
    expect(runAction('claim', { id: 'T3' }, input()).reply).toBe("Can't tell who you are: no tasks/team.md here. /progress team init sets one up; or name someone: /progress assign T3 @name.")
    expect(runAction('claim', { id: 'T3' }, input({ team: TEAM, email: 'amila@example.com' })).reply).toBe('T3 Issue and revoke keys → @amila (you).')
    const un = runAction('unassign', { id: 'T3' }, input({ todo: a.writes[0]!.text }))
    expect(un.reply).toBe('T3 Issue and revoke keys has no owner now (was @sara).')
  })

  test('review refuses a done task and a word that is neither PR nor reviewer', () => {
    expect(runAction('review', { id: 'T1' }, input()).reply).toBe('T1 Monorepo scaffold is done: a review comes before its last box is ticked.')
    expect(runAction('review', { id: 'T2', refs: ['soon'] }, input()).reply).toBe('Not a PR or a reviewer: "soon". Use /progress review T2 #42 @bob (both optional).')
    expect(runAction('review', { id: 'T3' }, input()).reply).toBe('T3 Issue and revoke keys has no box ticked yet: build it first, or /progress start T3.')
    const r = runAction('review', { id: 'T2', refs: ['#42', '@bob'] }, input())
    expect(r.reply).toBe('T2 Prisma schema for keys is in review: PR #42, reviewer @bob.')
  })

  test('handoff needs who and a note, and dates the note', () => {
    expect(runAction('handoff', { id: 'T2', note: 'x' }, input()).reply).toBe('Say who takes it: /progress handoff T2 @bob "x".')
    expect(runAction('handoff', { id: 'T2', to: '@bob', note: '' }, input()).reply).toBe('Say what the next person needs to know: /progress handoff T2 @bob "migration done, tests left".')
    const r = runAction('handoff', { id: 'T2', to: '@bob', note: 'tests left' }, input({ team: TEAM, email: 'amila@example.com' }))
    expect(r.reply).toBe('T2 Prisma schema for keys → @bob, from @amila. Note: "tests left".')
    expect(r.writes[0]!.text).toMatch(/\*\*Handoff:\*\* 2026-10-11 @amila → @bob: tests left/)
  })

  test('sign approves a spec, or signs for your roles when the team names approvals', () => {
    const spec = { file: 'SPEC.md', text: SPEC }
    const plain = runAction('sign', {}, input({ spec }))
    expect(plain.reply).toBe('✓ SPEC.md approved · planning can start')
    expect(parseSpec(plain.writes[0]!.text).status).toBe('approved')
    const mine = runAction('sign', {}, input({ spec, team: TEAM, email: 'amila@example.com' }))
    expect(mine.reply).toBe('✓ @amila signed SPEC.md for eng · waiting on @pm (product)')
    expect(runAction('sign', {}, input({ spec, team: TEAM, email: 'who@example.com' }))).toEqual({ ok: false, reply: "Can't sign: who@example.com is not in tasks/team.md.", writes: [] })
    expect(runAction('sign', {}, input()).ok).toBe(false)
  })
})
