import { describe, expect, test } from 'claude-code/testing'

import { ACTION_NAMES, runAction, type ActionInput } from '../packages/core/actions'
import { parseSpec, parseTasks } from '../packages/core/parse'
import { parseTeam } from '../packages/core/team'
import { SPEC, TODO_T2_DONE, TODO_TEMPLATE } from './fixtures'

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
    expect([...ACTION_NAMES]).toEqual(['start', 'done', 'block', 'unblock', 'tick', 'claim', 'assign', 'unassign', 'review', 'handoff', 'sign', 'signoff', 'answer'])
  })

  test('an unknown action, or args of the wrong type, are refused and write nothing', () => {
    expect(runAction('rename', { id: 'T2' }, input())).toEqual({ ok: false, reply: 'No action "rename". Actions: start, done, block, unblock, tick, claim, assign, unassign, review, handoff, sign, signoff, answer.', writes: [] })
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

// team-view T2: answer an open question, sign off the checkpoint that is due.

const PLAN = '# Plan\n\n## Open Questions\n\n- Q1 (T3): argon2 or bcrypt?\n- Q2 (T4): Upstash or self-hosted?\n'

describe('answer and signoff (T2)', () => {
  test('answer writes your name and the date under the question, and replaces an earlier answer', () => {
    const r = runAction('answer', { q: 'q2', text: 'Upstash' }, input({ plan: PLAN, team: TEAM, email: 'pm@example.com' }))
    expect(r).toEqual({ ok: true, reply: 'Q2 answered: "Upstash" · @pm 2026-10-11.', writes: [{ file: 'tasks/plan.md', text: PLAN.replace('self-hosted?\n', 'self-hosted?\n  → A: Upstash · @pm 2026-10-11\n') }] })
    const again = runAction('answer', { q: '2', text: '"self-hosted"' }, input({ plan: r.writes[0]!.text, team: TEAM, email: 'amila@example.com' }))
    expect(again.reply).toBe('Q2 answered: "self-hosted" · @amila 2026-10-11 (was "Upstash" · @pm).')
    expect(again.writes[0]!.text).toBe(PLAN.replace('self-hosted?\n', 'self-hosted?\n  → A: self-hosted · @amila 2026-10-11\n'))
  })

  test('answer refuses an unknown question, no plan and no text; without tasks/team.md it is dated but unnamed', () => {
    expect(runAction('answer', { q: 'Q7', text: 'x' }, input({ plan: PLAN }))).toEqual({ ok: false, reply: 'No Q7 under Open Questions in tasks/plan.md. Questions: Q1, Q2.', writes: [] })
    expect(runAction('answer', { q: 'Q1', text: 'x' }, input()).reply).toBe('No tasks/plan.md here.')
    expect(runAction('answer', { q: 'Q1', text: '  ' }, input({ plan: PLAN })).reply).toBe('Say the answer: /progress answer Q1 "Upstash".')
    expect(runAction('answer', { text: 'x' }, input({ plan: PLAN })).reply).toBe('Say which question and the answer: /progress answer Q2 "Upstash".')
    const r = runAction('answer', { q: 'Q1', text: 'argon2id' }, input({ plan: PLAN, todo: null }))
    expect(r.reply).toBe('Q1 answered: "argon2id" · 2026-10-11. tasks/team.md doesn\'t name you, so the answer is unsigned.')
    expect(r.writes[0]!.text).toContain('- Q1 (T3): argon2 or bcrypt?\n  → A: argon2id · 2026-10-11\n')
  })

  test('an arg can\'t write a line of its own: handles with spaces are refused, notes and reasons kept on one line', () => {
    // The live server takes args as JSON, so a newline can reach an action that the command line never sends.
    for (const [name, args] of [
      ['assign', { id: 'T2', who: '@x\n- [x] injected' }],
      ['assign', { id: 'T2', who: '@x · done 2026-01-01' }],
      ['handoff', { id: 'T2', to: '@bob\n## Task 9: injected', note: 'x' }],
      ['review', { id: 'T1', refs: ['https://example.com/pr/1\n## Task 9: injected'] }],
    ] as const) {
      const r = runAction(name, args, input())
      expect(r.ok).toBe(false)
      expect(r.writes).toEqual([])
    }
    const lines = (s: string) => s.split('\n').length
    const handoff = runAction('handoff', { id: 'T2', to: '@bob', note: 'migration done\n- [x] tests left' }, input())
    expect(handoff.ok).toBe(true)
    // T2 has no Status line yet: the owner's and the Handoff line, and nothing else.
    expect(lines(handoff.writes[0]!.text)).toBe(lines(TODO_TEMPLATE) + 2)
    expect(handoff.writes[0]!.text).toContain(': migration done - [x] tests left\n')
    const block = runAction('block', { id: 'T2', why: 'Upstash\n## Task 9: injected' }, input({ plan: '# Plan\n\n## Open Questions\n' }))
    expect(block.ok).toBe(true)
    const plan = block.writes.find(w => w.file === 'tasks/plan.md')!.text
    expect(plan).toContain('- Q1 (T2): Upstash ## Task 9: injected')
    expect(plan).not.toContain('\n## Task 9')
  })

  test('signoff signs the checkpoint that is due and ticks its review box', () => {
    const r = runAction('signoff', {}, input({ todo: TODO_T2_DONE, team: TEAM, email: 'amila@example.com' }))
    expect(r.ok).toBe(true)
    expect(r.reply).toBe('Checkpoint "After Tasks 1-2" signed off by @amila on 2026-10-11. Still open: All tests pass.')
    expect(r.writes).toEqual([{ file: 'tasks/todo.md', text: TODO_T2_DONE.replace('## Checkpoint: After Tasks 1-2\n', '## Checkpoint: After Tasks 1-2\n**Signed off:** @amila 2026-10-11\n').replace('- [ ] Review with human', '- [x] Review with human') }])
  })

  test('signoff refuses when no checkpoint is due, and once it is signed', () => {
    expect(runAction('signoff', {}, input()).reply).toBe('No checkpoint is due: "After Tasks 1-2" comes after T2, which is not done yet.')
    const signed = runAction('signoff', {}, input({ todo: TODO_T2_DONE })).writes[0]!.text
    expect(runAction('signoff', {}, input({ todo: signed }))).toEqual({ ok: false, reply: 'No checkpoint is due: every checkpoint reached is signed off.', writes: [] })
    expect(runAction('signoff', {}, input({ todo: '# Tasks\n\n## Task 1: x\n- [x] y\n' })).reply).toBe('No checkpoint is due: tasks/todo.md has no "## Checkpoint" headings.')
  })
})
