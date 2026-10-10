import { describe, expect, test } from 'claude-code/testing'

import { dashboardHtml } from '../packages/core/dashboard/page'
import { renderTimelineCli } from '../packages/core/cli'
import { buildState, type ProjectIo } from '../packages/core/state'
import { SPEC, TODO_TEMPLATE } from './fixtures'

// The Roadmap (K3): what is the path to done? The run timeline, the dependency
// tree and the critical path, the same as the plan pane and the CLI draw them.

const NOW = Date.parse('2026-10-09T10:00:00Z')
const io = (files: Record<string, string>): ProjectIo => ({
  cwd: '/work/keys',
  now: NOW,
  read: async rel => files[rel] ?? null,
  list: async rel => Object.keys(files).filter(f => (rel ? f.startsWith(`${rel}/`) && !f.slice(rel.length + 1).includes('/') : !f.includes('/'))).map(f => f.split('/').pop()!),
})
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const section = (html: string) => html.match(/<section[^>]*id="view-roadmap"[\s\S]*?<\/section>\s*<!-- \/view-roadmap -->/)?.[0] ?? ''
const roadmap = async (files: Record<string, string>) => section(dashboardHtml(await buildState(io(files))))
/** The rows of one block, as text. */
const rows = (html: string, cls: string) => [...html.matchAll(new RegExp(`<div class="${cls}-row[^"]*"[^>]*>([\\s\\S]*?)</div>`, 'g'))].map(m => text(m[1]!))

describe('Roadmap (K3)', () => {
  test('the run timeline, row for row as the CLI prints it', async () => {
    const files = { 'SPEC.md': SPEC, 'tasks/todo.md': TODO_TEMPLATE }
    const s = await buildState(io(files))
    const cli = renderTimelineCli(s, { color: false, width: 100 }).split('\n').map(l => l.replace(/^ {2}/, ''))
    const html = await roadmap(files)
    const tl = rows(html, 'tl')
    expect(tl.length).toBeGreaterThan(4)
    for (const r of tl) expect(cli).toContain(r)
    expect(tl.some(r => /├─ ✓ T1 Monorepo scaffold +▬▬▬ done/.test(r))).toBe(true)
  })

  test('each segment keeps its tone as a class, so colour follows the plan pane', async () => {
    const html = await roadmap({ 'tasks/todo.md': TODO_TEMPLATE })
    expect(html).toMatch(/<span class="t-done">▬▬▬<\/span>/)
    expect(html).toMatch(/<span class="t-strong">[^<]*T2/)
  })

  test('the dependency tree lists every task once, and a loop is named', async () => {
    const html = await roadmap({ 'tasks/todo.md': TODO_TEMPLATE })
    const tree = rows(html, 'dep').join('\n')
    for (const id of ['T1', 'T2', 'T3', 'T4']) expect(tree).toContain(id)
    expect(tree).toMatch(/✓ T1 Monorepo scaffold\n├─▶ ◐ T2 Prisma schema for keys\n│ {3}└─▶ · T3 Issue and revoke keys\n└─▶ ○ T4 Rate limit per key/)

    const loop = '## Task 1: A\n- [ ] a\n**Dependencies:** T2\n\n## Task 2: B\n- [ ] b\n**Dependencies:** T1\n'
    expect(rows(await roadmap({ 'tasks/todo.md': loop }), 'dep').join('\n')).toContain('In a dependency loop: T1, T2')
  })

  test('the critical path in words, and its tasks marked in the tree', async () => {
    const html = await roadmap({ 'tasks/todo.md': TODO_TEMPLATE })
    expect(text(html)).toMatch(/Critical path T2 → T3 · 2 open tasks set the finish date/)
    const marked = [...html.matchAll(/<div class="dep-row crit">([\s\S]*?)<\/div>/g)].map(m => text(m[1]!))
    expect(marked).toEqual(['├─▶ ◐ T2 Prisma schema for keys', '│   └─▶ · T3 Issue and revoke keys'])
    // A task with two parents: the row pointing back to it is not marked.
    const two = `${TODO_TEMPLATE}\n## Task 5: Usage\n- [ ] usage\n**Dependencies:** T3, T4\n`
    const twoHtml = await roadmap({ 'tasks/todo.md': two })
    expect([...twoHtml.matchAll(/<div class="dep-row crit">([\s\S]*?)<\/div>/g)].map(m => text(m[1]!).trim())).toEqual(['├─▶ ◐ T2 Prisma schema for keys', '│   └─▶ · T3 Issue and revoke keys', '│       └─▶ · T5 Usage'])
    expect(rows(twoHtml, 'dep').some(r => r.includes('T5 (drawn above)'))).toBe(true)
    const done = TODO_TEMPLATE.replace(/- \[ \]/g, '- [x]')
    expect(text(await roadmap({ 'tasks/todo.md': done }))).toContain('Every task is done: nothing left on the critical path.')
  })

  test('markdown text is escaped; an empty project gets a message', async () => {
    const hostile = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys', '## Task 2: <img src=x onerror=alert(1)>')
    const html = await roadmap({ 'tasks/todo.md': hostile })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(text(await roadmap({}))).toContain('No task list yet')
  })
})
