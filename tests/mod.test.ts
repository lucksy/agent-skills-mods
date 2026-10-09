import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SPEC, GOOD_SPEC, TODO_TEMPLATE, TODO_T2_DONE, TODO_T3_DONE, TODO_NONE_DONE, PLAN_INDEX, WEAK_SPEC, gitOutput } from './fixtures'

const CWD = '/p'

/** Stands for the engine beneath the mod: a project folder in memory and the UI calls. */
type Git = { log: string; cat: string } | 'no-repo'

function world(on: On, files: Record<string, string>, git: Git = 'no-repo', stored: Record<string, unknown> = {}) {
  const seen = { status: [] as unknown[], opened: [] as string[], toasts: [] as string[], git: [] as string[], copied: [] as string[] }
  on('ui.copy', (_$, e) => {
    seen.copied.push(e.text)
    return { value: { isCopied: true } }
  })
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
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    const dir = `${e.path ?? CWD}/`
    const names = Object.keys(files)
      .filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('/'))
      .map(f => f.slice(dir.length))
    return { value: names.map(name => ({ name, kind: 'file', size: files[dir + name]!.length })) as never }
  })
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
  // A Bash command with FAIL in it fails, as a failing test run does.
  on('tool.call', (_$, e) =>
    (e.tool === 'Bash' && /FAIL/.test(String((e as { command?: string }).command))
      ? { result: 'Exit code 1', isError: true }
      : { result: 'written' }) as never,
  )
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

test('/progress charts draws each surface its own tier: Rasters on the terminal, interactive SVG on desktop', async ($, on) => {
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
  const svgs = await desk.findAll({ type: 'Svg' })
  expect(svgs.map(s => s.props.isInteractive)).toEqual([true, true])
  expect(String(svgs[0]!.props.alt)).toMatch(/^Burn-up: 3 of 4 tasks done by 9 Oct/)
  expect(String(svgs[1]!.props.source)).toMatch(/<title>5 Oct: 2 done · 0 in progress · 0 blocked · 2 to do<\/title>/)
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

/** Records the word each Spinner draw reaches the engine with; register before the test's first `$` call. */
function spinnerWords(on: On) {
  const words: unknown[] = []
  on('ui.render', { component: 'Spinner' }, ($x, e) => {
    words.push(e.props.word)
    return $x.ui.resolve(e).Text({ children: 'x' })
  })
  const draw = ($: Parameters<TestBody>[0]) =>
    $.ui.render({ surface: 'terminal', component: 'Spinner', requestId: 's', props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' } })
  return { words, draw }
}

test('with planSpinner on, the spinner says the step and task; a failed test run marks the task ×', { options: { planSpinner: true } }, async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  const { words, draw } = spinnerWords(on)
  await $.command.run(run('refresh'))
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  await draw($)
  await $.tool.call({ tool: 'Bash', command: 'pnpm test keys # FAIL' } as never)
  await draw($)
  expect(words).toEqual(['Building T2', 'Testing T2'])

  const board = await mountBoard($)
  expect(await board.find({ text: /× T2 Prisma schema for keys · tests failed/ })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'pnpm test keys' } as never)
  expect(await board.find({ text: /× T2/ })).toBeUndefined()

  // The turn's end clears the step: the next turn starts with the engine's word.
  await $.turn.complete({ answer: 'done' } as never)
  await draw($)
  expect(words[2]).toBe('Sauteing')
})

test('planSpinner is off by default: the random word stays', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  const { words, draw } = spinnerWords(on)
  await $.command.run(run('refresh'))
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  await draw($)
  expect(words).toEqual(['Sauteing'])
})

test('the timeline dates done tasks from git and expected ones with ≈', async ($, on) => {
  const many = Array.from({ length: 8 }, (_, i) => `## Task ${i + 1}: Step ${i + 1}\n- [${i < 5 ? 'x' : ' '}] work\n`).join('\n')
  const at = (n: number) => many.replace(/- \[x\]/g, (m, off) => (many.slice(0, off).split('- [x]').length - 1 < n ? m : '- [ ]'))
  const git = gitOutput([
    ['2026-10-08', at(5)],
    ['2026-10-05', at(3)],
    ['2026-10-01', at(1)],
    ['2026-09-28', at(0)],
  ])
  world(on, { [`${CWD}/tasks/todo.md`]: many }, git)
  await $.command.run(run('refresh'))
  const board = await mountBoard($)
  expect(await board.find({ text: /^1 Oct\s+ ✓ T1 Step 1/ })).toBeDefined()
  expect(await board.find({ text: /^8 Oct\s+ ✓ T5 Step 5/ })).toBeDefined()
  expect(await board.find({ text: /^≈\d+ Oct\s+ ● T6 Step 6/ })).toBeDefined()
  expect(await board.find({ text: /≈ expected/ })).toBeDefined()
})

test('module specs: a picker in the spec pane, /spec-view <id>, and the one the agent writes', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/SPEC.md`]: SPEC, [`${CWD}/SPEC-limits.md`]: GOOD_SPEC }
  const seen = world(on, files)
  const reply = await $.command.run({ command: 'spec-view', args: '', origin: { kind: 'composer' } } as never)
  expect(JSON.stringify(reply)).toMatch(/Spec pane opened: SPEC\.md \(2 specs/)
  const pane = await $.ui.mount({
    plugin: 'agent-skills-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'asm-spec',
    props: { title: 'x', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })
  const select = await pane.find({ type: 'Select', key: 'spec-file' })
  expect(select?.props).toMatchObject({ value: 'SPEC.md', options: [{ value: 'SPEC.md' }, { value: 'SPEC-limits.md' }] })
  expect(await pane.find({ text: /Should keys expire by default/ })).toBeDefined()

  await pane.select({ key: 'spec-file', value: 'SPEC-limits.md' })
  expect(await pane.find({ text: /^Rate limits \(SPEC-limits\.md\)/ })).toBeDefined()
  expect(await pane.find({ text: /Should keys expire/ })).toBeUndefined()

  expect(JSON.stringify(await $.command.run({ command: 'spec-view', args: 'nope', origin: { kind: 'composer' } } as never))).toMatch(
    /No SPEC-nope\.md in \/p\. Specs here: SPEC\.md, SPEC-limits\.md/,
  )
  await $.command.run({ command: 'spec-view', args: 'SPEC.md', origin: { kind: 'composer' } } as never)
  expect((await pane.find({ type: 'Select', key: 'spec-file' }))?.props).toMatchObject({ value: 'SPEC.md' })

  // The agent writes a third spec: the pane shows that one.
  files[`${CWD}/SPEC-billing.md`] = WEAK_SPEC
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/SPEC-billing.md`, content: WEAK_SPEC } as never)
  expect(await pane.find({ text: /^Webhooks \(SPEC-billing\.md\)/ })).toBeDefined()
  expect(seen.opened).toContain('asm-spec')
})

test('/progress digest copies four lines and shows them', async ($, on) => {
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/SPEC.md`]: SPEC })
  const reply = JSON.stringify(await $.command.run(run('digest')))
  expect(seen.copied.length).toBe(1)
  expect(seen.copied[0]!.split('\n')).toHaveLength(4)
  expect(seen.copied[0]).toMatch(/^API keys: 1\/4 tasks done \(25%\) · now T2/)
  expect(reply).toMatch(/Copied to the clipboard/)
})

test('/progress report writes one self-contained page next to the task list', async ($, on) => {
  const many = Array.from({ length: 8 }, (_, i) => `## Task ${i + 1}: Step ${i + 1}\n- [${i < 5 ? 'x' : ' '}] work\n`).join('\n')
  const at = (n: number) => many.replace(/- \[x\]/g, (m, off) => (many.slice(0, off).split('- [x]').length - 1 < n ? m : '- [ ]'))
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: many, [`${CWD}/SPEC.md`]: SPEC }
  world(on, files, gitOutput([['2026-10-08', at(5)], ['2026-10-05', at(3)], ['2026-10-01', at(1)], ['2026-09-28', at(0)]]))
  const reply = JSON.stringify(await $.command.run(run('report')))
  expect(reply).toMatch(/Wrote tasks\/progress-report\.html \(\d+ KB\)/)
  const html = files[`${CWD}/tasks/progress-report.html`]!
  expect(html).toMatch(/^<!doctype html>/)
  // Self-contained: nothing fetched, so it opens offline and survives an email.
  expect(html).not.toMatch(/(src|href)=["']?(https?:)?\/\//)
  expect(html).not.toMatch(/<script/)
  expect(html).toMatch(/<span class="k">Done<\/span><span class="v">5\/8<\/span>/)
  expect(html).toMatch(/<span class="k">ETA<\/span><span class="v">\d+ \w{3}<\/span>/)
  expect(html.match(/<svg /g)?.length).toBe(2)
  expect(html).toMatch(/<th>T1<\/th><td class="t">Step 1<\/td>.*<td class="n">3 d<\/td><td class="d">1 Oct<\/td>/)
  expect(html).toMatch(/<h2>Needs a decision<\/h2><ul><li>approve SPEC\.md<\/li>/)
})

test('a report from one day of history says why it has no charts, and never claims a task took 0 days', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_T2_DONE }
  world(on, files)
  await $.command.run(run('report'))
  const html = files[`${CWD}/tasks/progress-report.html`]!
  expect(html).not.toMatch(/<svg /)
  expect(html).toMatch(/The burn-up and flow charts need two days of history; tracking began 9 Oct\./)
  expect(html).toMatch(/<th>T1<\/th><td class="t">Monorepo scaffold<\/td><td class="bar muted">done before tracking<\/td><td class="n">—<\/td><td class="d">by 9 Oct<\/td>/)
  expect(html).not.toMatch(/0 d</)
  expect(html).not.toMatch(/Hover a chart/)
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
