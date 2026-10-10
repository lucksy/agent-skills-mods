import { describe, expect, test } from 'claude-code/testing'

import { branchRows } from '../packages/core/branches'
import { collisions } from '../packages/core/collisions'
import { parsePlan, parseSpec, parseTasks } from '../packages/core/parse'
import { look, mergeSince, nextSeen, parseSeen, seenOf, seenText, SINCE_MAX, sinceChanges, sinceLine, sinceText, type SeenParts } from '../packages/core/since'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'

// team-view T9 (V4): what changed since you last looked.

const THEN = Date.parse('2026-10-09T17:00:00Z')
const NOW = Date.parse('2026-10-11T09:00:00Z')

const task = (n: number, title: string, status: string | null, extra = '') => `## Task ${n}: ${title}\n${status === null ? '' : `**Status:** ${status}\n`}${extra}- [ ] box\n`
const TODO = [task(1, 'Scaffold', 'in progress · @bob · started 2026-10-08'), task(2, 'Schema', 'todo · @sara'), task(3, 'Keys', null), task(4, 'Rate limit', null)].join('\n')
const PLAN = '# Plan\n\n## Open Questions\n\n- Q1 (T3): argon2 or bcrypt?\n- Q2 (T4): Upstash or self-hosted?\n'
const SPEC_APPROVED = '---\nstatus: approved\napprovals: eng @amila 2026-10-08\n---\n# Spec\n'
const SPEC_DRAFT = '---\nstatus: draft\n---\n# Spec\n'

const parts = (o: { todo?: string; plan?: string; specs?: Record<string, string>; collisions?: SeenParts['collisions'] } = {}): SeenParts => ({
  list: parseTasks(o.todo ?? TODO),
  specs: Object.entries(o.specs ?? { 'SPEC-x.md': SPEC_DRAFT }).map(([file, text]) => ({ file, spec: parseSpec(text) })),
  plan: parsePlan(o.plan ?? PLAN),
  collisions: o.collisions === undefined ? [] : o.collisions,
  branches: { here: 'main' },
})
const before = seenOf(parts(), THEN)
const texts = (b: SeenParts, me: string | null = '@amila') => sinceChanges(before, seenOf(b, NOW), me).map(c => c.text)

describe('each kind of change, with who made it', () => {
  test('a task done names its owner', () => {
    expect(texts(parts({ todo: TODO.replace('in progress · @bob · started 2026-10-08', 'done · @bob · started 2026-10-08 · done 2026-10-10') }))).toEqual(['T1 done by @bob'])
    // Ticked boxes alone, with no owner: done, and nobody to name.
    expect(texts(parts({ todo: TODO.replace('## Task 3: Keys\n- [ ] box', '## Task 3: Keys\n- [x] box') }))).toEqual(['T3 done'])
  })

  test('a task assigned or handed to you; to others only when it cannot tell who you are', () => {
    const assigned = parts({ todo: TODO.replace('## Task 3: Keys\n', '## Task 3: Keys\n**Status:** todo · @amila\n') })
    expect(texts(assigned)).toEqual(['T3 assigned to you'])
    expect(texts(assigned, '@sara')).toEqual([])
    expect(texts(assigned, null)).toEqual(['T3 assigned to @amila'])
    const handed = parts({ todo: TODO.replace('**Status:** todo · @sara\n', '**Status:** todo · @amila\n**Handoff:** 2026-10-10 @sara → @amila: schema drafted, review the indexes\n') })
    expect(texts(handed)).toEqual(['T2 handed to you by @sara'])
  })

  test('a question answered names who answered it', () => {
    expect(texts(parts({ plan: PLAN.replace('self-hosted?\n', 'self-hosted?\n  → A: Upstash · @pm 2026-10-10\n') }))).toEqual(['Q2 answered by @pm'])
  })

  test('a spec approved, or back to draft', () => {
    const b = seenOf(parts({ specs: { 'SPEC-x.md': SPEC_APPROVED, 'specs/auth.md': SPEC_APPROVED } }), THEN)
    expect(sinceChanges(before, seenOf(parts({ specs: { 'SPEC-x.md': SPEC_APPROVED } }), NOW), '@sara').map(c => c.text)).toEqual(['SPEC-x approved by @amila'])
    expect(sinceChanges(b, seenOf(parts({ specs: { 'SPEC-x.md': SPEC_DRAFT, 'specs/auth.md': SPEC_DRAFT } }), NOW), '@sara').map(c => c.text)).toEqual(['SPEC-x back to draft', 'specs/auth back to draft'])
  })

  test('a new collision, said from this branch\'s side', () => {
    const board = branchRows(
      { name: 'main', list: parseTasks(TODO) },
      [{ ref: { ref: 'refs/heads/feat/x', name: 'feat/x', sha: 'b'.repeat(40), ms: THEN, remote: false }, text: TODO.replace('in progress · @bob', 'in progress · @zoe') }],
      null,
    )
    const found = collisions(board, NOW)
    expect(found.map(c => c.id)).toEqual(['T1'])
    expect(texts(parts({ collisions: found }))).toEqual(['T1 now also in progress on feat/x by @zoe'])
    // Still there on the next look: not news again.
    expect(sinceChanges(seenOf(parts({ collisions: found }), THEN), seenOf(parts({ collisions: found }), NOW), null)).toEqual([])
  })

  test('what you did yourself is not news', () => {
    const mine = parts({
      todo: TODO.replace('**Status:** todo · @sara', '**Status:** done · @amila · started 2026-10-09 · done 2026-10-10'),
      plan: PLAN.replace('bcrypt?\n', 'bcrypt?\n  → A: argon2 · @amila 2026-10-10\n'),
      specs: { 'SPEC-x.md': SPEC_APPROVED },
    })
    expect(texts(mine)).toEqual([])
    expect(texts(mine, null)).toEqual(['SPEC-x approved by @amila', 'Q1 answered by @amila', 'T2 done by @amila', 'T2 assigned to @amila'])
  })

  test('most wanted first: yours, collisions, specs, answers, done', () => {
    const all = parts({
      todo: TODO.replace('in progress · @bob · started 2026-10-08', 'done · @bob · started 2026-10-08 · done 2026-10-10').replace('## Task 4: Rate limit\n', '## Task 4: Rate limit\n**Status:** todo · @amila\n'),
      plan: PLAN.replace('self-hosted?\n', 'self-hosted?\n  → A: Upstash · @pm 2026-10-10\n'),
      specs: { 'SPEC-x.md': SPEC_APPROVED },
    })
    expect(texts(all, '@sara').length).toBe(3)
    expect(texts(all)).toEqual(['T4 assigned to you', 'Q2 answered by @pm', 'T1 done by @bob'])
    expect(sinceChanges(before, seenOf(all, NOW), '@sara').map(c => c.kind)).toEqual(['spec', 'answered', 'done'])
  })

  test('a new plan reusing task ids is not compared with the old one', () => {
    expect(texts(parts({ todo: task(1, 'Something else', 'done · @bob · started 2026-10-10 · done 2026-10-10') }))).toEqual([])
  })
})

describe('a look', () => {
  test('nothing changed shows nothing', () => {
    const s = look(parseSeen(seenText(before)), seenOf(parts(), NOW), '@amila')
    expect(s.since).toEqual({ day: '2026-10-09', first: false, changes: [] })
    expect(sinceLine(s.since)).toBeNull()
    expect(sinceText(s.since)).toBe('Nothing changed since you last looked (2026-10-09).')
  })

  test('the first look, or a missing or corrupt seen.json, says nothing and stores a snapshot', () => {
    for (const prev of [null, '', '{"schema":1,"at":', '[]', '{"schema":2}', 'null']) {
      const s = look(parseSeen(prev), seenOf(parts(), NOW), null)
      expect(s.since).toEqual({ day: null, first: true, changes: [] })
      expect(sinceLine(s.since)).toBeNull()
      expect(parseSeen(seenText(s.next))).toEqual(seenOf(parts(), NOW))
    }
    expect(sinceText(look(null, seenOf(parts(), NOW), null).since)).toMatch(/^First look here: nothing to compare with yet\./)
  })

  test('the stored snapshot keeps the last collisions when the branches were not read', () => {
    const withCollision = { ...before, collisions: { 'T1 feat/x main': 'T1 now also in progress on feat/x by @zoe' } }
    const unread = seenOf(parts({ collisions: null }), NOW)
    expect(unread.collisions).toBeNull()
    expect(nextSeen(withCollision, unread).collisions).toEqual(withCollision.collisions)
    // Not known now: no news either way.
    expect(sinceChanges(withCollision, unread, null)).toEqual([])
  })

  test('the session\'s first look and a later one, as one list: nothing twice, most wanted first', () => {
    const first = { day: '2026-10-09', first: false, changes: [{ kind: 'done' as const, text: 'T1 done by @bob' }, { kind: 'answered' as const, text: 'Q2 answered by @pm' }].reverse() }
    const later = { day: '2026-10-11', first: false, changes: [{ kind: 'you' as const, text: 'T4 assigned to you' }, { kind: 'done' as const, text: 'T1 done by @bob' }] }
    expect(mergeSince(first, later)).toEqual({ day: '2026-10-09', first: false, changes: [{ kind: 'you', text: 'T4 assigned to you' }, { kind: 'answered', text: 'Q2 answered by @pm' }, { kind: 'done', text: 'T1 done by @bob' }] })
    const none = { day: null, first: true, changes: [] }
    expect(mergeSince(none, later)).toBe(later)
    expect(mergeSince(first, none)).toBe(first)
  })

  test('one line, at most six changes, then where the rest are', () => {
    const many = { day: '2026-10-09', first: false, changes: Array.from({ length: 9 }, (_, i) => ({ kind: 'done' as const, text: `T${i + 1} done by @bob` })) }
    const line = sinceLine(many)!
    expect(line).toBe('Since you last looked (2026-10-09): T1 done by @bob · T2 done by @bob · T3 done by @bob · T4 done by @bob · T5 done by @bob · T6 done by @bob · and 3 more · /progress since')
    expect(line).not.toContain('\n')
    expect(SINCE_MAX).toBe(6)
    expect(sinceLine({ ...many, changes: many.changes.slice(0, 2) })).toBe('Since you last looked (2026-10-09): T1 done by @bob · T2 done by @bob')
    expect(sinceText(many).split('\n')).toHaveLength(10)
    expect(sinceText(many).split('\n')[0]).toBe('Since you last looked (2026-10-09), 9 changes:')
    expect(sinceText(many).split('\n')[9]).toBe('- T9 done by @bob')
  })
})

describe('since in State v1', () => {
  const io = (seen?: string | null): ProjectIo => ({
    cwd: '/p',
    now: NOW,
    read: async rel => (rel === 'tasks/todo.md' ? TODO.replace('in progress · @bob · started 2026-10-08', 'done · @bob · started 2026-10-08 · done 2026-10-10') : rel === 'tasks/plan.md' ? PLAN : null),
    list: async () => [],
    ...(seen === undefined ? {} : { seen: async () => seen }),
  })

  test('only when asked for, and it writes nothing', async () => {
    const json = stateJson(await buildState(io(seenText(before)), { since: true }))
    expect(json.schema).toBe(1)
    expect(json.since).toEqual({ day: '2026-10-09', first: false, changes: [{ kind: 'done', text: 'T1 done by @bob' }] })
    expect(stateJson(await buildState(io(seenText(before)))).since).toBeNull()
    expect(stateJson(await buildState(io(), { since: true })).since).toBeNull()
    expect(stateJson(await buildState(io(null), { since: true })).since).toEqual({ day: null, first: true, changes: [] })
  })
})
