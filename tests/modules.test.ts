import { describe, expect, test } from 'claude-code/testing'

import { moduleRows, modulesText, parseCapabilityMap } from '../packages/core/modules'
import { moduleTimeline } from '../packages/core/module-timeline'
import { parseSpec } from '../packages/core/parse'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'

// format-v2 T10 (F7): every module of the capability map at a glance, archived plans included.

const MAP = `---
status: approved
created: 2026-10-10
approved: 2026-10-10
---
# Capability Map: agent-skills-mods as a team tool

Intro.

| Module id | Responsibility | Depends on |
|---|---|---|
| core | Shared library and \`state.json\` | — |
| dashboard | The dashboard page | core |
| format-v2 | Owners, review, approvals | core, dashboard |
| team-view | Board across branches | format-v2, dashboard |

Build order: core → dashboard → format-v2 → team-view
`
const spec = (status: 'approved' | 'draft', approved?: string) => `---\nstatus: ${status}\ncreated: 2026-10-01\n${approved ? `approved: ${approved}\n` : ''}---\n# Spec: x\n`
const tasks = (n: number, done: number, fm: string) =>
  `---\n${fm}\n---\n# Tasks\n\n${Array.from({ length: n }, (_, i) => `## Task ${i + 1}: Step ${i + 1}\n**Status:** ${i < done ? `done · started 2026-10-0${1 + (i % 8)} · done 2026-10-0${2 + (i % 8)}` : 'todo'}\n- [${i < done ? 'x' : ' '}] work\n`).join('\n')}`

const ARCHIVED = tasks(14, 14, 'plan: core-dashboard\ncreated: 2026-10-01')
const ACTIVE = tasks(13, 9, 'plan: format-v2\nmodule: format-v2\ncreated: 2026-10-10')

describe('the capability map (T10)', () => {
  test('one row per module: id, responsibility, what it depends on', () => {
    expect(parseCapabilityMap(MAP)).toEqual([
      { id: 'core', responsibility: 'Shared library and `state.json`', dependsOn: [] },
      { id: 'dashboard', responsibility: 'The dashboard page', dependsOn: ['core'] },
      { id: 'format-v2', responsibility: 'Owners, review, approvals', dependsOn: ['core', 'dashboard'] },
      { id: 'team-view', responsibility: 'Board across branches', dependsOn: ['format-v2', 'dashboard'] },
    ])
    expect(parseCapabilityMap('# Spec: API keys\n\nNo map here.\n')).toBeNull()
  })

  test('each module with its spec and its plans, active or archived', () => {
    const rows = moduleRows(parseCapabilityMap(MAP)!, [
      { file: 'SPEC-core.md', spec: parseSpec(spec('approved', '2026-10-01')) },
      { file: 'SPEC-dashboard.md', spec: parseSpec(spec('approved', '2026-10-02')) },
      { file: 'SPEC-format-v2.md', spec: parseSpec(spec('approved', '2026-10-10')) },
    ], [
      { where: 'archive', dir: 'tasks/archive/2026-10-10-core-dashboard', text: ARCHIVED },
      { where: 'active', dir: 'tasks', text: ACTIVE },
    ])
    expect(rows.map(r => [r.id, r.state, `${r.done}/${r.total}`, r.spec?.status ?? null])).toEqual([
      ['core', 'done', '14/14', 'approved'],
      ['dashboard', 'done', '14/14', 'approved'],
      ['format-v2', 'building', '9/13', 'approved'],
      ['team-view', 'not started', '0/0', null],
    ])
    expect(rows[0]!.plans).toEqual([{ where: 'archive', dir: 'tasks/archive/2026-10-10-core-dashboard', name: 'core-dashboard', done: 14, total: 14, started: '2026-10-01', finished: '2026-10-09' }])
    expect(rows[2]!.plans[0]).toMatchObject({ where: 'active', name: 'format-v2', started: '2026-10-10' })
  })

  test('a spec without a plan is speccing, or ready to plan once approved; a plan with nothing done is planned', () => {
    const map = parseCapabilityMap(MAP)!
    const rows = moduleRows(map, [{ file: 'SPEC-core.md', spec: parseSpec(spec('draft')) }, { file: 'SPEC-dashboard.md', spec: parseSpec(spec('approved', '2026-10-02')) }], [{ where: 'active', dir: 'tasks', text: tasks(3, 0, 'plan: format-v2\nmodule: format-v2\ncreated: 2026-10-10') }])
    expect(rows.map(r => r.state)).toEqual(['speccing', 'ready to plan', 'planned', 'not started'])
  })

  test('/progress modules: a line per module, in map order', () => {
    const rows = moduleRows(parseCapabilityMap(MAP)!, [{ file: 'SPEC-core.md', spec: parseSpec(spec('approved', '2026-10-01')) }], [{ where: 'archive', dir: 'tasks/archive/2026-10-10-core-dashboard', text: ARCHIVED }, { where: 'active', dir: 'tasks', text: ACTIVE }])
    expect(modulesText(rows, 'SPEC.md')).toBe(`Modules · SPEC.md · 4 modules · 2 done
  ✓ core        done · 14/14 · spec approved 1 Oct · finished 9 Oct (tasks/archive/2026-10-10-core-dashboard)
  ✓ dashboard   done · 14/14 · no spec file · finished 9 Oct (tasks/archive/2026-10-10-core-dashboard)
  ● format-v2   building · 9/13 · no spec file · started 10 Oct
  ○ team-view   not started · needs format-v2, dashboard
/progress modules <id> shows one module's run timeline.`)
  })
})

describe('modules in State v1 (T10)', () => {
  const io = (files: Record<string, string>): ProjectIo => ({
    cwd: '/p',
    now: Date.parse('2026-10-10T10:00:00Z'),
    read: async r => files[r] ?? null,
    list: async r => Object.keys(files).filter(f => (r ? f.startsWith(`${r}/`) && !f.slice(r.length + 1).includes('/') : !f.includes('/'))).map(f => f.split('/').pop()!),
    dirs: async r => [...new Set(Object.keys(files).filter(f => f.startsWith(`${r}/`) && f.slice(r.length + 1).includes('/')).map(f => f.slice(r.length + 1).split('/')[0]!))],
  })

  test('buildState reads the map, the specs, the active plan and the archive', async () => {
    const s = await buildState(io({ 'SPEC.md': MAP, 'SPEC-core.md': spec('approved', '2026-10-01'), 'tasks/todo.md': ACTIVE, 'tasks/archive/2026-10-10-core-dashboard/todo.md': ARCHIVED, 'tasks/archive/2026-10-10-core-dashboard/README.md': '# x\n' }))
    expect(s.modules?.map(m => [m.id, m.state])).toEqual([['core', 'done'], ['dashboard', 'done'], ['format-v2', 'building'], ['team-view', 'not started']])
    expect(stateJson(s).modules?.[0]).toMatchObject({ id: 'core', state: 'done', done: 14, total: 14 })
  })

  test('no capability map: no modules', async () => {
    const s = await buildState(io({ 'tasks/todo.md': ACTIVE }))
    expect([s.modules, stateJson(s).modules]).toEqual([null, null])
  })
})

describe('one module\'s run timeline (T11)', () => {
  const map = parseCapabilityMap(MAP)!
  const plans = [{ where: 'archive' as const, dir: 'tasks/archive/2026-10-10-core-dashboard', text: ARCHIVED }, { where: 'active' as const, dir: 'tasks', text: ACTIVE }]
  const history = JSON.stringify([{ day: '2026-10-01', done: 0, total: 14 }, { day: '2026-10-09', done: 14, total: 14 }])

  test('an archived module prints its plan as /progress timeline would, with its done dates', () => {
    const rows = moduleRows(map, [], plans)
    const out = moduleTimeline(rows, 'dashboard', { 'tasks/archive/2026-10-10-core-dashboard/todo.md': ARCHIVED, 'tasks/archive/2026-10-10-core-dashboard/history.json': history }, '2026-10-10')
    const lines = out.split('\n')
    expect(lines[0]).toBe('Module dashboard · done · 14/14 · plan core-dashboard in tasks/archive/2026-10-10-core-dashboard')
    expect(out).toMatch(/✓ T1 Step 1 +▬▬▬ done 2 Oct/)
    expect(out).toMatch(/✓ T14 Step 14 +▬▬▬ done 7 Oct/)
  })

  test('the active module prints its own plan; an unknown id lists the modules; a module without a plan says so', () => {
    const rows = moduleRows(map, [], plans)
    expect(moduleTimeline(rows, 'format-v2', { 'tasks/todo.md': ACTIVE }, '2026-10-10').split('\n')[0]).toBe('Module format-v2 · building · 9/13 · plan format-v2 in tasks/todo.md')
    expect(moduleTimeline(rows, 'nope', {}, '2026-10-10')).toBe('No module "nope". Modules: core, dashboard, format-v2, team-view.')
    expect(moduleTimeline(rows, 'team-view', {}, '2026-10-10')).toBe('team-view has no plan yet (not started; needs format-v2, dashboard).')
  })
})
