import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SPEC, TODO_TEMPLATE, TODO_T2_DONE, TODO_T3_DONE, TODO_NONE_DONE, PLAN_INDEX, WEAK_SPEC, gitOutput } from './fixtures'

const CWD = '/p'

/** Stands for the engine beneath the mod: a project folder in memory and the UI calls. */
type Git = { log: string; cat: string } | 'no-repo'

function world(on: On, files: Record<string, string>, git: Git = 'no-repo', stored: Record<string, unknown> = {}) {
  const seen = { status: [] as unknown[], opened: [] as string[], toasts: [] as string[], git: [] as string[] }
  on('process.run', (_$, e) => {
    seen.git.push(e.argv.slice(0, 2).join(' '))
    const out = (exitCode: number, stdout: string) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (git === 'no-repo') return out(128, '')
    return out(0, e.argv[1] === 'log' ? git.log : git.cat)
  })
  mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') })
  mock.store(on, stored)
  on('session.cwd', () => ({ value: CWD }))
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('ui.status', (_$, e) => {
    seen.status.push(e)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('tool.call', () => ({ result: 'written' }) as never)
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine intro', scope: 'shared' as const }] }))
  return seen
}

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: ['Read'],
  outputStyle: null,
  traits: [],
} as never

const run = (args: string) =>
  ({
    command: 'progress',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  }) as never

test('write guard refuses a new plan over unfinished tasks', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  const denied = await $.tool.call({ tool: 'Write', file_path: `${CWD}/tasks/todo.md`, content: PLAN_INDEX } as never)
  expect(JSON.stringify(denied)).toMatch(/refused to overwrite .*3 unfinished tasks/)
  expect(JSON.stringify(denied)).toMatch(/\/progress allow-overwrite/)

  const ticked = TODO_TEMPLATE.replace('- [ ] Migration', '- [x] Migration')
  const allowed = await $.tool.call({ tool: 'Write', file_path: `${CWD}/tasks/todo.md`, content: ticked } as never)
  expect(JSON.stringify(allowed)).not.toMatch(/refused/)
})

test('/progress allow-overwrite lets one overwrite through', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  await $.command.run(run('allow-overwrite'))
  const first = await $.tool.call({ tool: 'Write', file_path: `${CWD}/tasks/todo.md`, content: PLAN_INDEX } as never)
  expect(JSON.stringify(first)).not.toMatch(/refused/)
  const second = await $.tool.call({ tool: 'Write', file_path: `${CWD}/tasks/todo.md`, content: PLAN_INDEX } as never)
  expect(JSON.stringify(second)).toMatch(/refused/)
})

test('the overwrite allowance lasts the turn after the command, through subagent turns', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  const write = () =>
    $.tool.call({ tool: 'Write', file_path: `${CWD}/tasks/todo.md`, content: PLAN_INDEX } as never).then(r => JSON.stringify(r))
  const turnEnd = (agentId?: string) =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...(agentId ? { agentId } : {}) } as never)

  // The command answers on its own, so no turn ends between it and the next prompt.
  await $.command.run(run('allow-overwrite'))
  await turnEnd('subagent-1')
  expect(await write()).not.toMatch(/refused/)

  // Unused, it ends with the person's turn.
  await $.command.run(run('allow-overwrite'))
  await turnEnd()
  expect(await write()).toMatch(/refused/)
})

test('an agent edit that finishes a task raises one toast; a stray edit raises none', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  const seen = world(on, files)
  const edit = () => $.tool.call({ tool: 'Edit', file_path: `${CWD}/tasks/todo.md`, old_string: 'a', new_string: 'b' } as never)
  await $.command.run(run('refresh'))
  seen.toasts.length = 0 // the first load's history toast
  files[`${CWD}/tasks/todo.md`] = TODO_T2_DONE
  await edit()
  expect(seen.toasts).toEqual(['♦ Checkpoint reached: After Tasks 1-2 · All tests pass · Review with human before proceeding'])
  await edit()
  expect(seen.toasts.length).toBe(1)
})

test('the spec pane flags weak sections', async ($, on) => {
  world(on, { [`${CWD}/SPEC.md`]: WEAK_SPEC })
  await $.command.run({ command: 'spec-view', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
  const pane = await $.ui.mount({
    plugin: 'agent-skills-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'asm-spec',
    props: { title: 'x', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  expect(await pane.find({ text: /no runnable command line/ })).toBeDefined()
  expect(await pane.find({ text: /no example code block/ })).toBeDefined()
  expect(await pane.find({ text: /1 of 2 success criteria/ })).toBeDefined()
})

test('the system prompt carries the parsed progress as its last section, only where there is a plan', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/SPEC.md`]: SPEC })
  await $.command.run(run('refresh'))
  const { sections } = await $.prompt.compose(COMPOSE)
  const last = sections[sections.length - 1]!
  expect(sections[0]?.id).toBe('intro')
  expect(last.id).toBe('agent-skills-mods:progress')
  expect(last.scope).toBe('session')
  expect(last.text).toMatch(/tasks\/todo\.md: 1\/4 tasks done/)
  expect(last.text).toMatch(/blocked: T3 Issue and revoke keys, chain T3 ← T2/)
})

test('no plan, no section', async ($, on) => {
  world(on, {})
  await $.command.run(run('refresh'))
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(s => s.id)).toEqual(['intro'])
})

test('a prompt about a task reloads the files and focuses the board on it', async ($, on) => {
  const files: Record<string, string> = {}
  const seen = world(on, files)
  await $.command.run(run('refresh'))
  // Written outside the session, so no tool call saw it.
  files[`${CWD}/tasks/todo.md`] = TODO_TEMPLATE
  await $.prompt.submit({ text: 'why is T3 blocked?', wait: false, origin: { kind: 'composer' } } as never)
  expect(seen.opened).toEqual(['asm-board'])
  const board = await $.ui.mount({
    plugin: 'agent-skills-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'asm-board',
    props: { title: 'x', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  expect(await board.find({ text: /› ◌ T3/ })).toBeDefined()

  await $.prompt.submit({ text: 'run the linter', wait: false, origin: { kind: 'composer' } } as never)
  expect(seen.opened).toEqual(['asm-board'])
})

const mountBoard = ($: Parameters<TestBody>[0]) =>
  $.ui.mount({
    plugin: 'agent-skills-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'asm-board',
    props: { title: 'x', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })

test('history is rebuilt from git once, so the first day already has an ETA', async ($, on) => {
  const git = gitOutput([
    ['2026-10-08', TODO_T3_DONE],
    ['2026-10-03', TODO_T2_DONE],
    ['2026-09-29', TODO_NONE_DONE],
    ['2026-09-20', PLAN_INDEX],
  ])
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_T3_DONE }, git)
  await $.command.run(run('refresh'))
  await $.command.run(run('refresh'))
  expect(seen.git).toEqual(['git log', 'git cat-file'])
  expect(seen.toasts).toEqual(['Progress history rebuilt from git: 3 days since 29 Sep'])
  const board = await mountBoard($)
  expect(await board.find({ text: /from 3 tasks in 10 days/ })).toBeDefined()
  expect(await board.find({ text: /History rebuilt from commits of tasks\/todo\.md back to 29 Sep/ })).toBeDefined()
})

test('without git the history starts today and the board says so', async ($, on) => {
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  await $.command.run(run('refresh'))
  expect(seen.toasts).toEqual(['No git history for tasks/todo.md (not a git repository): tracking progress from today'])
  const board = await mountBoard($)
  expect(await board.find({ text: /not enough history/ })).toBeDefined()
  expect(await board.find({ text: /History tracked from 9 Oct: not a git repository/ })).toBeDefined()
})

test('/progress charts draws a Raster per chart on the terminal, the numbers alone elsewhere', async ($, on) => {
  const history = [
    { day: '2026-10-01', done: 0, total: 4, doing: 1, blocked: 1 },
    { day: '2026-10-05', done: 2, total: 4, doing: 0, blocked: 0 },
  ]
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_T3_DONE }, 'no-repo', {
    [`history:${CWD}`]: history,
    [`backfill:${CWD}`]: { source: 'none', reason: 'test', since: '2026-10-01' },
  })
  const reply = await $.command.run(run('charts'))
  expect(JSON.stringify(reply)).toMatch(/Charts opened: 3 days of history/)
  const mount = (surface: 'terminal' | 'desktop', bodyColumns: number) =>
    $.ui.mount({
      plugin: 'agent-skills-mods',
      surface,
      component: 'Pane',
      requestId: 'asm-charts',
      props: { title: 'x', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
    })
  const term = await mount('terminal', 70)
  const up = await term.find({ type: 'Raster', key: 'burnup' })
  expect(up?.props).toMatchObject({ columns: 70, rows: 10 })
  expect((await term.find({ type: 'Raster', key: 'flow' }))?.props).toMatchObject({ columns: 70, rows: 8 })
  expect(await term.find({ text: /^9 Oct: 3 done · 0 in progress/ })).toBeDefined()
  // A resized pane draws charts to its new width.
  await term.redraw({ title: 'x', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never)
  expect((await term.find({ type: 'Raster', key: 'burnup' }))?.props).toMatchObject({ columns: 40 })

  const desk = await mount('desktop', 70)
  expect(await desk.find({ type: 'Raster' })).toBeUndefined()
  expect(await desk.find({ text: /^done 3 \(green\)/ })).toBeDefined()
})

test('charts wait for two days of history', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  const reply = await $.command.run(run('charts'))
  expect(JSON.stringify(reply)).toMatch(/two days of history/)
  const pane = await $.ui.mount({
    plugin: 'agent-skills-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'asm-charts',
    props: { title: 'x', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  expect(await pane.find({ text: /Charts need two days of history\. Tracking since 9 Oct/ })).toBeDefined()
})

test('/progress next answers from the parser and sets the status entry', async ($, on) => {
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/SPEC.md`]: SPEC })
  const out = await $.command.run(run('next'))
  expect(out.text).toMatch(/^Next: T2 Prisma schema for keys/)
  expect(JSON.stringify(seen.status)).toMatch(/spec ♦ awaiting approval · plan 1\/4/)
})

test('writing todo.md opens the board, writing SPEC.md opens the spec pane', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/SPEC.md`]: SPEC }
  const seen = world(on, files)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/tasks/todo.md`, old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/SPEC.md`, content: SPEC } as never)
  expect(seen.opened).toEqual(['asm-board', 'asm-spec'])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`board and spec panes draw on ${surface}`, async ($, on) => {
    world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/SPEC.md`]: SPEC })
    await $.command.run(run(''))

    const pane = (requestId: string) =>
      $.ui.mount({
        plugin: 'agent-skills-mods',
        surface,
        component: 'Pane',
        requestId,
        props: { title: 'x', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
      })

    const board = await pane('asm-board')
    expect(await board.find({ text: /1\/4 done/ })).toBeDefined()
    expect(await board.find({ text: /T2/ })).toBeDefined()
    expect(await board.find({ text: /Checkpoint: After Tasks 1-2/ })).toBeDefined()
    expect(await board.find({ text: /not enough history/ })).toBeDefined()

    const spec = await pane('asm-spec')
    expect(await spec.find({ text: /awaiting approval/ })).toBeDefined()
    expect(await spec.find({ text: /Ask first/ })).toBeDefined()
    expect(await spec.find({ text: /commit secrets/ })).toBeDefined()
  })

  test(`footer shows the stage and task after a build skill loads, on ${surface}`, async ($, on) => {
    world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
    let tail: unknown
    let modes: unknown
    on('ui.render', { component: 'PromptHint' }, ($x, e) => {
      tail = e.props.tail
      return $x.ui.resolve(e).Text({ children: 'x' })
    })
    on('ui.render', { component: 'SessionMode' }, ($x, e) => {
      modes = e.props.modes
      return $x.ui.resolve(e).Text({ children: 'x' })
    })
    await $.command.run(run('refresh'))
    await $.skill.prompt({ skill: 'agent-skills:incremental-implementation', text: 'x' })
    await $.ui.render({ surface, component: 'PromptHint', requestId: 'h', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } })
    await $.ui.render({ surface, component: 'SessionMode', requestId: 'm', props: { modes: ['focus'] } })
    expect(tail).toBe('· build T2')
    expect(modes).toEqual(['focus', 'build'])
  })

  test(`band names the current task on ${surface}`, async ($, on) => {
    world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
    await $.command.run(run('refresh'))
    const band = await $.ui.mount({
      plugin: 'agent-skills-mods',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } as never,
    })
    expect(await band.find({ text: /T2 Prisma schema for keys · 2 criteria left/ })).toBeDefined()
  })
}

test('other skills leave the footer alone', async ($, on) => {
  world(on, {})
  let tail: unknown = 'unset'
  on('ui.render', { component: 'PromptHint' }, ($x, e) => {
    tail = e.props.tail
    return $x.ui.resolve(e).Text({ children: 'x' })
  })
  await $.skill.prompt({ skill: 'some-other-skill', text: 'x' })
  await $.ui.render({ surface: 'terminal', component: 'PromptHint', requestId: 'h', props: { isDraft: false, isWorking: false, hint: '?' } })
  expect(tail).toBe(undefined)
})
