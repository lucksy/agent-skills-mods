import { describe, expect, test } from 'claude-code/testing'

import { runAction, type ActionInput } from '../packages/core/actions'
import { addBacklogItem, backlogText, deferTask, nextBacklogId, nextTaskNumber } from '../packages/core/backlog'
import { diagnose } from '../packages/core/doctor'
import { FORMAT_RULES, parseWasLine } from '../packages/core/format'
import { parseBacklog, parseTasks } from '../packages/core/parse'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'
import { TODO_NONE_DONE, TODO_TEMPLATE } from './fixtures'

// ceremonies T3: tasks/backlog.md holds work that isn't scheduled yet, in the
// task shape with B ids, and a `**Was:**` line for a task deferred from todo.md.

export const BACKLOG = `---
backlog: gateway
---
# Backlog

## B3: Per-tenant quotas
**Size:** L
- [ ] Quota per tenant in the config
- [ ] Verify: pnpm --filter gateway test

**Dependencies:** T2

## B4: Audit log export
**Was:** T9 · deferred 2026-10-14 @amila
- [ ] CSV export of the audit log
`

function input(over: Partial<ActionInput> = {}): ActionInput {
  const todo = over.todo === undefined ? TODO_TEMPLATE : over.todo
  return { todo, plan: null, spec: null, list: todo === null ? null : parseTasks(todo), today: '2026-10-11', team: null, email: null, pending: {}, keepFormat: true, backlog: null, ...over }
}

describe('reading tasks/backlog.md (T3)', () => {
  test('items in the task shape: B ids, boxes, size, dependencies and the Was line', () => {
    const b = parseBacklog(BACKLOG)
    expect(b.meta).toEqual({ backlog: 'gateway' })
    expect(b.items.map(i => [i.id, i.title, i.size, i.deps, i.boxes.length])).toEqual([
      ['B3', 'Per-tenant quotas', 'L', ['T2'], 2],
      ['B4', 'Audit log export', undefined, [], 1],
    ])
    expect(b.items[1]!.was).toEqual({ id: 'T9', day: '2026-10-14', by: '@amila' })
    expect(b.items[0]!.was).toBeUndefined()
  })

  test('the Was line alone, with or without its date and who', () => {
    expect(parseWasLine('**Was:** T9 · deferred 2026-10-14 @amila')).toEqual({ id: 'T9', day: '2026-10-14', by: '@amila' })
    expect(parseWasLine('**Was:** T12')).toEqual({ id: 'T12', day: null, by: null })
    expect(parseWasLine('**Was:** B2')).toBeNull()
    expect(parseWasLine('**Status:** todo')).toBeNull()
  })

  test('the next B id follows the highest; an empty or missing backlog starts at B1', () => {
    expect(nextBacklogId(BACKLOG)).toBe('B5')
    expect(nextBacklogId(null)).toBe('B1')
    expect(nextBacklogId('# Backlog\n')).toBe('B1')
  })

  test('/progress backlog lists the items with their sizes and points', () => {
    expect(backlogText(parseBacklog(BACKLOG))).toBe(
      ['Backlog · tasks/backlog.md · 2 items, 3 points', '  B3  Per-tenant quotas  L', '  B4  Audit log export   no size · was T9'].join('\n'),
    )
    expect(backlogText(null)).toBe('No tasks/backlog.md here. /progress backlog add "title" [S|M|L] starts one.')
    expect(backlogText(parseBacklog('# Backlog\n'))).toBe('tasks/backlog.md has no items. /progress backlog add "title" [S|M|L] adds one.')
  })
})

describe('backlog add (T3)', () => {
  test('appends the next B id, with its size, and keeps every other byte', () => {
    const r = addBacklogItem(BACKLOG, 'Rate-limit dashboard', 'M', 'gateway')
    expect(r).toEqual({ id: 'B5', text: `${BACKLOG}\n## B5: Rate-limit dashboard\n**Size:** M\n` })
    expect(addBacklogItem(BACKLOG.trimEnd(), 'Docs', null, 'gateway').text).toBe(`${BACKLOG.trimEnd()}\n\n## B5: Docs\n`)
  })

  test('creates the file, with its front matter, when it is missing', () => {
    expect(addBacklogItem(null, 'Per-tenant quotas', 'L', 'gateway')).toEqual({ id: 'B1', text: '---\nbacklog: gateway\n---\n# Backlog\n\n## B1: Per-tenant quotas\n**Size:** L\n' })
  })

  test('the action: written to tasks/backlog.md, and said', () => {
    const made = runAction('backlog-add', { title: 'Per-tenant quotas', size: 'l' }, input())
    expect(made).toEqual({ ok: true, reply: 'Started tasks/backlog.md with B1 Per-tenant quotas (L).', writes: [{ file: 'tasks/backlog.md', text: '---\nbacklog: api-keys\n---\n# Backlog\n\n## B1: Per-tenant quotas\n**Size:** L\n' }] })
    const added = runAction('backlog-add', { title: ' Audit\nlog export ' }, input({ backlog: BACKLOG }))
    expect(added.reply).toBe('Added B5 Audit log export to tasks/backlog.md (no size: it counts as 1 point).')
    expect(added.writes).toEqual([{ file: 'tasks/backlog.md', text: `${BACKLOG}\n## B5: Audit log export\n` }])
  })

  test('the action refuses no title and a bad size, and writes nothing', () => {
    expect(runAction('backlog-add', { title: '  ' }, input())).toEqual({ ok: false, reply: 'Say what it is: /progress backlog add "Per-tenant quotas" [S|M|L].', writes: [] })
    expect(runAction('backlog-add', { title: 'Docs', size: 'XL' }, input())).toEqual({ ok: false, reply: '"XL" is not a size. Use S, M or L: /progress backlog add "Docs" M.', writes: [] })
  })

  test('without tasks/todo.md it still works: the backlog comes first sometimes', () => {
    expect(runAction('backlog-add', { title: 'Docs' }, input({ todo: null })).writes[0]!.text).toBe('---\nbacklog: plan\n---\n# Backlog\n\n## B1: Docs\n')
  })
})

test('the rules Claude is told describe the backlog and its Was line (T3)', () => {
  expect(FORMAT_RULES).toContain('`## B<N>: title`')
  expect(FORMAT_RULES).toContain('**Was:** T9 · deferred YYYY-MM-DD @handle')
})

describe('doctor and --json (T3)', () => {
  const doctor = (backlog: string | null, todo: string | null = null) => diagnose({ todo, plan: null, specs: [], today: '2026-10-11', keepFormat: false, backlog }).filter(f => f.file === 'tasks/backlog.md')

  test('duplicate B ids and duplicate Was numbers are errors; a good backlog has none', () => {
    expect(doctor(BACKLOG)).toEqual([])
    const bad = `${BACKLOG}\n## B3: Again\n**Was:** T9\n- [ ] x\n`
    expect(doctor(bad).map(f => f.message)).toEqual(['B3 is used by 2 items; give each item its own number', 'T9 is the old number of 2 items (B4, B3); a deferred number belongs to one task'])
    expect(doctor(null)).toEqual([])
  })

  test('a Was number tasks/todo.md uses again is an error', () => {
    const todo = `${TODO_TEMPLATE}\n## Task 9: Reused\n- [ ] x\n`
    expect(doctor(BACKLOG, todo).map(f => f.message)).toEqual(['B4 was T9, and tasks/todo.md has a T9 too; one of them needs a new number'])
  })

  const io = (files: Record<string, string>): ProjectIo => ({
    cwd: '/p',
    now: Date.parse('2026-10-11T10:00:00Z'),
    read: async rel => files[rel] ?? null,
    list: async () => [],
  })

  test('--json has the backlog when there is one, and no backlog key when there is none', async () => {
    const json = stateJson(await buildState(io({ 'tasks/todo.md': TODO_TEMPLATE, 'tasks/backlog.md': BACKLOG })))
    expect(json.backlog).toEqual({
      file: 'tasks/backlog.md',
      points: 3,
      items: [
        { id: 'B3', title: 'Per-tenant quotas', size: 'L', was: null, deps: ['T2'], open: ['Quota per tenant in the config', 'Verify: pnpm --filter gateway test'] },
        { id: 'B4', title: 'Audit log export', size: null, was: { id: 'T9', day: '2026-10-14', by: '@amila' }, deps: [], open: ['CSV export of the audit log'] },
      ],
    })
    expect('backlog' in stateJson(await buildState(io({ 'tasks/todo.md': TODO_TEMPLATE })))).toBe(false)
  })
})

// ceremonies T4: pull and defer move a task between tasks/todo.md and tasks/backlog.md.
describe('pull and defer (T4)', () => {
  const NOTED = TODO_TEMPLATE.replace(
    '## Task 4: Rate limit per key\n',
    '## Task 4: Rate limit per key\n**Status:** todo · @sara\n**Size:** L\n**Handoff:** 2026-10-10 @amila → @sara: limits agreed with product\n\n**Description:** Sliding window per key.\n',
  )
  const both = (r: ReturnType<typeof runAction>) => Object.fromEntries(r.writes.map(w => [w.file, w.text]))

  test('defer then pull round-trips a task with its boxes, size, handoff and notes', () => {
    const deferred = runAction('defer', { id: 'T4' }, input({ todo: NOTED }))
    expect(deferred.reply).toBe('T4 Rate limit per key is deferred: it is B1 in tasks/backlog.md now, and /progress pull B1 brings it back as T4.')
    const d = both(deferred)
    expect(d['tasks/todo.md']).toBe(NOTED.slice(0, NOTED.indexOf('## Task 4:')).replace(/\n+$/, '\n'))
    expect(d['tasks/backlog.md']).toBe(
      '---\nbacklog: api-keys\n---\n# Backlog\n\n## B1: Rate limit per key\n**Was:** T4 · deferred 2026-10-11\n**Size:** L\n**Handoff:** 2026-10-10 @amila → @sara: limits agreed with product\n\n**Description:** Sliding window per key.\n\n**Acceptance criteria:**\n- [ ] 60 requests per minute by default\n\n**Dependencies:** 1\n',
    )
    const item = parseBacklog(d['tasks/backlog.md']!).items[0]!
    expect([item.size, item.was?.id, item.boxes.map(b => b.text), item.handoffs?.length]).toEqual(['L', 'T4', ['60 requests per minute by default'], 1])

    const pulled = runAction('pull', { id: 'b1' }, input({ todo: d['tasks/todo.md']!, backlog: d['tasks/backlog.md']! }))
    expect(pulled.reply).toBe('B1 Rate limit per key is T4 in tasks/todo.md now, its old number, after the last task.')
    const p = both(pulled)
    // Back as it was, its Status line a plain todo again.
    expect(p['tasks/todo.md']).toBe(NOTED.replace('**Status:** todo · @sara\n', '**Status:** todo\n'))
    expect(p['tasks/backlog.md']).toBe('---\nbacklog: api-keys\n---\n# Backlog\n')
  })

  test('a deferred number is never given to another task: pull and the next free number count Was lines', () => {
    const todo = TODO_TEMPLATE.slice(0, TODO_TEMPLATE.indexOf('## Task 4:'))
    const backlog = '# Backlog\n\n## B1: Rate limit per key\n**Was:** T4 · deferred 2026-10-11\n- [ ] 60 rpm\n\n## B2: Quotas\n- [ ] per tenant\n'
    expect(nextTaskNumber(todo, backlog)).toBe(5)
    expect(nextTaskNumber(todo, null)).toBe(4)
    const r = runAction('pull', { id: 'B2' }, input({ todo, backlog }))
    expect(r.reply).toBe('B2 Quotas is T5 in tasks/todo.md now, after the last task.')
    expect(parseTasks(both(r)['tasks/todo.md']!).tasks.map(t => t.id)).toEqual(['T1', 'T2', 'T3', 'T5'])
  })

  test('a pulled task goes after the last task, before a checkpoint that follows it', () => {
    const todo = `${TODO_TEMPLATE}\n## Checkpoint: Complete\n- [ ] Review\n`
    const r = runAction('pull', { id: 'B3' }, input({ todo, backlog: BACKLOG }))
    expect(both(r)['tasks/todo.md']).toContain('**Dependencies:** 1\n\n## Task 10: Per-tenant quotas\n**Status:** todo\n**Size:** L\n- [ ] Quota per tenant in the config\n- [ ] Verify: pnpm --filter gateway test\n\n**Dependencies:** T2\n\n## Checkpoint: Complete\n')
    // B4's Was number T9 stays reserved, so B3 takes T10; the rest of the backlog stays byte for byte.
    expect(both(r)['tasks/backlog.md']).toBe(BACKLOG.replace(/## B3:[\s\S]*?(?=## B4)/, ''))
  })

  test('an old number taken since is not taken twice: the next free one instead', () => {
    const todo = `${TODO_TEMPLATE}\n## Task 9: Reused\n- [ ] x\n`
    expect(runAction('pull', { id: 'B4' }, input({ todo, backlog: BACKLOG })).reply).toBe('B4 Audit log export is T10 in tasks/todo.md now, after the last task.')
  })

  test('defer refuses a task started, in review or done, or one others depend on, and names them', () => {
    const r = (id: string, todo: string) => runAction('defer', { id }, input({ todo })).reply
    expect(r('T1', TODO_TEMPLATE)).toBe('T1 Monorepo scaffold is done: only a task not yet started goes back to the backlog.')
    expect(r('T2', TODO_TEMPLATE)).toBe('T2 Prisma schema for keys is started: only a task not yet started goes back to the backlog.')
    expect(r('T4', TODO_TEMPLATE.replace('## Task 4: Rate limit per key\n', '## Task 4: Rate limit per key\n**Status:** in review · PR #4\n'))).toBe('T4 Rate limit per key is in review: only a task not yet started goes back to the backlog.')
    expect(r('T2', TODO_NONE_DONE)).toBe("T2 Prisma schema for keys can't be deferred: T3 depends on it. Defer it first, or change its Dependencies line.")
    expect(r('T1', TODO_NONE_DONE)).toBe("T1 Monorepo scaffold can't be deferred: T2 and T4 depend on it. Defer them first, or change their Dependencies lines.")
    expect(r('T9', TODO_TEMPLATE)).toBe('No "## Task 9:" section in tasks/todo.md. Tasks: T1, T2, T3, T4.')
  })

  test('pull refuses an unknown item, a dependency tasks/todo.md lacks, and no backlog', () => {
    expect(runAction('pull', { id: 'B9' }, input({ backlog: BACKLOG })).reply).toBe('No B9 in tasks/backlog.md. Items: B3, B4.')
    const deps = BACKLOG.replace('**Dependencies:** T2', '**Dependencies:** T2, T12, T14')
    expect(runAction('pull', { id: 'B3' }, input({ backlog: deps })).reply).toBe("B3 depends on T12 and T14, which are not in tasks/todo.md. Pull or add them first, or change B3's Dependencies line.")
    expect(runAction('pull', { id: 'B3' }, input()).reply).toBe('No tasks/backlog.md here, so there is nothing to pull. /progress backlog add "title" starts one.')
    expect(runAction('pull', {}, input()).reply).toBe('Say which item: /progress pull B3.')
  })

  test('defer takes the task\'s line out of an index too, so it doesn\'t come back from there', () => {
    const todo = '# Tasks\n\n- [x] Task 1: A\n- [ ] Task 2: B\n\n## Task 1: A\n- [x] a\n\n## Task 2: B\n- [ ] b\n'
    const r = deferTask(todo, null, 'T2', '@amila', '2026-10-11', 'x')
    expect(r.ok && r.todo).toBe('# Tasks\n\n- [x] Task 1: A\n\n## Task 1: A\n- [x] a\n')
    expect(r.ok && r.backlog).toContain('## B1: B\n**Was:** T2 · deferred 2026-10-11 @amila\n- [ ] b\n')
  })

  test('the rules Claude is told: the next free number counts Was lines', () => {
    expect(FORMAT_RULES).toContain('The next free task number counts those `Was:` numbers as well')
  })
})
