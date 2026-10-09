import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SPEC, TODO_TEMPLATE, PLAN_INDEX } from './fixtures'

const CWD = '/p'

/** Stands for the engine beneath the mod: a project folder in memory and the UI calls. */
function world(on: On, files: Record<string, string>) {
  const seen = { status: [] as unknown[], opened: [] as string[] }
  mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') })
  mock.store(on)
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
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('tool.call', () => ({ result: 'written' }) as never)
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return seen
}

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
