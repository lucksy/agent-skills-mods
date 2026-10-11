import { describe, expect, test } from 'claude-code/testing'

import { runAction, type ActionInput } from '../packages/core/actions'
import { addBacklogItem, backlogText, nextBacklogId } from '../packages/core/backlog'
import { diagnose } from '../packages/core/doctor'
import { FORMAT_RULES, parseWasLine } from '../packages/core/format'
import { parseBacklog, parseTasks } from '../packages/core/parse'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'
import { TODO_TEMPLATE } from './fixtures'

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
