import { describe, expect, test } from 'claude-code/testing'

import { buildState, stateJson, toState, type ProjectIo } from '../packages/core/state'
import { renderJson } from '../packages/core/cli'
import { GOOD_SPEC, SPEC, TODO_T2_DONE, TODO_T3_DONE, TODO_NONE_DONE, TODO_TEMPLATE, gitOutput } from './fixtures'

// State v1 (J2): the one shape every surface reads, built the same way from the
// plugin's parts and from the CLI's file reads.

const NOW = Date.parse('2026-10-09T10:00:00Z')
const io = (files: Record<string, string>, run?: ProjectIo['run']): ProjectIo => ({
  cwd: '/work/keys',
  now: NOW,
  read: async rel => files[rel] ?? null,
  list: async rel => Object.keys(files).filter(f => (rel ? f.startsWith(`${rel}/`) && !f.slice(rel.length + 1).includes('/') : !f.includes('/'))).map(f => f.split('/').pop()!),
  run,
})
const git = (copies: [string, string | null][]): ProjectIo['run'] => {
  const out = gitOutput(copies)
  return async (argv, opts) => ({ exitCode: 0, stdout: argv[1] === 'log' ? (argv.some(a => a.includes('%B')) ? '' : out.log) : out.answer(argv, opts?.stdin), stderr: '' })
}
const HISTORY = git([['2026-10-08', TODO_T3_DONE], ['2026-10-03', TODO_T2_DONE], ['2026-09-29', TODO_NONE_DONE]])

describe('State v1 (J2)', () => {
  test('buildState reads every spec file, the task list and the history, as schema 1', async () => {
    const s = await buildState(io({ 'SPEC.md': SPEC, 'SPEC-auth.md': GOOD_SPEC, 'tasks/todo.md': TODO_T3_DONE }, HISTORY))
    expect(s.schema).toBe(1)
    expect(s.today).toBe('2026-10-09')
    expect(s.specs.map(x => [x.file, x.spec.title])).toEqual([
      ['SPEC.md', 'API keys'],
      ['SPEC-auth.md', 'Rate limits'],
    ])
    expect(s.specFile).toBe('SPEC.md')
    expect(s.spec?.title).toBe('API keys')
    expect([s.list?.done, s.list?.total, s.list?.current?.id]).toEqual([3, 4, 'T4'])
    expect(s.forecast?.kind).toBe('range')
    expect(s.snapshots.length).toBeGreaterThan(1)
    expect(s.needsYou).toContain('approve SPEC.md')
    expect(Array.isArray(s.alerts)).toBe(true)
  })

  test('the spec in focus can be any of them', async () => {
    const s = await buildState(io({ 'SPEC.md': SPEC, 'specs/limits.md': GOOD_SPEC, 'tasks/todo.md': TODO_TEMPLATE }), { specFile: 'specs/limits.md' })
    expect(s.specFile).toBe('specs/limits.md')
    expect(s.spec?.title).toBe('Rate limits')
    expect(s.specs.map(x => x.file)).toEqual(['SPEC.md', 'specs/limits.md'])
  })

  test('toState from the same parts gives the same state: the plugin and the CLI agree', async () => {
    const s = await buildState(io({ 'SPEC.md': SPEC, 'tasks/todo.md': TODO_T3_DONE }, HISTORY))
    const again = toState({
      cwd: s.cwd,
      today: s.today,
      specs: s.specs,
      specFile: s.specFile,
      list: s.list,
      listFile: s.listFile,
      plan: s.plan,
      forecast: s.forecast,
      snapshots: s.snapshots,
      dates: s.dates,
      history: s.history,
      commits: s.commits,
    })
    expect(again).toEqual(s)
  })

  test('an empty folder is a state too', async () => {
    const s = await buildState(io({}))
    expect([s.schema, s.spec, s.list, s.specs, s.needsYou, s.alerts]).toEqual([1, null, null, [], [], []])
  })
})

describe('the JSON contract (J3)', () => {
  test('--json prints State v1 and keeps every field it printed before', async () => {
    const s = await buildState(io({ 'specs/limits.md': GOOD_SPEC, 'tasks/todo.md': TODO_TEMPLATE }), { specFile: 'specs/limits.md' })
    const json = JSON.parse(renderJson(s))
    // Fields printed before State v1.
    expect(Object.keys(json)).toEqual(expect.arrayContaining(['cwd', 'spec', 'tasks', 'forecast', 'needsYou', 'history']))
    expect(Object.keys(json.spec)).toEqual(expect.arrayContaining(['file', 'title', 'approval', 'areas', 'openQuestions']))
    expect(Object.keys(json.tasks)).toEqual(expect.arrayContaining(['file', 'done', 'total', 'current', 'items']))
    expect(Object.keys(json.tasks.items[0])).toEqual(expect.arrayContaining(['id', 'title', 'phase', 'status', 'deps', 'open', 'date']))
    // Added by State v1.
    expect(json).toMatchObject({ schema: 1, today: '2026-10-09', specs: [{ file: 'specs/limits.md', title: 'Rate limits' }] })
    expect(Object.keys(json)).toEqual(expect.arrayContaining(['alerts', 'snapshots', 'plan']))
    expect(json).toEqual(JSON.parse(JSON.stringify(stateJson(s))))
  })

  test('each task carries its Status line state, why it is blocked and its checkpoint', async () => {
    const todo = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · started 2026-10-07 · step test\n')
    const json = stateJson(await buildState(io({ 'tasks/todo.md': todo })))
    const t2 = json.tasks!.items.find(t => t.id === 'T2')!
    expect(t2.state).toMatchObject({ status: 'in progress', started: '2026-10-07', step: 'test' })
    expect(t2.checkpoint).toMatchObject({ title: 'After Tasks 1-2', open: ['All tests pass', 'Review with human before proceeding'] })
  })
})
