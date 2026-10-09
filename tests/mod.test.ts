import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SPEC, GOOD_SPEC, TODO_TEMPLATE, TODO_T2_DONE, TODO_CP_DONE, TODO_T3_DONE, TODO_NONE_DONE, PLAN_INDEX, WEAK_SPEC, gitOutput, decodeCells } from './fixtures'

const CWD = '/p'

/** Each world's mocked clock, for tests that move time on. */
const clocks = new WeakMap<object, ReturnType<typeof mock.clock>>()

/** Stands for the engine beneath the mod: a project folder in memory and the UI calls. */
type Git = { log: string; cat: string; messages?: string } | 'no-repo' | 'no-commits'

function world(
  on: On,
  files: Record<string, string>,
  git: Git = 'no-repo',
  stored: Record<string, unknown> = {},
  surfaces: readonly ('terminal' | 'desktop' | 'vscode' | 'mobile')[] = ['terminal'],
) {
  const seen = { status: [] as unknown[], opened: [] as string[], toasts: [] as string[], git: [] as string[], copied: [] as string[], launched: [] as string[] }
  on('ui.copy', (_$, e) => {
    seen.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('session.surfaces', () => ({ value: surfaces }) as never)
  on('process.run', (_$, e) => {
    const out = (exitCode: number, stdout: string) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    // macOS's `open`: what /progress report runs to show the page.
    if (e.argv[0] === 'open') {
      seen.launched.push(e.argv[1]!)
      return out(0, '')
    }
    seen.git.push(e.argv.slice(0, 2).join(' '))
    if (git === 'no-repo') return out(128, '')
    if (git === 'no-commits') return { value: { ...out(128, '').value, stderr: "fatal: your current branch 'main' does not have any commits yet" } }
    if (e.argv[1] === 'log') return out(0, e.argv.some(a => a.includes('%B')) ? (git.messages ?? '') : git.log)
    return out(0, git.cat)
  })
  clocks.set(seen, mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') }))
  mock.store(on, stored)
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home' : undefined }))
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

test('write guard refuses a new plan over unfinished tasks', { timeoutMs: 20_000 }, async ($, on) => {
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
  expect(last.text).toMatch(/waiting: T3 Issue and revoke keys, chain T3 ← T2/)
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
  expect(seen.git).toEqual(['git log', 'git cat-file', 'git log'])
  expect(seen.toasts).toEqual(['History since 29 Sep: 3 days from commits of tasks/todo.md.'])
  const board = await mountBoard($)
  expect(await board.find({ text: /from 3 tasks in 10 days/ })).toBeDefined()
  expect(await board.find({ text: /History since 29 Sep: 3 days from commits of tasks\/todo\.md\./ })).toBeDefined()
})

test('without git the history starts today and the board says so', async ($, on) => {
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  await $.command.run(run('refresh'))
  expect(seen.toasts).toEqual(['History tracked from 9 Oct: not a git repository.'])
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
  // Reading and thinking take no step: the task alone.
  await $.tool.call({ tool: 'Bash', command: 'cat SPEC.md' } as never)
  await draw($)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  await draw($)
  await $.tool.call({ tool: 'Bash', command: 'pnpm test keys # FAIL' } as never)
  await draw($)
  expect(words).toEqual(['Working on T2', 'Building T2', 'Testing T2'])

  const board = await mountBoard($)
  expect(await board.find({ text: /× T2 Prisma schema for keys · tests failed/ })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'pnpm test keys' } as never)
  expect(await board.find({ text: /× T2/ })).toBeUndefined()

  // The turn's end clears the step: the next turn starts on the task again.
  await $.turn.complete({ answer: 'done' } as never)
  await draw($)
  expect(words[3]).toBe('Working on T2')
})

test('with planSpinner on and no plan, the random word stays', { options: { planSpinner: true } }, async ($, on) => {
  world(on, {})
  const { words, draw } = spinnerWords(on)
  await $.command.run(run('refresh'))
  await draw($)
  expect(words).toEqual(['Sauteing'])
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
  expect(await pane.find({ text: /SPEC Rate limits \(SPEC-limits\.md\)/ })).toBeDefined()
  expect(await pane.find({ text: /Should keys expire/ })).toBeUndefined()

  expect(JSON.stringify(await $.command.run({ command: 'spec-view', args: 'nope', origin: { kind: 'composer' } } as never))).toMatch(
    /No SPEC-nope\.md in \/p\. Specs here: SPEC\.md, SPEC-limits\.md/,
  )
  await $.command.run({ command: 'spec-view', args: 'SPEC.md', origin: { kind: 'composer' } } as never)
  expect((await pane.find({ type: 'Select', key: 'spec-file' }))?.props).toMatchObject({ value: 'SPEC.md' })

  // The agent writes a third spec: the pane shows that one.
  files[`${CWD}/SPEC-billing.md`] = WEAK_SPEC
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/SPEC-billing.md`, content: WEAK_SPEC } as never)
  expect(await pane.find({ text: /SPEC Webhooks \(SPEC-billing\.md\)/ })).toBeDefined()
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
  const seen = world(on, files, gitOutput([['2026-10-08', at(5)], ['2026-10-05', at(3)], ['2026-10-01', at(1)], ['2026-09-28', at(0)]]))
  const reply = JSON.stringify(await $.command.run(run('report')))
  expect(reply).toMatch(/Wrote tasks\/progress-report\.html \(\d+ KB\) and opened it in your browser/)
  expect(seen.launched).toEqual([`${CWD}/tasks/progress-report.html`])
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
  // Nobody at this machine (a print run): the report is written, not opened.
  const seen = world(on, files, 'no-repo', {}, [])
  expect(JSON.stringify(await $.command.run(run('report')))).toMatch(/Open \/p\/tasks\/progress-report\.html in a browser/)
  expect(seen.launched).toEqual([])
  const html = files[`${CWD}/tasks/progress-report.html`]!
  expect(html).not.toMatch(/<svg /)
  expect(html).toMatch(/The burn-up and flow charts need two days of history; tracking began 9 Oct\./)
  expect(html).toMatch(/<th>T1<\/th><td class="t">Monorepo scaffold<\/td><td class="bar muted">done before tracking<\/td><td class="n">—<\/td><td class="d">by 9 Oct<\/td>/)
  expect(html).not.toMatch(/0 d</)
  expect(html).not.toMatch(/Hover a chart/)
})

const LOGS = `/home/.claude/projects/-p`
/** A session log line as Claude Code writes it after an Edit of the task list. */
const logEdit = (at: string, before: string, from: string, to: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: at,
    cwd: CWD,
    toolUseResult: { filePath: `${CWD}/tasks/todo.md`, oldString: from, newString: to, originalFile: before, replaceAll: false, structuredPatch: [] },
  })

test('too little git history: the band asks about session logs, and a yes adds their days', async ($, on) => {
  // The plan was committed once, today; the sessions that ticked it are in the logs.
  const files: Record<string, string> = {
    [`${CWD}/tasks/todo.md`]: TODO_T3_DONE,
    [`${LOGS}/s1.jsonl`]: [
      logEdit('2026-10-02T10:00:00Z', TODO_TEMPLATE, '- [ ] Migration', '- [x] Migration'),
      logEdit('2026-10-03T09:00:00Z', TODO_T2_DONE, '- [ ] All tests pass', '- [x] All tests pass'),
    ].join('\n'),
    [`${LOGS}/s2.jsonl`]: [
      logEdit('2026-10-06T16:00:00Z', TODO_CP_DONE, '- [ ] POST /keys', '- [x] POST /keys'),
      'not json',
      JSON.stringify({ type: 'user', timestamp: '2026-10-06T17:00:00Z', toolUseResult: { filePath: `${CWD}/src/x.ts`, content: 'x' } }),
    ].join('\n'),
    [`${LOGS}/other.jsonl`]: '{"type":"user"}',
  }
  const seen = world(on, files, gitOutput([['2026-10-09', TODO_T3_DONE]]))
  await $.command.run(run('refresh'))
  expect(seen.toasts[0]).toMatch(/session logs could add more: the band above the prompt asks/)
  const band = await $.ui.mount({
    plugin: 'agent-skills-mods',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 140, scroll: { offset: 0, bodyRows: 6 }, view: {} } as never,
  })
  expect(await band.find({ text: /Also read this project's Claude Code session logs\?/ })).toBeDefined()
  expect(JSON.stringify(await $.command.run(run('history')))).toMatch(/session logs: not read yet/)

  await band.press({ key: 'logs-yes' })
  expect(await band.find({ text: /session logs\?/ })).toBeUndefined()
  const text = JSON.stringify(await $.command.run(run('history')))
  expect(text).toMatch(/History since 2 Oct: 3 days from session logs\./)
  expect(text).toMatch(/session logs: on, 3 days added/)
  // The board dates T3 from the log, not from today.
  const board = await mountBoard($)
  expect(await board.find({ text: /^6 Oct\s+ ✓ T3/ })).toBeDefined()

  expect(JSON.stringify(await $.command.run(run('history logs off')))).toMatch(/Session logs are off/)
  expect(JSON.stringify(await $.command.run(run('history')))).toMatch(/History tracked from 9 Oct\./)
})

test('a new project: no logs when the plan is first written, the question at the next session start', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_T2_DONE }
  world(on, files)
  await $.command.run(run('refresh'))
  expect(JSON.stringify(await $.command.run(run('history')))).toMatch(/session logs: no session of this project writes/)
  // The session that wrote the plan has logged its edits since.
  files[`${LOGS}/s1.jsonl`] = logEdit('2026-10-09T08:00:00Z', TODO_TEMPLATE, '- [ ] Migration', '- [x] Migration')
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.command.run(run('history')))).toMatch(/session logs: not read yet: the band above the prompt asks/)
})

test('a repository with no commits yet says so', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }, 'no-commits')
  await $.command.run(run('refresh'))
  expect(JSON.stringify(await $.command.run(run('history')))).toMatch(/History tracked from 9 Oct: no commits yet\./)
})

test('a No keeps the logs unread and the question away', async ($, on) => {
  const files: Record<string, string> = {
    [`${CWD}/tasks/todo.md`]: TODO_T2_DONE,
    [`${LOGS}/s1.jsonl`]: logEdit('2026-10-02T10:00:00Z', TODO_TEMPLATE, '- [ ] Migration', '- [x] Migration'),
  }
  world(on, files)
  await $.command.run(run('refresh'))
  const band = await $.ui.mount({
    plugin: 'agent-skills-mods',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 140, scroll: { offset: 0, bodyRows: 6 }, view: {} } as never,
  })
  await band.press({ key: 'logs-no' })
  expect(await band.find({ text: /session logs\?/ })).toBeUndefined()
  expect(JSON.stringify(await $.command.run(run('history')))).toMatch(/session logs: off/)
})

test('commit messages date the tasks when the task list was never committed per tick', async ($, on) => {
  const msg = (day: string, body: string) => `\x1e${Date.parse(`${day}T12:00:00Z`) / 1000}\x1f${body}\n`
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_T3_DONE }, {
    ...gitOutput([['2026-09-25', TODO_NONE_DONE]]),
    messages: msg('2026-10-06', 'T3: issue and revoke keys') + msg('2026-10-02', 'Task 2: prisma schema\n\nRefs T1') + msg('2026-09-30', 'feat: scaffold (T1)') + msg('2026-09-20', 'T2 of an older plan'),
  })
  await $.command.run(run('refresh'))
  expect(seen.toasts[0]).toBe('History since 25 Sep: 1 day from commits of tasks/todo.md, 3 days from commit messages.')
  const text = JSON.stringify(await $.command.run(run('history')))
  expect(text).toMatch(/commit messages naming tasks \(T3, Task 3\): 3 days/)
  const board = await mountBoard($)
  expect(await board.find({ text: /^30 Sep\s+ ✓ T1/ })).toBeDefined()
  expect(await board.find({ text: /^2 Oct\s+ ✓ T2/ })).toBeDefined()
  expect(await board.find({ text: /^6 Oct\s+ ✓ T3/ })).toBeDefined()
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

test('spec gate is off by default: source edits before approval say nothing', async ($, on) => {
  const seen = world(on, { [`${CWD}/SPEC.md`]: SPEC })
  await $.command.run(run('refresh'))
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  expect(seen.toasts).toEqual([])
})

test('with specGate on, a source edit before approval warns once a turn and never blocks', { options: { specGate: true } }, async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/SPEC.md`]: SPEC }
  const seen = world(on, files)
  await $.command.run(run('refresh'))
  const first = await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  expect('deny' in first && first.deny).toBeFalsy()
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/src/limits.ts`, content: 'x' } as never)
  // Docs and the spec itself are not source.
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/README.md`, old_string: 'a', new_string: 'b' } as never)
  expect(seen.toasts).toEqual(['♦ Spec gate · src/keys.ts changed while SPEC.md awaits approval'])

  // A new turn warns again; an approved spec warns no more.
  await $.turn.complete({ answer: 'done' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  expect(seen.toasts).toHaveLength(2)
  files[`${CWD}/SPEC.md`] = SPEC.replace('status: draft', 'status: approved')
  await $.turn.complete({ answer: 'done' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  expect(seen.toasts).toHaveLength(2)
})

const mountSpec = ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({
    plugin: 'agent-skills-mods',
    surface,
    component: 'Pane',
    requestId: 'asm-spec',
    props: { title: 'x', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } } as never,
  })

test('the spec pane approves the spec in front matter, and can put it back to draft', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/SPEC.md`]: SPEC }
  const seen = world(on, files)
  await $.command.run({ command: 'spec-view', args: '', origin: { kind: 'composer' } } as never)
  const pane = await mountSpec($)
  expect(await pane.find({ text: /♦ awaiting approval/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'spec-draft' })).toBeUndefined()

  await pane.press({ key: 'spec-approve' })
  expect(files[`${CWD}/SPEC.md`]).toMatch(/^---\nstatus: approved\n---\n# Spec: API keys/)
  expect(seen.toasts).toContain('✓ SPEC.md approved · planning can start')
  expect(await pane.find({ text: /✓ approved/ })).toBeDefined()
  expect(JSON.stringify(seen.status.at(-1))).toMatch(/spec ✓ approved/)

  await pane.press({ key: 'spec-draft' })
  expect(files[`${CWD}/SPEC.md`]).toMatch(/^---\nstatus: draft\n---/)
  expect(await pane.find({ type: 'Button', key: 'spec-approve' })).toBeDefined()
})

test('Open in editor uses the default app when $EDITOR is a terminal editor', async ($, on) => {
  const seen = world(on, { [`${CWD}/SPEC.md`]: SPEC })
  await $.command.run({ command: 'spec-view', args: '', origin: { kind: 'composer' } } as never)
  const pane = await mountSpec($)
  await pane.press({ key: 'spec-edit' })
  expect(seen.launched).toEqual([`${CWD}/SPEC.md`])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the spec pane reads a section on ${surface}`, async ($, on) => {
    world(on, { [`${CWD}/SPEC.md`]: GOOD_SPEC })
    await $.command.run({ command: 'spec-view', args: '', origin: { kind: 'composer' } } as never)
    const pane = await mountSpec($, surface)
    expect(await pane.find({ type: 'Markdown' })).toBeUndefined()
    await pane.select({ key: 'spec-section', value: 'commands' })
    const md = await pane.find({ type: 'Markdown', key: 'spec-section-body' })
    expect(String((md?.props as { text: string }).text)).toMatch(/pnpm/)
  })
}

test('module specs from a capability map: specs/<module>.md in the picker, by /spec-view and when written', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/SPEC.md`]: SPEC, [`${CWD}/specs/limits.md`]: GOOD_SPEC }
  world(on, files)
  await $.command.run({ command: 'spec-view', args: '', origin: { kind: 'composer' } } as never)
  const pane = await mountSpec($)
  expect((await pane.find({ type: 'Select', key: 'spec-file' }))?.props).toMatchObject({
    options: [{ value: 'SPEC.md' }, { value: 'specs/limits.md' }],
  })
  const reply = await $.command.run({ command: 'spec-view', args: 'limits', origin: { kind: 'composer' } } as never)
  expect(JSON.stringify(reply)).toMatch(/Spec pane opened: specs\/limits\.md/)
  expect(await pane.find({ text: /Rate limits \(specs\/limits\.md\)/ })).toBeDefined()

  files[`${CWD}/specs/hooks.md`] = WEAK_SPEC
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/specs/hooks.md`, content: WEAK_SPEC } as never)
  expect(await pane.find({ text: /Webhooks \(specs\/hooks\.md\)/ })).toBeDefined()
})

const CHART_HISTORY = [
  { day: '2026-10-01', done: 0, total: 4, doing: 1, blocked: 1 },
  { day: '2026-10-05', done: 2, total: 4, doing: 0, blocked: 0 },
]
const mountCharts = ($: Parameters<TestBody>[0], bodyColumns = 70) =>
  $.ui.mount({
    plugin: 'agent-skills-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'asm-charts',
    props: { title: 'x', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
  })

test('with chartStyle pixels, the terminal charts are pictures with text axes and the same legends', { options: { chartStyle: 'pixels' } }, async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_T3_DONE }, 'no-repo', { [`history:${CWD}`]: CHART_HISTORY })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.command.run(run('charts'))
  const pane = await mountCharts($)
  expect(await pane.find({ type: 'Raster' })).toBeUndefined()
  const up = await pane.find({ type: 'Image', key: 'burnup' })
  expect(up?.props).toMatchObject({ columns: 66, rows: 9 })
  expect(String((up?.props as { alt: string }).alt)).toMatch(/^Burn-up: 3 of 4 tasks done by 9 Oct/)
  expect((await pane.find({ type: 'Image', key: 'flow' }))?.props).toMatchObject({ columns: 66, rows: 7 })
  expect(await pane.find({ text: /^ 4 ┤$/ })).toBeDefined()
  expect(await pane.find({ text: /^ {4}1 Oct +9 Oct$/ })).toBeDefined()
  expect(await pane.find({ text: /^done 3 \(green\)/ })).toBeDefined()
})

test('chartStyle auto on a terminal that draws no pictures keeps the braille and block Rasters', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_T3_DONE }, 'no-repo', { [`history:${CWD}`]: CHART_HISTORY })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.command.run(run('charts'))
  const pane = await mountCharts($)
  expect(await pane.find({ type: 'Image' })).toBeUndefined()
  expect(await pane.find({ type: 'Raster', key: 'burnup' })).toBeDefined()
})

test('the band turns its marker while the agent works and holds it still between turns', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  await $.command.run(run('refresh'))
  const props = (isWorking: boolean) =>
    ({ hasSurvey: false, isWorking, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }) as never
  const band = await $.ui.mount({ plugin: 'agent-skills-mods', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  expect((await band.find({ type: 'Client', key: 'pulse' }))?.props).toMatchObject({ module: 'hooks/ui/pulse.tsx', props: { isActive: false } })
  expect(await band.find({ text: /^●$/, in: 'pulse' })).toBeDefined()
  await band.advance(600)
  expect(await band.find({ text: /^●$/, in: 'pulse' })).toBeDefined()

  await band.redraw(props(true))
  await band.advance(150)
  const glyphs = new Set<string>()
  for (let i = 0; i < 4; i++) {
    await band.advance(140)
    for (const g of ['◐', '◓', '◑', '◒']) if (await band.find({ text: new RegExp(`^${g}$`), in: 'pulse' })) glyphs.add(g)
  }
  expect(glyphs.size).toBeGreaterThan(2)
  expect((await band.find({ type: 'Client', key: 'band-meter' }))?.props).toMatchObject({ props: { done: 1, total: 4 } })
  expect(await band.find({ text: /^1\/4 done$/ })).toBeDefined()
})

test('the board bar fills in smoothly to the share done', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  await $.command.run(run('refresh'))
  const board = await mountBoard($)
  const meter = await board.find({ type: 'Client', key: 'meter' })
  expect(meter?.props).toMatchObject({ module: 'hooks/ui/meter.tsx', props: { done: 1, total: 4 }, width: 30 })
  await board.resize({ columns: 30, rows: 1, in: 'meter' })
  await board.advance(2000)
  expect(await board.find({ text: /^███████▌░{22}$/, in: 'meter' })).toBeDefined()
  expect(await board.find({ text: /^25%$/ })).toBeDefined()
})

test('/progress charts sweeps the cell charts in from the left', async ($, on) => {
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_T3_DONE }, 'no-repo', { [`history:${CWD}`]: CHART_HISTORY })
  await $.command.run(run('charts'))
  const pane = await mountCharts($)
  const plot = async () => {
    const r = await pane.find({ type: 'Raster', key: 'burnup' })
    const { glyphs } = decodeCells(String((r?.props as { cells: string }).cells), 70)
    return glyphs.slice(0, 8).map(g => g.slice(4)).join('').trim()
  }
  expect(await plot()).toBe('')
  await clocks.get(seen)!.advance(500)
  expect((await plot()).length).toBeGreaterThan(10)
})

test('the board and charts carry Report, Copy digest and a switch to the other pane', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_T3_DONE }
  const seen = world(on, files, 'no-repo', { [`history:${CWD}`]: CHART_HISTORY })
  await $.command.run(run(''))
  const board = await mountBoard($)
  await board.press({ key: 'digest' })
  expect(seen.copied).toHaveLength(1)
  expect(seen.toasts.at(-1)).toBe('Copied to the clipboard.')
  await board.press({ key: 'report' })
  expect(files[`${CWD}/tasks/progress-report.html`]).toMatch(/^<!doctype html>/i)
  expect(seen.launched).toEqual([`${CWD}/tasks/progress-report.html`])
  await board.press({ key: 'to-charts' })
  expect(seen.opened.at(-1)).toBe('asm-charts')
  const charts = await mountCharts($)
  await charts.press({ key: 'to-board' })
  expect(seen.opened.at(-1)).toBe('asm-board')
  expect((await charts.find({ type: 'Button', key: 'report' }))?.props).toMatchObject({ hotkey: 'r' })
})
