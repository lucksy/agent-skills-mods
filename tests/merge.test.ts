import { describe, expect, test } from 'claude-code/testing'

import { mergeFrontMatter, mergeTodo, wholeMerge, type LineMerge } from '../packages/core/merge'
import { parseTasks } from '../packages/core/parse'
import { TODO_TEMPLATE } from './fixtures'

// team-view T7: the task-aware merge, one test per row of the spec's merge-rules
// table, then a property test: over generated base/ours/theirs no task is dropped.

const BASE = `---
plan: keys
created: 2026-10-01
---
# Tasks: keys

## Task 1: Scaffold
**Status:** in progress · @amila · started 2026-10-02

**Acceptance criteria:**
- [ ] Builds
- [ ] Lints

**Dependencies:** None

## Task 2: Schema
**Status:** todo

**Acceptance criteria:**
- [ ] Table

**Dependencies:** T1

## Checkpoint: Foundation
- [ ] All tests pass
- [ ] Review with human before proceeding
`

const edit = (text: string, from: string, to: string) => {
  if (!text.includes(from)) throw new Error(`fixture has no ${JSON.stringify(from)}`)
  return text.replace(from, to)
}
/** A line merge that records what it was handed: the rows that must not reach it can be checked. */
function recording() {
  const calls: [string, string, string][] = []
  const merge: LineMerge = (b, o, t) => {
    calls.push([b, o, t])
    return wholeMerge(b, o, t)
  }
  return { calls, merge }
}

describe('a task on both sides', () => {
  test('a box ticked on either side is ticked, and the rest is untouched', () => {
    const ours = edit(BASE, '- [ ] Builds', '- [x] Builds')
    const theirs = edit(BASE, '- [ ] Lints', '- [x] Lints')
    const r = mergeTodo(BASE, ours, theirs)
    expect(r.text).toBe(edit(ours, '- [ ] Lints', '- [x] Lints'))
    expect(r.conflicts).toEqual([])
    expect(r.renumbered).toEqual([])
  })

  test('the same box ticked on both sides, and on checkpoints too', () => {
    const ours = edit(edit(BASE, '- [ ] Table', '- [x] Table'), '- [ ] All tests pass', '- [x] All tests pass')
    const theirs = edit(edit(BASE, '- [ ] Table', '- [x] Table'), '- [ ] Review with human', '- [x] Review with human')
    const r = mergeTodo(BASE, ours, theirs)
    expect(r.text).toBe(edit(ours, '- [ ] Review with human', '- [x] Review with human'))
    expect(r.conflicts).toEqual([])
  })

  test('the Status line with the later done date wins', () => {
    const ours = edit(BASE, '**Status:** in progress · @amila · started 2026-10-02', '**Status:** done · @amila · started 2026-10-02 · done 2026-10-05')
    const theirs = edit(BASE, '**Status:** in progress · @amila · started 2026-10-02', '**Status:** done · @amila · started 2026-10-02 · done 2026-10-07')
    const r = mergeTodo(BASE, ours, theirs)
    expect(r.text).toBe(theirs)
    expect(r.conflicts).toEqual([])
  })

  test('with no done date, the later started date wins', () => {
    const ours = edit(BASE, '**Status:** todo', '**Status:** in progress · @sara · started 2026-10-09')
    const theirs = edit(BASE, '**Status:** todo', '**Status:** blocked · @bob · started 2026-10-04')
    expect(mergeTodo(BASE, ours, theirs).text).toBe(ours)
    expect(mergeTodo(BASE, theirs, ours).text).toBe(ours)
  })

  test('equal stamps: ours wins (Q3: blocked does not beat a later in progress, only the stamp counts)', () => {
    const ours = edit(BASE, '**Status:** todo', '**Status:** in progress · @sara · started 2026-10-09')
    const theirs = edit(BASE, '**Status:** todo', '**Status:** blocked · @bob · started 2026-10-09')
    expect(mergeTodo(BASE, ours, theirs).text).toBe(ours)
    expect(mergeTodo(BASE, theirs, ours).text).toBe(theirs)
  })

  test('a Status line changed on one side only is taken, whatever its stamp', () => {
    const theirs = edit(BASE, '**Status:** in progress · @amila · started 2026-10-02', '**Status:** in review · @amila · started 2026-10-02 · PR #42')
    const ours = edit(BASE, '- [ ] Table', '- [x] Table')
    expect(mergeTodo(BASE, ours, theirs).text).toBe(edit(ours, '**Status:** in progress · @amila · started 2026-10-02', '**Status:** in review · @amila · started 2026-10-02 · PR #42'))
  })

  test('Handoff lines are combined and sorted by date', () => {
    const at = '**Status:** in progress · @amila · started 2026-10-02'
    const ours = edit(BASE, at, `**Status:** in progress · @bob · started 2026-10-02\n**Handoff:** 2026-10-08 @amila → @bob: tests left`)
    const theirs = edit(BASE, at, `**Status:** in progress · @kim · started 2026-10-02\n**Handoff:** 2026-10-04 @amila → @kim: lint left`)
    const r = mergeTodo(BASE, ours, theirs)
    expect(r.text).toBe(
      edit(BASE, at, `**Status:** in progress · @bob · started 2026-10-02\n**Handoff:** 2026-10-04 @amila → @kim: lint left\n**Handoff:** 2026-10-08 @amila → @bob: tests left`),
    )
    expect(r.conflicts).toEqual([])
  })

  test('other lines go through the line merge, without the boxes, Status or Handoff lines that are already settled', () => {
    const { calls, merge } = recording()
    const ours = edit(edit(BASE, '- [ ] Builds', '- [x] Builds'), '**Status:** todo', '**Status:** in progress · started 2026-10-09')
    const theirs = edit(BASE, '- [ ] Table', '- [ ] Table with hashed secret')
    const r = mergeTodo(BASE, ours, theirs, { lineMerge: merge })
    expect(r.text).toBe(edit(ours, '- [ ] Table', '- [ ] Table with hashed secret'))
    expect(calls.some(([, o, t]) => o.includes('[x]') || t.includes('[x]') || o.includes('**Status:**') || t.includes('**Status:**'))).toBe(false)
  })

  test('the same lines edited on both sides: the line merge leaves markers and the conflict is reported', () => {
    const ours = edit(BASE, '- [ ] Table', '- [ ] Table A')
    const theirs = edit(BASE, '- [ ] Table', '- [ ] Table B')
    const r = mergeTodo(BASE, ours, theirs)
    expect(r.text).toContain('<<<<<<< ours')
    expect(r.text).toContain('- [ ] Table A')
    expect(r.text).toContain('- [ ] Table B')
    expect(r.text).toContain('>>>>>>> theirs')
    expect(r.conflicts).toEqual(['T2: both sides changed the same lines'])
  })
})

describe('a task on one side only', () => {
  test('added on one side: kept, in its place', () => {
    const theirs = edit(BASE, '## Checkpoint: Foundation', '## Task 3: Issue keys\n**Status:** todo\n\n**Dependencies:** T2\n\n## Checkpoint: Foundation')
    const ours = edit(BASE, '- [ ] Builds', '- [x] Builds')
    const r = mergeTodo(BASE, ours, theirs)
    expect(r.text).toBe(edit(theirs, '- [ ] Builds', '- [x] Builds'))
    expect(r.conflicts).toEqual([])
  })

  test('a different task added on each side: both kept, ours first', () => {
    const ours = `${BASE}\n## Task 3: Ours\n- [ ] a\n`
    const theirs = `${BASE}\n## Task 4: Theirs\n- [ ] b\n`
    const r = mergeTodo(BASE, ours, theirs)
    expect(r.text).toBe(`${BASE}\n## Task 3: Ours\n- [ ] a\n\n## Task 4: Theirs\n- [ ] b\n`)
    expect(r.renumbered).toEqual([])
  })

  test('deleted on one side and untouched on the other: deleted', () => {
    const ours = edit(BASE, '## Task 2: Schema\n**Status:** todo\n\n**Acceptance criteria:**\n- [ ] Table\n\n**Dependencies:** T1\n\n', '')
    const theirs = edit(BASE, '- [ ] Builds', '- [x] Builds')
    const r = mergeTodo(BASE, ours, theirs)
    expect(r.text).toBe(edit(ours, '- [ ] Builds', '- [x] Builds'))
    expect(r.conflicts).toEqual([])
  })
})

describe('a task added on both sides with the same number', () => {
  const ours = `${BASE}\n## Task 3: Rate limits\n- [ ] 60 a minute\n\n**Dependencies:** T2\n`
  const theirs = `${BASE}\n## Task 3: Audit log\n- [ ] Every write\n\n**Dependencies:** T2\n\n## Task 4: Audit export\n- [ ] CSV\n\n**Dependencies:** Task 3, T1\n`

  test('ours keeps the number; theirs takes the next free one, and its dependencies follow', () => {
    const r = mergeTodo(BASE, ours, theirs)
    expect(r.renumbered).toEqual([['T3', 'T5']])
    expect(r.conflicts).toEqual([])
    expect(r.text).toBe(
      `${BASE}\n## Task 3: Rate limits\n- [ ] 60 a minute\n\n**Dependencies:** T2\n\n## Task 5: Audit log\n- [ ] Every write\n\n**Dependencies:** T2\n\n## Task 4: Audit export\n- [ ] CSV\n\n**Dependencies:** Task 5, T1\n`,
    )
    const ids = parseTasks(r.text).tasks.map(t => `${t.id} ${t.title}`)
    expect(ids).toEqual(['T1 Scaffold', 'T2 Schema', 'T3 Rate limits', 'T5 Audit log', 'T4 Audit export'])
  })

  test('the same title on both sides is one task, merged as a task', () => {
    const a = `${BASE}\n## Task 3: Rate limits\n- [x] 60 a minute\n- [ ] 429\n`
    const b = `${BASE}\n## Task 3: Rate limits\n- [ ] 60 a minute\n- [x] 429\n`
    const r = mergeTodo(BASE, a, b)
    expect(r.text).toBe(`${BASE}\n## Task 3: Rate limits\n- [x] 60 a minute\n- [x] 429\n`)
    expect(r.renumbered).toEqual([])
  })
})

describe('a task deleted on one side and edited on the other', () => {
  const T2 = '## Task 2: Schema\n**Status:** todo\n\n**Acceptance criteria:**\n- [ ] Table\n\n**Dependencies:** T1\n\n'

  test('markers around that task only, and the conflict is reported', () => {
    const ours = edit(edit(BASE, T2, ''), '- [ ] Builds', '- [x] Builds')
    const theirs = edit(BASE, '- [ ] Table', '- [x] Table')
    const r = mergeTodo(BASE, ours, theirs)
    expect(r.conflicts).toEqual(['T2: deleted in ours, changed in theirs'])
    const theirsT2 = T2.replace('- [ ] Table', '- [x] Table').replace(/\n$/, '')
    expect(r.text).toBe(edit(ours, '## Checkpoint: Foundation', `<<<<<<< ours\n=======\n${theirsT2}>>>>>>> theirs\n\n## Checkpoint: Foundation`))
    // Everything outside the markers merged as usual.
    expect(r.text.split('<<<<<<<').length).toBe(2)
    expect(r.text).toContain('- [x] Builds')
  })

  test('the other way round: edited in ours, deleted in theirs', () => {
    const ours = edit(BASE, '**Status:** todo', '**Status:** in progress · started 2026-10-09')
    const theirs = edit(BASE, T2, '')
    const r = mergeTodo(BASE, ours, theirs)
    expect(r.conflicts).toEqual(['T2: changed in ours, deleted in theirs'])
    expect(r.text).toContain('<<<<<<< ours\n## Task 2: Schema\n**Status:** in progress · started 2026-10-09')
    expect(r.text).toContain('=======\n>>>>>>> theirs\n')
  })
})

describe('whole files', () => {
  test('nothing changed, or one side only: that side, byte for byte', () => {
    const ours = edit(BASE, '- [ ] Builds', '- [x] Builds')
    expect(mergeTodo(BASE, BASE, BASE).text).toBe(BASE)
    expect(mergeTodo(BASE, ours, BASE).text).toBe(ours)
    expect(mergeTodo(BASE, BASE, ours).text).toBe(ours)
    expect(mergeTodo(TODO_TEMPLATE, TODO_TEMPLATE, TODO_TEMPLATE).text).toBe(TODO_TEMPLATE)
  })

  test('CRLF files stay CRLF', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const r = mergeTodo(crlf(BASE), crlf(edit(BASE, '- [ ] Builds', '- [x] Builds')), crlf(edit(BASE, '- [ ] Lints', '- [x] Lints')))
    expect(r.text).toBe(crlf(edit(edit(BASE, '- [ ] Builds', '- [x] Builds'), '- [ ] Lints', '- [x] Lints')))
  })

  test('the front matter and prose go through the line merge', () => {
    const ours = edit(BASE, 'plan: keys', 'plan: api-keys')
    const theirs = edit(BASE, '# Tasks: keys', '# Tasks: API keys')
    expect(mergeTodo(BASE, ours, theirs).text).toBe(edit(ours, '# Tasks: keys', '# Tasks: API keys'))
  })
})

describe('mergeFrontMatter: approvals by role', () => {
  const SPEC_BASE = `---
status: draft
created: 2026-10-01
---
# Spec: Keys

## Objective
Keys for the API.
`
  const signed = (approvals: string, status = 'draft', approved?: string) =>
    SPEC_BASE.replace('status: draft', `status: ${status}`).replace('created: 2026-10-01', `created: 2026-10-01\napprovals: ${approvals}${approved ? `\napproved: ${approved}` : ''}`)

  test('signatures from both sides are combined by role, and status is worked out again', () => {
    const ours = signed('product @pm 2026-10-05')
    const theirs = signed('eng @amila 2026-10-06')
    const r = mergeFrontMatter(SPEC_BASE, ours, theirs, { required: ['product', 'eng'] })
    expect(r.conflicts).toEqual([])
    expect(r.text).toBe(signed('product @pm 2026-10-05, eng @amila 2026-10-06', 'approved', '2026-10-06'))
  })

  test('the same role signed on both sides: the earlier signature wins', () => {
    const ours = signed('eng @kim 2026-10-07')
    const theirs = signed('eng @amila 2026-10-06')
    const r = mergeFrontMatter(SPEC_BASE, ours, theirs, { required: ['product', 'eng'] })
    expect(r.text).toBe(signed('eng @amila 2026-10-06'))
    expect(r.conflicts).toEqual([])
  })

  test('not every required role signed: status stays draft', () => {
    const r = mergeFrontMatter(SPEC_BASE, signed('design @sara 2026-10-05'), signed('eng @amila 2026-10-06'), { required: ['product', 'eng', 'design'] })
    expect(r.text).toBe(signed('design @sara 2026-10-05, eng @amila 2026-10-06'))
  })

  test('other keys and prose go through the line merge; a conflict leaves markers', () => {
    const ours = SPEC_BASE.replace('Keys for the API.', 'Keys for the public API.')
    const theirs = SPEC_BASE.replace('created: 2026-10-01', 'created: 2026-10-02')
    expect(mergeFrontMatter(SPEC_BASE, ours, theirs).text).toBe(ours.replace('created: 2026-10-01', 'created: 2026-10-02'))
    const clash = mergeFrontMatter(SPEC_BASE, ours, SPEC_BASE.replace('Keys for the API.', 'Keys for admins.'))
    expect(clash.text).toContain('<<<<<<< ours')
    expect(clash.conflicts).toEqual(['both sides changed the same lines'])
  })

  test('nothing to combine: unchanged bytes', () => {
    const ours = signed('eng @amila 2026-10-06')
    expect(mergeFrontMatter(SPEC_BASE, ours, SPEC_BASE).text).toBe(ours)
    expect(mergeFrontMatter(ours, ours, ours).text).toBe(ours)
  })
})

// ------------------------------------------------------------------ never drops content

/** A small seeded random source, so a failure can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

type GenTask = { id: number; title: string; boxes: [string, boolean][]; status: string; handoffs: string[]; note: string }

const render = (tasks: GenTask[]) =>
  `# Tasks: gen\n\n${tasks
    .map(
      t =>
        `## Task ${t.id}: ${t.title}\n**Status:** ${t.status}\n${t.handoffs.join('\n')}${t.handoffs.length ? '\n' : ''}\n${t.note}\n\n${t.boxes
          .map(([b, x]) => `- [${x ? 'x' : ' '}] ${b}`)
          .join('\n')}\n\n**Dependencies:** ${t.id > 1 ? `T${t.id - 1}` : 'None'}\n`,
    )
    .join('\n')}`

let titles = 0
const fresh = (id: number, r: () => number): GenTask => {
  const n = ++titles
  return {
    id,
    title: `Title ${n}`,
    boxes: Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => [`box ${n}.${i}`, false] as [string, boolean]),
    status: 'todo',
    handoffs: [],
    note: `Note ${n}.`,
  }
}

/** One side's random edits of the base tasks. */
function side(base: GenTask[], r: () => number, nextId: () => number): GenTask[] {
  const out: GenTask[] = []
  for (const t of base) {
    const roll = r()
    if (roll < 0.12) continue // deleted
    const c: GenTask = { ...t, boxes: t.boxes.map(([b, x]) => [b, x]), handoffs: [...t.handoffs] }
    if (r() < 0.4) c.boxes[Math.floor(r() * c.boxes.length)]![1] = true
    if (r() < 0.3) c.status = `in progress · started 2026-10-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`
    if (r() < 0.2) c.handoffs.push(`**Handoff:** 2026-10-${String(1 + Math.floor(r() * 28)).padStart(2, '0')} @a → @b${Math.floor(r() * 99)}: note`)
    if (r() < 0.15) c.note = `${c.note} Edited ${Math.floor(r() * 1e6)}.`
    out.push(c)
  }
  const adds = Math.floor(r() * 3)
  for (let i = 0; i < adds; i++) out.push(fresh(r() < 0.5 ? base.length + 1 : nextId(), r))
  return out
}

describe('never drops content', () => {
  test('every task changed or added on either side is in the result or inside markers, with its boxes and handoffs', () => {
    for (let seed = 1; seed <= 250; seed++) {
      const r = rng(seed)
      let id = 0
      const base = Array.from({ length: 1 + Math.floor(r() * 5) }, () => fresh(++id, r))
      let next = id + 1
      const nextId = () => next++
      const ours = side(base, r, nextId)
      const theirs = side(base, r, nextId)
      const [b, o, t] = [render(base), render(ours), render(theirs)]
      const merged = mergeTodo(b, o, t)
      const baseText = new Map(base.map(x => [x.title, render([x])]))
      const otherHas = (list: GenTask[], title: string) => list.some(x => x.title === title)
      for (const [mine, other] of [
        [ours, theirs],
        [theirs, ours],
      ] as const) {
        for (const task of mine) {
          // Deleted on the other side and untouched here is a clean delete.
          const untouched = baseText.get(task.title) === render([task])
          if (untouched && !otherHas(other, task.title)) continue
          const where = `seed ${seed}: ${task.title}`
          expect(merged.text.includes(`: ${task.title}\n`) ? where : `${where} dropped`).toBe(where)
          for (const [box, ticked] of task.boxes) expect(merged.text.includes(ticked ? `[x] ${box}` : box) ? where : `${where}: ${box} dropped`).toBe(where)
          for (const h of task.handoffs) expect(merged.text.includes(h) ? where : `${where}: handoff dropped`).toBe(where)
        }
      }
      // What the result reports matches what it holds.
      expect(merged.text.includes('<<<<<<<')).toBe(merged.conflicts.length > 0)
      for (const [from, to] of merged.renumbered) expect(merged.text.includes(`## Task ${to.slice(1)}:`) ? from : `${from} → ${to} missing`).toBe(from)
    }
  })
})
