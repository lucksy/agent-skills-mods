import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parsePlan, parseTasks } from '../packages/core/parse'
import { parseSeen, seenOf, seenText } from '../packages/core/since'
import { SPEC, GOOD_SPEC, TODO_TEMPLATE, TODO_T2_DONE, TODO_CP_DONE, TODO_T3_DONE, TODO_NONE_DONE, PLAN_INDEX, WEAK_SPEC, gitOutput, decodeCells } from './fixtures'

const CWD = '/p'

/** Each world's mocked clock, for tests that move time on. */
const clocks = new WeakMap<object, ReturnType<typeof mock.clock>>()

/** Stands for the engine beneath the mod: a project folder in memory and the UI calls. */
type Git = { log: string; cat: string; added?: Record<string, string>; answer?: (argv: string[], stdin?: string) => string; messages?: string; named?: string; diff?: string; revList?: string } | 'no-repo' | 'no-commits'

function world(
  on: On,
  files: Record<string, string>,
  git: Git = 'no-repo',
  stored: Record<string, unknown> = {},
  surfaces: readonly ('terminal' | 'desktop' | 'vscode' | 'mobile')[] = ['terminal'],
) {
  const seen = { status: [] as unknown[], opened: [] as string[], toasts: [] as string[], logs: [] as string[], git: [] as string[], copied: [] as string[], launched: [] as string[], calls: [] as Record<string, unknown>[], notified: [] as string[],
    // /progress dashboard live (T12): `node --version`'s answer (null: no node), what --serve prints, the children started and a way to end them.
    node: 'v22.20.0' as string | null,
    serve: { stdout: 'Serving /p at http://127.0.0.1:50123/?token=ab12\nOnly this machine can reach it, and only with the token. Ctrl-C stops it.\n', stderr: '', code: null as number | null },
    spawned: [] as string[][],
    ends: [] as (() => void)[],
    // The slash commands the mod registers, with their description and argument hint (team-view T13).
    commands: [] as { name: string; description?: string; argumentHint?: string }[],
  }
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
    // `rm`, as /progress archive runs it.
    if (e.argv[0] === 'rm') {
      delete files[e.argv[e.argv.length - 1]!]
      return out(0, '')
    }
    if (e.argv[0] === 'node' && e.argv[1] === '--version') {
      if (seen.node === null) throw new Error('spawn node ENOENT')
      return out(0, `${seen.node}\n`)
    }
    if (e.argv[0] === 'open') {
      seen.launched.push(e.argv[1]!)
      return out(0, '')
    }
    seen.git.push(e.argv.slice(0, 2).join(' '))
    if (git === 'no-repo') return out(128, '')
    if (git === 'no-commits') return { value: { ...out(128, '').value, stderr: "fatal: your current branch 'main' does not have any commits yet" } }
    if (e.argv[1] === 'log' && e.argv.includes('--format=%h %as %s')) return out(0, git.named ?? '')
    if (e.argv[1] === 'diff') return out(0, git.diff ?? '')
    if (e.argv.includes('--diff-filter=A')) return out(0, git.added?.[e.argv[e.argv.length - 1]!] ? `${git.added[e.argv[e.argv.length - 1]!]}\n` : '')
    if (e.argv[1] === 'rev-list' && e.argv.includes('-1')) return out(0, git.revList ?? '')
    if (e.argv[1] === 'log') return out(0, e.argv.some(a => a.includes('%B')) ? (git.messages ?? '') : git.log)
    return out(0, git.answer ? git.answer([...e.argv], typeof e.init?.stdin === "string" ? e.init.stdin : "") : git.cat)
  })
  // The CLI's --serve as a child: what it prints, then it runs until the test ends it (or exits with `code`).
  on('process.spawn', async function* (_$, e) {
    seen.spawned.push([...e.argv])
    if (seen.serve.stdout) yield { stream: 'stdout' as const, text: seen.serve.stdout }
    if (seen.serve.stderr) yield { stream: 'stderr' as const, text: seen.serve.stderr }
    if (seen.serve.code !== null) return { value: { code: seen.serve.code, signal: null } }
    await new Promise<void>(end => seen.ends.push(end))
    return { value: { code: null, signal: 'SIGTERM' } }
  })
  clocks.set(seen, mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') }))
  mock.store(on, stored)
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', (_$, e) => {
    seen.commands.push({ name: e.name, description: e.description, argumentHint: e.argumentHint })
    return { value: { command: e.name } }
  })
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
    // Folders too, from deeper paths (format-v2: tasks/archive/<plan>/).
    const dirs = [...new Set(Object.keys(files).filter(f => f.startsWith(dir) && f.slice(dir.length).includes('/')).map(f => f.slice(dir.length).split('/')[0]!))]
    return { value: [...names.map(name => ({ name, kind: 'file', size: files[dir + name]!.length })), ...dirs.map(name => ({ name, kind: 'dir', size: 0 }))] as never }
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
  on('ui.notify', (_$, e) => {
    seen.notified.push(`${e.title ?? ''}: ${e.text}`)
    return { value: { isSent: true, channel: 'terminal_bell' } } as never
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  // A Bash command with FAIL in it fails, as a failing test run does.
  on('tool.call', (_$, e) =>
    (seen.calls.push(e as never), e.tool === 'Bash' && /FAIL/.test(String((e as { command?: string }).command))
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
  expect(await pane.find({ text: /^nothing runnable$/ })).toBeDefined()
  expect(await pane.find({ text: /^no example$/ })).toBeDefined()
  expect(await pane.find({ text: /^1 vague criterion$/ })).toBeDefined()
  expect(await pane.find({ text: /^! 1 Objective$/ })).toBeDefined()
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
  const t3 = await board.findAll({ text: /^○ T3 Issue and revoke keys$/ })
  expect(t3.some(x => (x.props as { inverse?: boolean }).inverse === true)).toBe(true)

  await $.prompt.submit({ text: 'run the linter', wait: false, origin: { kind: 'composer' } } as never)
  expect(seen.opened).toEqual(['asm-board'])
})

/** The plan pane on its timeline tab. */
const mountTimeline = async ($: Parameters<TestBody>[0]) => {
  await $.command.run(run('timeline'))
  return mountBoard($)
}

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
  expect(seen.git).toEqual(['git log', 'git cat-file', 'git cat-file', 'git log'])
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
  expect((await term.find({ type: 'Raster', key: 'flow' }))?.props).toMatchObject({ columns: 70, rows: 10 })
  expect(await term.find({ text: /^done 3$/ })).toBeDefined()
  expect(await term.find({ text: /^in progress 0$/ })).toBeDefined()
  // A resized pane draws charts to its new width.
  await term.redraw({ title: 'x', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never)
  expect((await term.find({ type: 'Raster', key: 'burnup' }))?.props).toMatchObject({ columns: 40 })

  const desk = await mount('desktop', 70)
  expect(await desk.find({ type: 'Raster' })).toBeUndefined()
  const svgs = await desk.findAll({ type: 'Svg' })
  expect(svgs.map(s => s.props.isInteractive)).toEqual([true, true])
  expect(String(svgs[0]!.props.alt)).toMatch(/^Burn-up: 3 of 4 tasks done by 9 Oct/)
  expect(String(svgs[1]!.props.source)).toMatch(/<title>5 Oct: 2 done · 0 in progress · 0 blocked · 2 to do<\/title>/)
  expect(await desk.find({ text: /^done 3$/ })).toBeDefined()
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
  expect(await board.find({ text: /^× T2 Prisma schema for keys$/ })).toBeDefined()
  // The current task is open, so its right column carries the ▾ marker.
  expect(await board.find({ text: /^▾ tests failed$/ })).toBeDefined()
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
  const board = await mountTimeline($)
  expect(await board.find({ text: /├─ ✓ T1 Step 1 +▬▬▬ done 1 Oct$/ })).toBeDefined()
  expect(await board.find({ text: /├─ ✓ T5 Step 5 +▬▬▬ done 8 Oct$/ })).toBeDefined()
  expect(await board.find({ text: /├─ ● T6 Step 6 +▬▫▫ building · today  done ≈\d+ Oct$/ })).toBeDefined()
  expect(await board.find({ text: /└─ ○ T8 Step 8 +▫▫▫ ≈\d+ Oct$/ })).toBeDefined()
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
  expect(await pane.find({ text: /^SPEC-limits\.md · Rate limits$/ })).toBeDefined()
  expect(await pane.find({ text: /Should keys expire/ })).toBeUndefined()

  expect(JSON.stringify(await $.command.run({ command: 'spec-view', args: 'nope', origin: { kind: 'composer' } } as never))).toMatch(
    /No SPEC-nope\.md in \/p\. Specs here: SPEC\.md, SPEC-limits\.md/,
  )
  await $.command.run({ command: 'spec-view', args: 'SPEC.md', origin: { kind: 'composer' } } as never)
  expect((await pane.find({ type: 'Select', key: 'spec-file' }))?.props).toMatchObject({ value: 'SPEC.md' })

  // The agent writes a third spec: the pane shows that one.
  files[`${CWD}/SPEC-billing.md`] = WEAK_SPEC
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/SPEC-billing.md`, content: WEAK_SPEC } as never)
  expect(await pane.find({ text: /^SPEC-billing\.md · Webhooks$/ })).toBeDefined()
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
  // The timeline dates T3 from the log, not from today.
  const board = await mountTimeline($)
  expect(await board.find({ text: /✓ T3 .*done 6 Oct$/ })).toBeDefined()

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
  const board = await mountTimeline($)
  expect(await board.find({ text: /✓ T1 .*done 30 Sep$/ })).toBeDefined()
  expect(await board.find({ text: /✓ T2 .*done 2 Oct$/ })).toBeDefined()
  expect(await board.find({ text: /✓ T3 .*done 6 Oct$/ })).toBeDefined()
})

test('/progress next answers from the parser and sets the status entry', async ($, on) => {
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/SPEC.md`]: SPEC })
  const out = await $.command.run(run('next'))
  expect(out.text).toMatch(/^Next: T2 Prisma schema for keys/)
  expect(JSON.stringify(seen.status)).toMatch(/spec ♦ awaiting approval · plan ██░░░░░░░ 1\/4/)
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
    expect(await board.find({ text: /^tasks · Phase 1 of 2$/ })).toBeDefined()
    expect(await board.find({ text: /^1\/4 · 25%$/ })).toBeDefined()
    expect(await board.find({ text: /^◐ T2 Prisma schema for keys$/ })).toBeDefined()
    expect(await board.find({ text: /^◆ Checkpoint 1$/ })).toBeDefined()
    expect(await board.find({ text: /^after T2$/ })).toBeDefined()
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
    expect(await band.find({ text: /^T2 Prisma schema for keys$/ })).toBeDefined()
    expect(await band.find({ text: /^1 criterion · 1 verification$/ })).toBeDefined()
    expect(await band.find({ text: /^checkpoint after this task$/ })).toBeDefined()
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
  expect(await pane.find({ text: /^awaiting approval$/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'spec-draft' })).toBeUndefined()

  await pane.press({ key: 'spec-approve' })
  expect(files[`${CWD}/SPEC.md`]).toMatch(/^---\nstatus: approved\napproved: 2026-10-09\ncreated: 2026-10-09\n---\n# Spec: API keys/)
  expect(seen.toasts).toContain('✓ SPEC.md approved · planning can start')
  expect(await pane.find({ text: /^approved 9 Oct$/ })).toBeDefined()
  expect(JSON.stringify(seen.status.at(-1))).toMatch(/spec ✓ approved/)

  await pane.press({ key: 'spec-draft' })
  expect(files[`${CWD}/SPEC.md`]).toMatch(/^---\nstatus: draft\ncreated: 2026-10-09\n---/)
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
  expect(await pane.find({ text: /^specs\/limits\.md · Rate limits$/ })).toBeDefined()

  files[`${CWD}/specs/hooks.md`] = WEAK_SPEC
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/specs/hooks.md`, content: WEAK_SPEC } as never)
  expect(await pane.find({ text: /^specs\/hooks\.md · Webhooks$/ })).toBeDefined()
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
  expect((await pane.find({ type: 'Image', key: 'flow' }))?.props).toMatchObject({ columns: 66, rows: 9 })
  expect(await pane.find({ text: /^ 4 ┤$/ })).toBeDefined()
  expect(await pane.find({ text: /^ {4}1 Oct +9 Oct$/ })).toBeDefined()
  expect(await pane.find({ text: /^done 3$/ })).toBeDefined()
})

test('chartStyle auto on a terminal that draws no pictures keeps the braille and block Rasters', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_T3_DONE }, 'no-repo', { [`history:${CWD}`]: CHART_HISTORY })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.command.run(run('charts'))
  const pane = await mountCharts($)
  expect(await pane.find({ type: 'Image' })).toBeUndefined()
  expect(await pane.find({ type: 'Raster', key: 'burnup' })).toBeDefined()
})

test('the band shows ▸ between turns and a turning marker while the agent works', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  await $.command.run(run('refresh'))
  const props = (isWorking: boolean) =>
    ({ hasSurvey: false, isWorking, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }) as never
  const band = await $.ui.mount({ plugin: 'agent-skills-mods', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  expect(await band.find({ type: 'Client', key: 'pulse' })).toBeUndefined()
  expect(await band.find({ text: /^▸$/ })).toBeDefined()

  await band.redraw(props(true))
  expect((await band.find({ type: 'Client', key: 'pulse' }))?.props).toMatchObject({ module: 'hooks/ui/pulse.tsx', props: { isActive: true } })
  const glyphs = new Set<string>()
  for (let i = 0; i < 5; i++) {
    await band.advance(140)
    for (const g of ['◐', '◓', '◑', '◒']) if (await band.find({ text: new RegExp(`^${g}$`), in: 'pulse' })) glyphs.add(g)
  }
  expect(glyphs.size).toBeGreaterThan(2)
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

test('the plan pane: tabs switch by ←/→ or a click, with report and copy digest beside them', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_T3_DONE }
  const seen = world(on, files, 'no-repo', { [`history:${CWD}`]: CHART_HISTORY })
  await $.command.run(run(''))
  const pane = await mountBoard($)
  expect((await pane.find({ type: 'Client', key: 'tabs' }))?.props).toMatchObject({ module: 'hooks/ui/tabs.tsx', props: { active: 'tasks' } })
  expect(await pane.find({ text: /^\[ Tasks \]$/, in: 'tabs' })).toBeDefined()

  await pane.key({ key: 'left', in: 'tabs' })
  expect(await pane.find({ type: 'Raster', key: 'burnup' })).toBeDefined()
  await pane.key({ key: 'left', in: 'tabs' })
  expect(await pane.find({ text: /^\/review → \/ship$|○ \/review → \/ship/ })).toBeDefined()
  await pane.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 'tabs' })
  expect(await pane.find({ text: /^tasks · / })).toBeDefined()

  await pane.press({ key: 'digest' })
  expect(seen.copied).toHaveLength(1)
  expect(seen.toasts.at(-1)).toBe('Copied to the clipboard.')
  await pane.press({ key: 'report' })
  expect(files[`${CWD}/tasks/progress-report.html`]).toMatch(/^<!doctype html>/i)
  expect((await pane.find({ type: 'Button', key: 'report' }))?.props).toMatchObject({ hotkey: 'r', plain: true })
})

test('the timeline: header, milestones, a tree with step bars, and the legend', async ($, on) => {
  const todo = `---\nplan: api-keys\ncreated: 2026-09-29\n---\n${TODO_T2_DONE.replace('## Task 3: Issue and revoke keys', '## Task 3: Issue and revoke keys\n**Status:** in progress · started 2026-10-08 · step test')}`
  const spec = SPEC.replace('status: draft', 'status: approved\napproved: 2026-09-28')
  world(on, { [`${CWD}/tasks/todo.md`]: todo, [`${CWD}/SPEC.md`]: spec, [`${CWD}/tasks/plan.md`]: '# Plan\n## Open Questions\n- Q2 (T4): Upstash or self-hosted?\n' })
  const pane = await mountTimeline($)
  expect(await pane.find({ text: /^api-keys  4 tasks · 2 phases · spec ✓ approved$/ })).toBeDefined()
  expect(await pane.find({ text: /^10d in · no ETA yet/ })).toBeDefined()
  expect(await pane.find({ text: /^28 Sep +✓ spec approved$/ })).toBeDefined()
  expect(await pane.find({ text: /^29 Sep +✓ plan  4 tasks · 1 checkpoint$/ })).toBeDefined()
  expect(await pane.find({ text: /├─ ✓ Phase 1 · Foundation  2 of 2 done$/ })).toBeDefined()
  expect(await pane.find({ text: /│  ├─ ✓ T1 Monorepo scaffold +▬▬▬ done/ })).toBeDefined()
  expect(await pane.find({ text: /├─ ♦ checkpoint 1   needs you: tests · review with you$/ })).toBeDefined()
  expect(await pane.find({ text: /│  ├─ ● T3 Issue and revoke keys +▬▬▫ testing · 1d$/ })).toBeDefined()
  expect(await pane.find({ text: /│  └─ ♦ T4 Rate limit per key +needs you: Q2, Upstash or self-hosted\?$/ })).toBeDefined()
  expect(await pane.find({ text: /^ +○ \/review → \/ship$/ })).toBeDefined()
  expect(await pane.find({ text: /^■ done  ■ running  ■ slow  × failed  ♦ needs you  ▫ to come  · waits on another task$/ })).toBeDefined()
})

test('progress format: a task list the agent writes gets front matter and Status lines', async ($, on) => {
  const seen = world(on, {})
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/tasks/todo.md`, content: TODO_TEMPLATE } as never)
  const written = String(seen.calls.at(-1)?.content)
  expect(written).toMatch(/^---\nplan: api-keys\ncreated: 2026-10-09\n---\n/)
  expect(written).toMatch(/## Task 3: Issue and revoke keys\n\*\*Status:\*\* todo\n/)
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/SPEC.md`, content: '# Spec: X\n' } as never)
  expect(String(seen.calls.at(-1)?.content)).toBe('---\nstatus: draft\ncreated: 2026-10-09\n---\n# Spec: X\n')
})

test('progress format: ticking the last box carries the done date in the same Edit', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE.replace('## Task 3: Issue and revoke keys', '## Task 3: Issue and revoke keys\n**Status:** in progress · started 2026-10-07') }
  const seen = world(on, files)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/tasks/todo.md`, old_string: '- [ ] POST /keys', new_string: '- [x] POST /keys' } as never)
  const call = seen.calls.at(-1) as { old_string: string; new_string: string }
  expect(call.new_string).toContain('**Status:** done · started 2026-10-07 · done 2026-10-09')
  expect(call.new_string).toContain('- [x] POST /keys')
})

test('progress format: source edits, test runs and commits move the current task, written at the turn end', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files)
  await $.command.run(run('refresh'))
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pnpm test keys' } as never)
  expect(files[`${CWD}/tasks/todo.md`]).toBe(TODO_TEMPLATE)
  await $.turn.complete({ answer: 'done' } as never)
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/## Task 2: Prisma schema for keys\n\*\*Status:\*\* in progress · started 2026-10-09 · step test\n/)
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/^---\nplan: api-keys\ncreated: 2026-10-09\n---/)
})

test('progress format: Claude is told the rules where agent-skills is at work, and its skills carry them', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  await $.command.run(run('refresh'))
  const composed = await $.prompt.compose(COMPOSE)
  const format = composed.sections.find(x => x.id === 'agent-skills-mods:format')
  expect(format?.text).toMatch(/\*\*Status:\*\* in progress · started YYYY-MM-DD/)
  const skill = await $.skill.prompt({ skill: 'agent-skills:planning-and-task-breakdown', text: 'PLAN SKILL' } as never)
  expect(String((skill as { text: string }).text)).toMatch(/^PLAN SKILL\n\n---\n\nagent-skills progress format/)
})

test('/progress format applies the format here and writes its rules into the project instructions, once', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/SPEC.md`]: '# Spec: Keys\n', [`${CWD}/CLAUDE.md`]: '# Project\n' }
  world(on, files)
  const out = await $.command.run(run('format'))
  expect(out.text).toMatch(/tasks\/todo\.md: 4 Status lines and front matter/)
  expect(out.text).toMatch(/SPEC\.md: front matter/)
  expect(readFm(files[`${CWD}/SPEC.md`]!)).toMatch(/status: approved/)
  expect(files[`${CWD}/CLAUDE.md`]).toMatch(/^# Project\n\n<!-- agent-skills-mods:progress-format -->\n## agent-skills progress format\n/)
  // team-view (T13): the answer and sign-off lines go with the rules.
  expect(files[`${CWD}/CLAUDE.md`]).toContain('→ A: <answer> · @handle YYYY-MM-DD')
  expect(files[`${CWD}/CLAUDE.md`]).toContain('**Signed off:** @handle YYYY-MM-DD')
  const again = await $.command.run(run('format'))
  expect(again.text).toBe('The progress format is already in place here.')
})

test('with progressFormat off, files go through as written and Claude is not told the rules', { options: { progressFormat: false } }, async ($, on) => {
  const seen = world(on, {})
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/tasks/todo.md`, content: TODO_TEMPLATE } as never)
  expect(seen.calls.at(-1)?.content).toBe(TODO_TEMPLATE)
  await $.command.run(run('refresh'))
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.some(x => x.id === 'agent-skills-mods:format')).toBe(false)
})

test('/progress format on a project under way dates its files and done tasks from git, and doctor fix moves late ones back', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_T3_DONE, [`${CWD}/SPEC.md`]: '# Spec: Keys\n', [`${CWD}/tasks/plan.md`]: '# Plan: Keys\n', [`${CWD}/CLAUDE.md`]: '# Project\n' }
  const git = {
    ...gitOutput([['2026-10-08', TODO_T3_DONE], ['2026-10-03', TODO_T2_DONE], ['2026-09-29', TODO_NONE_DONE]]),
    added: { 'SPEC.md': '2026-09-24', 'tasks/plan.md': '2026-09-25', 'tasks/todo.md': '2026-09-29' },
  }
  world(on, files, git)
  await $.command.run(run('format'))
  expect(readFm(files[`${CWD}/SPEC.md`]!)).toBe('status: approved\ncreated: 2026-09-24\napproved: 2026-09-25')
  expect(readFm(files[`${CWD}/tasks/plan.md`]!)).toBe('status: approved\ncreated: 2026-09-25\napproved: 2026-09-29')
  expect(readFm(files[`${CWD}/tasks/todo.md`]!)).toMatch(/created: 2026-09-29/)
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/## Task 3: [^\n]*\n\*\*Status:\*\* done · done 2026-10-08/)

  // Files a version before this stamped with the day the format came in.
  files[`${CWD}/SPEC.md`] = '---\nstatus: approved\ncreated: 2026-10-09\napproved: 2026-10-09\n---\n# Spec: Keys\n'
  files[`${CWD}/tasks/todo.md`] = files[`${CWD}/tasks/todo.md`]!.replace('created: 2026-09-29', 'created: 2026-10-09').replace('done 2026-10-08', 'done 2026-10-09')
  const report = (await $.command.run(run('doctor'))).text
  expect(report).toMatch(/created 2026-10-09, but git has the file from 24 Sep  \(fixable\)/)
  expect(report).toMatch(/done dates later than git shows: T3 9 Oct → 8 Oct/)
  await $.command.run(run('doctor fix'))
  expect(readFm(files[`${CWD}/SPEC.md`]!)).toBe('status: approved\ncreated: 2026-09-24\napproved: 2026-09-25')
  expect(readFm(files[`${CWD}/tasks/todo.md`]!)).toMatch(/created: 2026-09-29/)
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/done 2026-10-08/)
})

test('the plugin draws its own command replies styled: title, boxes with their glyph, fields', async ($, on) => {
  world(on, {})
  const row = (command: string, text: string) =>
    $.ui.mount({ plugin: 'agent-skills-mods', surface: 'terminal', component: 'CommandOutput', props: { command, args: 'next', text, isErrored: false } as never })
  const ours = await row('progress', 'Next: T4 CI pipeline  (Phase 0)\n  [x] Lint runs\n  [ ] Gate blocks merge\nProgress: 1/2 tasks done.')
  expect(await ours.find({ text: /^Next  T4 CI pipeline  Phase 0$/ })).toBeDefined()
  expect(await ours.find({ text: /^✓$/ })).toBeDefined()
  expect(await ours.find({ text: /^Gate blocks merge$/ })).toBeDefined()
  expect(await ours.find({ text: /^Progress  1\/2 tasks done\.$/ })).toBeDefined()
})

const readFm = (text: string) => /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''

test('the charts tab: side by side when wide, colour swatch legends, phase bars and the pace', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_T3_DONE }, 'no-repo', { [`history:${CWD}`]: CHART_HISTORY })
  await $.command.run(run('charts'))
  const pane = await mountCharts($, 140)
  expect((await pane.find({ type: 'Raster', key: 'burnup' }))?.props).toMatchObject({ columns: 69 })
  expect((await pane.find({ type: 'Raster', key: 'flow' }))?.props).toMatchObject({ columns: 69 })
  const swatches = await pane.findAll({ text: /^█ $/ })
  expect(swatches.map(x => (x.props as { color?: string }).color)).toEqual(['#3fbf5a', '#fab219', '#d03b3b', '#4a4f4c'])
  expect(await pane.find({ text: /^⠒⠒ done 3   ⠒⠒ scope 4   forecast ≈ 12 Oct \(12 Oct–13 Oct\)$/ })).toBeDefined()
  expect(await pane.find({ text: /^Phases$/ })).toBeDefined()
  expect(await pane.find({ text: /^Phase 1 · Foundation$/ })).toBeDefined()
  expect((await pane.find({ type: 'Client', key: 'phase-0' }))?.props).toMatchObject({ module: 'hooks/ui/meter.tsx', props: { done: 2, total: 2 } })
  expect(await pane.find({ text: /^Phase 2 · Core$/ })).toBeDefined()
  expect(await pane.find({ text: /^1\/2$/ })).toBeDefined()
  expect(await pane.find({ text: /^Tasks done per day [▁-█]+ · 3 in 8 days · 0\.38\/day$/ })).toBeDefined()
  await pane.resize({ columns: 20, rows: 1, in: 'phase-1' })
  await pane.advance(2000)
  expect(await pane.find({ text: /^█{10}░{10}$/, in: 'phase-1' })).toBeDefined()
})

test('the spec pane as mockup 8: numbered areas, summaries on the right, framed boundaries, key hints', async ($, on) => {
  const full = `${GOOD_SPEC}\n## Project Structure\nservices/gateway\n\n## Testing Strategy\nVitest unit tests, 80% line coverage.\n\n## Boundaries\n- Always: hash keys\n- Ask first: new deps\n- Never: store raw key\n`
  world(on, { [`${CWD}/SPEC.md`]: full })
  await $.command.run({ command: 'spec-view', args: '', origin: { kind: 'composer' } } as never)
  const pane = await mountSpec($)
  expect(await pane.find({ text: /^SPEC\.md · Rate limits$/ })).toBeDefined()
  expect(await pane.find({ text: /^awaiting approval$/ })).toBeDefined()
  expect(await pane.find({ text: /^✓ 1 Objective$/ })).toBeDefined()
  expect(await pane.find({ text: /^\d success criteri(on|a)$/ })).toBeDefined()
  expect(await pane.find({ text: /^✓ 2 Commands$/ })).toBeDefined()
  expect(await pane.find({ text: /^\d runnable$/ })).toBeDefined()
  expect(await pane.find({ text: /^vitest · 80%$/ })).toBeDefined()
  expect(await pane.find({ text: /^✓ 6 Boundaries$/ })).toBeDefined()
  expect((await pane.find({ type: 'Button', key: 'spec-approve' }))?.props).toMatchObject({ label: 'approve', hotkey: 'a', plain: true })
  expect((await pane.find({ type: 'Button', key: 'spec-edit' }))?.props).toMatchObject({ label: 'edit in $EDITOR', hotkey: 'e' })
  expect((await pane.find({ type: 'Select', key: 'spec-section' }))?.props).toMatchObject({ label: '↵ open section' })
})

test('/progress archive moves a finished plan to tasks/archive with its history, and a new plan starts clean', async ($, on) => {
  const done = TODO_TEMPLATE.replace(/- \[ \]/g, '- [x]')
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: done, [`${CWD}/tasks/plan.md`]: PLAN_INDEX }
  world(on, files, 'no-repo', { [`history:${CWD}`]: CHART_HISTORY })
  const out = await $.command.run(run('archive'))
  expect(out.text).toBe('Archived todo.md, plan.md, history.json to tasks/archive/2026-10-09-api-keys/ (4 of 4 tasks done). /plan can start the next plan.')
  expect(files[`${CWD}/tasks/archive/2026-10-09-api-keys/todo.md`]).toBe(done)
  expect(files[`${CWD}/tasks/archive/2026-10-09-api-keys/README.md`]).toMatch(/^# Archived plan: api-keys\n\nArchived 2026-10-09 with 4 of 4 tasks done\./)
  expect(JSON.parse(files[`${CWD}/tasks/archive/2026-10-09-api-keys/history.json`]!)).toHaveLength(3)
  expect(files[`${CWD}/tasks/todo.md`]).toBeUndefined()
  expect(files[`${CWD}/tasks/plan.md`]).toBeUndefined()
  // The same day again gets its own folder.
  files[`${CWD}/tasks/todo.md`] = done
  const again = await $.command.run(run('archive'))
  expect(again.text).toMatch(/tasks\/archive\/2026-10-09-api-keys-2\//)
})

test('/progress archive asks before archiving unfinished work; force lists what was left open', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files)
  const out = await $.command.run(run('archive'))
  expect(out.text).toMatch(/^tasks\/todo\.md still has 3 unfinished tasks \(T2, T3, T4\)\.\nRun `\/progress archive force`/)
  expect(files[`${CWD}/tasks/todo.md`]).toBe(TODO_TEMPLATE)
  await $.command.run(run('archive force'))
  expect(files[`${CWD}/tasks/archive/2026-10-09-api-keys/README.md`]).toMatch(/## Left open\n\n- T2 Prisma schema for keys\n- T3 Issue and revoke keys\n- T4 Rate limit per key\n$/)
})

test('/progress doctor lists the problems; doctor fix applies the fixable ones', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/SPEC.md`]: '# Spec: X\n## Objective\nx\n' }
  world(on, files)
  const out = await $.command.run(run('doctor'))
  expect(out.text).toMatch(/^! \d+ warnings\n\ntasks\/todo\.md\n/)
  expect(out.text).toContain('  ! no Status line on T1, T2, T3, T4  (fixable)')
  expect(out.text).toContain('  ! T3 has no Verification boxes (tests pass, build succeeds)')
  expect(out.text).toContain('  ! Commands section is missing')
  const fixed = await $.command.run(run('doctor fix'))
  expect(fixed.text).toMatch(/^Fixed tasks\/todo\.md, SPEC\.md\./)
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/\*\*Status:\*\* todo/)
  expect(fixed.text).not.toMatch(/fixable/)
})

test('/progress start, done, block and unblock write the task state', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files)
  expect((await $.command.run(run('start T3'))).text).toBe('T3 Issue and revoke keys is in progress (started 9 Oct).')
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/## Task 3: Issue and revoke keys\n\*\*Status:\*\* in progress · started 2026-10-09\n/)
  expect((await $.command.run(run('done 2'))).text).toBe('T2 Prisma schema for keys is done: 2 box(es) ticked.')
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/## Task 2: Prisma schema for keys\n\*\*Status:\*\* done · started 2026-10-09 · done 2026-10-09\n/)
  const blocked = await $.command.run(run('block T4 "Upstash or self-hosted?"'))
  expect(blocked.text).toBe('T4 Rate limit per key is blocked. Added Q1 to tasks/plan.md: "Upstash or self-hosted?".')
  expect(files[`${CWD}/tasks/plan.md`]).toMatch(/## Open Questions\n\n- Q1 \(T4\): Upstash or self-hosted\?\n$/)
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/## Task 4: Rate limit per key\n\*\*Status:\*\* blocked\n/)
  expect((await $.command.run(run('unblock T4'))).text).toMatch(/^T4 Rate limit per key is unblocked\./)
  expect((await $.command.run(run('start T9'))).text).toBe('No "## Task 9:" section in tasks/todo.md. Tasks: T1, T2, T3, T4.')
  expect((await $.command.run(run('block T4'))).text).toMatch(/^Say why/)
})

test('/progress standup: done since the last working day, today, blocked, decisions; copied', async ($, on) => {
  const todo = `---\nplan: api-keys\n---\n${TODO_T3_DONE.replace('## Task 3: Issue and revoke keys', '## Task 3: Issue and revoke keys\n**Status:** done · started 2026-10-07 · done 2026-10-08').replace('## Task 4: Rate limit per key', '## Task 4: Rate limit per key\n**Status:** in progress · started 2026-10-09 · step test').replace('## Task 1: Monorepo scaffold', '## Task 1: Monorepo scaffold\n**Status:** done · done 2026-10-01').replace('## Task 2: Prisma schema for keys', '## Task 2: Prisma schema for keys\n**Status:** done · done 2026-10-03')}`
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: todo, [`${CWD}/tasks/plan.md`]: '# Plan\n## Open Questions\n- Q2 (T9): later?\n' })
  const out = await $.command.run(run('standup'))
  const lines = out.text!.split('\n')
  expect(lines[0]).toBe('Standup · api-keys · Fri 9 Oct')
  expect(lines[1]).toBe('Done since 8 Oct: T3 Issue and revoke keys')
  expect(lines[2]).toBe('Today: T4 Rate limit per key (test, 1 box left)')
  expect(out.text).toMatch(/\nNeeds a decision: Q2 \(T9\): later\?\n/)
  expect(out.text).toMatch(/Progress: 3\/4 tasks/)
  expect(seen.copied[0]).toBe(lines.slice(0, lines.indexOf('')).join('\n'))
})

test('/progress task T3: state, boxes by kind, dependencies both ways, checkpoint, commits; the board focuses it', async ($, on) => {
  const todo = TODO_CP_DONE.replace('## Task 3: Issue and revoke keys', '## Task 3: Issue and revoke keys\n**Status:** in progress · started 2026-10-07 · step test').replace('**Dependencies:** 1', '**Dependencies:** T3')
  const msg = (h: string, d: string, s: string) => `${h} ${d} ${s}`
  const named = [msg('a1b2c3d', '2026-10-08', 'T3: issue keys'), msg('d4e5f6a', '2026-10-07', 'Task 3 wip'), msg('0a0a0a0', '2026-10-06', 'T30 unrelated')].join('\n')
  world(on, { [`${CWD}/tasks/todo.md`]: todo }, { log: '', cat: '', messages: '', named })
  const out = (await $.command.run(run('task T3'))).text!
  expect(out.split('\n').slice(0, 2)).toEqual(['◐ T3 Issue and revoke keys  ·  Phase 2 · Core', 'current · step test · started 7 Oct · 2d so far'])
  expect(out).toContain('Acceptance criteria 0/1\n  ☐ POST /keys returns the secret once')
  expect(out).toContain('Waits on: T2 ✓')
  expect(out).toContain('Waits on it: T4')
  expect(out).toContain('Commits naming T3\n  a1b2c3d 8 Oct  T3: issue keys\n  d4e5f6a 7 Oct  Task 3 wip')
  expect(out).not.toContain('T30')
  expect((await $.command.run(run('task 9'))).text).toMatch(/^No T9 in tasks\/todo\.md\./)
})

test('/spec-view diff: the spec since its approval, in the reply and as a diff in the pane', async ($, on) => {
  const spec = SPEC.replace('status: draft', 'status: approved\napproved: 2026-10-01')
  const diff = '--- a/SPEC.md\n+++ b/SPEC.md\n@@ -6,1 +6,2 @@\n Developers create and revoke API keys from the console.\n+Keys expire after 90 days.'
  world(on, { [`${CWD}/SPEC.md`]: spec }, { log: '', cat: '', diff, revList: 'abcdef1234567\n' })
  const out = (await $.command.run({ command: 'spec-view', args: 'diff', origin: { kind: 'composer' } } as never)) as { text: string }
  expect(out.text).toMatch(/^SPEC\.md since its approval on 1 Oct \(abcdef1\): \+1 −0 lines\. The spec pane shows the diff\./)
  expect(out.text).toContain('```diff\n--- a/SPEC.md')
  const pane = await mountSpec($)
  expect((await pane.find({ type: 'Code' }))?.props).toMatchObject({ format: 'diff' })
  // Opening the pane plainly clears it.
  await $.command.run({ command: 'spec-view', args: '', origin: { kind: 'composer' } } as never)
  expect(await pane.find({ type: 'Code' })).toBeUndefined()
})

test('/spec-view diff with nothing changed, and without git', async ($, on) => {
  world(on, { [`${CWD}/SPEC.md`]: SPEC }, { log: '', cat: '', diff: '' })
  expect(JSON.stringify(await $.command.run({ command: 'spec-view', args: 'diff', origin: { kind: 'composer' } } as never))).toMatch(/SPEC\.md has not changed since its last commit\./)
})

test('with checkpointGate on, source edits before a reached checkpoint is reviewed warn once a turn', { options: { checkpointGate: true } }, async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_T2_DONE }
  const seen = world(on, files)
  await $.command.run(run('refresh'))
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/limits.ts`, old_string: 'a', new_string: 'b' } as never)
  expect(seen.toasts.filter(t => t.includes('gate'))).toEqual(['♦ Checkpoint gate · src/keys.ts changed before "After Tasks 1-2" was reviewed'])
  // Reviewed: no more warnings.
  files[`${CWD}/tasks/todo.md`] = TODO_CP_DONE
  await $.turn.complete({ answer: 'done' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  expect(seen.toasts.filter(t => t.includes('gate'))).toHaveLength(1)
})

test('the checkpoint gate is off by default', async ($, on) => {
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_T2_DONE })
  await $.command.run(run('refresh'))
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  expect(seen.toasts.filter(t => t.includes('gate'))).toEqual([])
})

test('spec drift: an agent edit to an approved spec puts it back to draft and says so', async ($, on) => {
  const spec = SPEC.replace('status: draft', 'status: approved\napproved: 2026-10-01\ncreated: 2026-09-30')
  const seen = world(on, { [`${CWD}/SPEC.md`]: spec })
  const result = await $.tool.call({ tool: 'Edit', file_path: `${CWD}/SPEC.md`, old_string: 'Should keys expire by default?', new_string: 'Keys expire after 90 days.' } as never)
  const call = seen.calls.at(-1) as { new_string: string }
  expect(call.new_string).toContain('status: draft')
  expect(call.new_string).toContain('Keys expire after 90 days.')
  expect(seen.toasts).toContain('○ SPEC.md changed after approval: back to draft · /spec-view diff shows what changed')
  expect(JSON.stringify(result)).toMatch(/back to status: draft/)
})

test('notifications: a checkpoint reached, the last task done, a test run failing', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  const seen = world(on, files)
  await $.command.run(run('refresh'))
  files[`${CWD}/tasks/todo.md`] = TODO_T2_DONE
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/tasks/todo.md`, old_string: 'x', new_string: 'y' } as never)
  expect(seen.notified).toEqual(['agent-skills · Checkpoint reached: After Tasks 1-2 · All tests pass · Review with human before proceeding'])
  await $.tool.call({ tool: 'Bash', command: 'pnpm test # FAIL' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pnpm test # FAIL' } as never)
  expect(seen.notified.filter(n => n.includes('Tests failed'))).toHaveLength(1)
  files[`${CWD}/tasks/todo.md`] = TODO_TEMPLATE.replace(/- \[ \]/g, '- [x]')
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/tasks/todo.md`, old_string: 'x', new_string: 'y' } as never)
  expect(seen.notified.at(-1)).toBe('agent-skills · All tasks done: 4 of 4 tasks done. Next: /review.')
})

test('with notifications off, nothing is sent', { options: { notifications: false } }, async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  const seen = world(on, files)
  await $.command.run(run('refresh'))
  files[`${CWD}/tasks/todo.md`] = TODO_T2_DONE
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/tasks/todo.md`, old_string: 'x', new_string: 'y' } as never)
  expect(seen.notified).toEqual([])
})

test('the band warns, one line each, when a task runs long or scope grows', async ($, on) => {
  const todo = `---\ncreated: 2026-10-03\n---\n${TODO_T2_DONE.replace('## Task 3: Issue and revoke keys', '## Task 3: Issue and revoke keys\n**Status:** in progress · started 2026-10-01')}`
  world(on, { [`${CWD}/tasks/todo.md`]: todo }, 'no-repo', { [`history:${CWD}`]: [{ day: '2026-09-29', done: 0, total: 3 }] })
  await $.command.run(run('refresh'))
  const band = await $.ui.mount({ plugin: 'agent-skills-mods', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } as never })
  expect((await band.find({ text: /^! T3 has run 8d, over twice the usual 3d a task$/ }))?.props).toMatchObject({ color: 'warning' })
  expect(await band.find({ text: /^! scope grew from 3 to 4 tasks \(\+33%\) since 29 Sep$/ })).toBeDefined()
})

test('the board: the current task is open, its boxes tick with a click; another task opens and closes', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  const seen = world(on, files)
  await $.command.run(run(''))
  const board = await mountBoard($)
  // T2 is the current task: open without a click.
  expect(await board.find({ text: /^☑ Key table with hashed secret$/ })).toBeDefined()
  expect(await board.find({ type: 'Button', key: 'box-T2-1' })).toBeDefined()
  await board.press({ key: 'box-T2-1' })
  expect(files[`${CWD}/tasks/todo.md`]).toContain('- [x] Migration runs on a clean database')
  await board.press({ key: 'box-T2-2' })
  expect(seen.toasts.at(-1)).toMatch(/^♦ Checkpoint reached: After Tasks 1-2/)
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/## Task 2: Prisma schema for keys\n\*\*Status:\*\* done/)
  // T3 is current now and open; a click closes it, another opens it again.
  expect(await board.find({ type: 'Button', key: 'box-T3-0' })).toBeDefined()
  await board.press({ key: 'task-T3' })
  expect(await board.find({ type: 'Button', key: 'box-T3-0' })).toBeUndefined()
  await board.press({ key: 'task-T3' })
  expect(await board.find({ type: 'Button', key: 'box-T3-0' })).toBeDefined()
  // Opening another task closes the current one.
  await board.press({ key: 'task-T4' })
  expect(await board.find({ type: 'Button', key: 'box-T4-0' })).toBeDefined()
  expect(await board.find({ type: 'Button', key: 'box-T3-0' })).toBeUndefined()
})

test('/progress graph opens the Graph tab with the tree and the critical path', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  const out = await $.command.run(run('graph'))
  expect(out.text).toBe('Dependency graph opened: critical path T2 → T3.')
  const pane = await mountBoard($)
  expect(await pane.find({ text: /^\[ Graph \]$/, in: 'tabs' })).toBeDefined()
  expect(await pane.find({ text: /^✓ T1 Monorepo scaffold$/ })).toBeDefined()
  expect(await pane.find({ text: /^├─▶ ◐ T2 Prisma schema for keys$/ })).toBeDefined()
  expect(await pane.find({ text: /^Critical path T2 → T3 · 2 unfinished tasks in a row bound the finish date$/ })).toBeDefined()
})

test('the charts tab opens with the four figures, the now-bar and days per task', async ($, on) => {
  const todo = TODO_T3_DONE.replace('## Task 3: Issue and revoke keys', '## Task 3: Issue and revoke keys\n**Status:** done · started 2026-10-04 · done 2026-10-06').replace('## Task 4: Rate limit per key', '## Task 4: Rate limit per key\n**Status:** in progress · started 2026-10-08')
  world(on, { [`${CWD}/tasks/todo.md`]: todo, [`${CWD}/tasks/plan.md`]: '# Plan\n## Open Questions\n- Q2 (T9): later?\n' }, 'no-repo', { [`history:${CWD}`]: CHART_HISTORY })
  await $.command.run(run('charts'))
  const pane = await mountCharts($, 100)
  for (const label of ['DONE', 'FORECAST', 'SCOPE CHANGE', 'NEEDS A DECISION']) expect(await pane.find({ text: new RegExp(`^${label}$`) })).toBeDefined()
  expect(await pane.find({ text: /^3 of 4$/ })).toBeDefined()
  expect(await pane.find({ text: /^Q2 \(T9\): later\?$/ })).toBeDefined()
  expect(await pane.find({ text: /^done 3 · in progress 1 · blocked 0 · to do 0$/ })).toBeDefined()
  expect(await pane.find({ text: /^Days per task$/ })).toBeDefined()
  expect(await pane.find({ text: /^T3 Issue and revoke keys +█+ 2d$/ })).toBeDefined()
  expect(await pane.find({ text: /^T4 Rate limit per key +█+ 1d so far$/ })).toBeDefined()
})

test('the current task row is shaded with a theme colour', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  await $.command.run(run(''))
  const board = await mountBoard($)
  const drawn = JSON.stringify(await board.drawn())
  expect(drawn.match(/"backgroundColor":"diffAddedDimmed"/g)).toHaveLength(1)
})

/** The State v1 embedded in a dashboard page. */
const embedded = (html: string) => JSON.parse(html.match(/<script type="application\/json" id="asm-state">([\s\S]*?)<\/script>/)![1]!)

test('/progress dashboard writes the page from the plugin’s own history and opens it', async ($, on) => {
  const many = Array.from({ length: 8 }, (_, i) => `## Task ${i + 1}: Step ${i + 1}\n- [${i < 5 ? 'x' : ' '}] work\n`).join('\n')
  const at = (n: number) => many.replace(/- \[x\]/g, (m, off) => (many.slice(0, off).split('- [x]').length - 1 < n ? m : '- [ ]'))
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: many, [`${CWD}/SPEC.md`]: SPEC, [`${CWD}/SPEC-auth.md`]: GOOD_SPEC }
  const seen = world(on, files, gitOutput([['2026-10-08', at(5)], ['2026-10-05', at(3)], ['2026-10-01', at(1)], ['2026-09-28', at(0)]]))
  const reply = JSON.stringify(await $.command.run(run('dashboard')))
  expect(reply).toMatch(/Wrote tasks\/progress-dashboard\.html \(\d+ KB\) and opened it in your browser/)
  expect(seen.launched).toEqual([`${CWD}/tasks/progress-dashboard.html`])
  const html = files[`${CWD}/tasks/progress-dashboard.html`]!
  expect(html).toMatch(/^<!doctype html>/)
  expect(html).toContain('data-view="overview"')
  expect(html).toContain(`content="default-src 'none';`)
  const state = embedded(html)
  expect(state).toMatchObject({ schema: 1, tasks: { done: 5, total: 8 } })
  // Every spec file, not only the one in focus.
  expect(state.specs.map((s: { file: string }) => s.file)).toEqual(['SPEC.md', 'SPEC-auth.md'])
  // The same history as the board: the report written now shows the same ETA.
  expect(state.forecast.kind).toBe('range')
  await $.command.run(run('report'))
  const day = Number(state.forecast.median.slice(8))
  expect(files[`${CWD}/tasks/progress-report.html`]).toMatch(new RegExp(`<span class="k">ETA</span><span class="v">${day} \\w{3}</span>`))
})

test('/progress dashboard <view> opens on that view; an unknown one lists the views and writes nothing', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files)
  await $.command.run(run('dashboard overview'))
  expect(files[`${CWD}/tasks/progress-dashboard.html`]).toContain('data-view="overview"')
  delete files[`${CWD}/tasks/progress-dashboard.html`]
  const out = await $.command.run(run('dashboard nope'))
  expect(out.text).toMatch(/No view "nope"\. Views: overview/)
  expect(files[`${CWD}/tasks/progress-dashboard.html`]).toBeUndefined()
})

test('/progress dashboard with no task list still writes a page that says how to start', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/SPEC.md`]: SPEC }
  // Nobody at this machine: the page is written, not opened.
  const seen = world(on, files, 'no-repo', {}, [])
  expect((await $.command.run(run('dashboard'))).text).toMatch(/Open \/p\/tasks\/progress-dashboard\.html in a browser/)
  expect(seen.launched).toEqual([])
  expect(files[`${CWD}/tasks/progress-dashboard.html`]).toContain('No task list yet')
})

// format-v2 T1: every way the plugin rewrites a Status line keeps the owner, PR and reviewer.
test('owners, PRs and reviewers survive /progress start, done, block and a Write of the list', async ($, on) => {
  const own = (todo: string, id: string, title: string, line: string) => todo.replace(`## Task ${id}: ${title}\n`, `## Task ${id}: ${title}\n**Status:** ${line}\n`)
  const todo = own(own(TODO_TEMPLATE, '3', 'Issue and revoke keys', 'todo · @sara'), '4', 'Rate limit per key', 'todo · @bob · PR #7 · reviewer @amila')
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: todo }
  world(on, files)
  const line = (id: string) => files[`${CWD}/tasks/todo.md`]!.split('\n').find((_, i, all) => all[i - 1]?.startsWith(`## Task ${id}:`))
  await $.command.run(run('start T3'))
  expect(line('3')).toMatch(/^\*\*Status:\*\* in progress · @sara · started \d{4}-\d{2}-\d{2}$/)
  await $.command.run(run('block T4 "which store?"'))
  expect(line('4')).toBe('**Status:** blocked · @bob · PR #7 · reviewer @amila')
  await $.command.run(run('done T3'))
  expect(line('3')).toMatch(/^\*\*Status:\*\* done · @sara · started \S+ · done \S+$/)
  // The agent writes the whole list again: the plugin completes it, and keeps what it carries.
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/tasks/todo.md`, content: files[`${CWD}/tasks/todo.md`]! } as never)
  expect(line('3')).toMatch(/· @sara ·/)
  expect(line('4')).toBe('**Status:** blocked · @bob · PR #7 · reviewer @amila')
})

// format-v2 T2 (F1): set a team up, and see who you are.
const TEAM_MD = '---\napprovals: design, eng\n---\n# Team\n\n| Handle | Role | Email |\n|---|---|---|\n| @amila | lead, eng | amila@example.com |\n| @sara | design | sara@example.com |\n'
const asPerson = (email: string, authors = '') => ({ log: authors, cat: '', answer: (argv: string[]) => (argv[1] === 'config' ? `${email}\n` : '') })

test('/progress team names the team and you; without the file it says how to start', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/tasks/team.md`]: TEAM_MD }, asPerson('sara@example.com'))
  const out = await $.command.run(run('team'))
  expect(out.text).toMatch(/@sara +design +← you/)
  expect(out.text).toMatch(/A spec needs approval from: design, eng\./)
})

// ceremonies T11 (C7): the decisions inbox.
test('/progress inbox: what waits on you by your git email, on a handle, or on anyone; writes nothing', async ($, on) => {
  const files: Record<string, string> = {
    [`${CWD}/SPEC.md`]: SPEC,
    [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE,
    [`${CWD}/tasks/plan.md`]: '# Plan\n\n## Open Questions\n- Q1 (T4): @sara, which region first?\n',
    [`${CWD}/tasks/team.md`]: TEAM_MD,
  }
  world(on, files, asPerson('sara@example.com'))
  expect((await $.command.run(run('inbox'))).text!.split('\n')).toEqual([
    'Inbox · you (@sara) · 3 waiting',
    'Questions to answer',
    '  ♦ Q1 (T4): @sara, which region first? · holds up T4',
    '  ♦ Should keys expire by default?',
    'Specs to sign',
    '  ♦ approve SPEC.md · as design',
  ])
  const amila = (await $.command.run(run('inbox @amila'))).text!
  expect(amila).toContain('Inbox · @amila · 2 waiting')
  expect(amila).toContain('  ♦ approve SPEC.md · as eng')
  expect(amila).not.toContain('Q1')
  expect((await $.command.run(run('inbox all'))).text).toContain('  ♦ approve SPEC.md · waiting on @sara (design), @amila (eng)')
  expect((await $.command.run(run('inbox @zed'))).text!.split('\n')[0]).toBe('@zed is not in tasks/team.md: showing what names them or nobody.')
  expect(Object.keys(files)).toHaveLength(4)
})

test('/progress dashboard inbox opens the page on the Inbox tab (T13)', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/SPEC.md`]: SPEC, [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/tasks/team.md`]: TEAM_MD }
  const seen = world(on, files, asPerson('sara@example.com'))
  expect((await $.command.run(run('dashboard inbox'))).text).toMatch(/on inbox\./)
  const html = files[`${CWD}/tasks/progress-dashboard.html`]!
  expect(html).toContain('<body data-view="inbox">')
  expect(html).toContain('<select id="inbox-who" data-me="sara">')
  expect(html).not.toContain('<button')
  expect(seen.launched).toHaveLength(1)
})

test('/progress inbox with nothing waiting says so', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  expect((await $.command.run(run('inbox'))).text).toBe('✓ Nothing is waiting on you.')
})

test('/progress team init drafts tasks/team.md from the git authors, and never overwrites it without force', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files, asPerson('amila@example.com', 'Amila Perera\tamila@example.com\nSara K\tsara@example.com\nAmila Perera\tamila@example.com\n'))
  expect((await $.command.run(run('team init'))).text).toMatch(/Wrote tasks\/team\.md with 2 people .*fill in their roles/)
  expect(files[`${CWD}/tasks/team.md`]).toMatch(/\| @amila-perera \| {2}\| amila@example\.com \|\n\| @sara-k \| {2}\| sara@example\.com \|/)
  files[`${CWD}/tasks/team.md`] = TEAM_MD
  expect((await $.command.run(run('team init'))).text).toMatch(/tasks\/team\.md is already here.*\/progress team init force/)
  expect(files[`${CWD}/tasks/team.md`]).toBe(TEAM_MD)
  await $.command.run(run('team init force'))
  expect(files[`${CWD}/tasks/team.md`]).toMatch(/@amila-perera/)
})

// format-v2 T3 (F2, F3): assign, claim, unassign.
test('/progress assign, claim and unassign write the owner and say so', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/tasks/team.md`]: TEAM_MD }
  world(on, files, asPerson('sara@example.com'))
  const line = (id: string) => files[`${CWD}/tasks/todo.md`]!.split('\n').find((_, i, all) => all[i - 1]?.startsWith(`## Task ${id}:`))
  expect((await $.command.run(run('assign T3 @amila'))).text).toBe('T3 Issue and revoke keys → @amila.')
  expect(line('3')).toBe('**Status:** todo · @amila')
  expect((await $.command.run(run('claim T4'))).text).toBe('T4 Rate limit per key → @sara (you).')
  expect(line('4')).toBe('**Status:** todo · @sara')
  expect((await $.command.run(run('assign 3 me'))).text).toBe('T3 Issue and revoke keys → @sara (you), was @amila.')
  expect((await $.command.run(run('assign T3 zoe'))).text).toBe('T3 Issue and revoke keys → @zoe, was @sara. @zoe is not in tasks/team.md (/progress team).')
  expect((await $.command.run(run('unassign T3'))).text).toBe('T3 Issue and revoke keys has no owner now (was @zoe).')
  expect(line('3')).toBe('**Status:** todo')
  expect((await $.command.run(run('assign T9 @sara'))).text).toMatch(/^No "## Task 9:" section in tasks\/todo\.md\. Tasks: T1, T2, T3, T4\./)
  expect((await $.command.run(run('assign T3'))).text).toBe('Say who: /progress assign T3 @sara, or /progress claim T3 for yourself.')
})

// ceremonies T1: a task's size, written and cleared by /progress size, shown by /progress task.
test('/progress size writes and clears the Size line and says so; a bad size or task is refused and writes nothing', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files)
  expect((await $.command.run(run('size T4 L'))).text).toBe('T4 Rate limit per key is size L (2 points).')
  expect(files[`${CWD}/tasks/todo.md`]).toBe(TODO_TEMPLATE.replace('## Task 4: Rate limit per key\n', '## Task 4: Rate limit per key\n**Size:** L\n'))
  expect((await $.command.run(run('task T4'))).text.split('\n')[1]).toBe('to do · size L (2 points)')
  expect((await $.command.run(run('size 4 s'))).text).toBe('T4 Rate limit per key is size S (½ point), was L.')
  expect((await $.command.run(run('size T4 -'))).text).toBe('T4 Rate limit per key has no size now (was S): it counts as 1 point, like M.')
  expect(files[`${CWD}/tasks/todo.md`]).toBe(TODO_TEMPLATE)
  expect((await $.command.run(run('size T4 XL'))).text).toBe('"XL" is not a size. Use S, M or L, or - to clear it: /progress size T4 M.')
  expect((await $.command.run(run('size T9 M'))).text).toMatch(/^No "## Task 9:" section in tasks\/todo\.md\./)
  expect((await $.command.run(run('size T4'))).text).toBe('Say the size: /progress size T4 M (S, M or L; - clears it).')
  expect(files[`${CWD}/tasks/todo.md`]).toBe(TODO_TEMPLATE)
})

// ceremonies T6 (C1, C5): starting a sprint, and the sprint now in the reply, the band and the board pane.
test('/progress sprint start writes sprint: and commit:; /progress sprint, the band and the board pane show it', async ($, on) => {
  // Yesterday's commit had no T4: added since, it is scope added.
  const yesterday = TODO_TEMPLATE.slice(0, TODO_TEMPLATE.indexOf('## Task 4'))
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files, gitOutput([['2026-10-08', yesterday]]))
  expect((await $.command.run(run('sprint'))).text).toBe('No sprint running. To start one that ends in two weeks: /progress sprint start 2026-10-22 T2 T3 T4')
  const props = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } as never
  const band = await $.ui.mount({ plugin: 'agent-skills-mods', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await band.find({ text: /^sprint/ })).toBeUndefined()

  expect((await $.command.run(run('sprint start 2026-10-01 T2'))).text).toBe('2026-10-01 is before today (2026-10-09): a sprint starts today and ends on or after it.')
  expect((await $.command.run(run('sprint start 2026-10-16'))).text).toBe('Say which tasks it commits to: /progress sprint start 2026-10-16 T4 T5 T7.')
  expect((await $.command.run(run('sprint start 2026-10-16 T1'))).text).toBe('T1 Monorepo scaffold is done already: a sprint commits to work still to do.')
  expect(files[`${CWD}/tasks/todo.md`]).toBe(TODO_TEMPLATE)

  expect((await $.command.run(run('sprint start 2026-10-16 T2 t3'))).text).toBe('Sprint started: 9 Oct – 16 Oct, 6 working days. Committed T2, T3 (2 points).')
  expect(files[`${CWD}/tasks/todo.md`]).toBe(`---\nsprint: 2026-10-09..2026-10-16\ncommit: T2, T3\n---\n${TODO_TEMPLATE}`)
  expect((await $.command.run(run('sprint'))).text!.split('\n')).toEqual([
    'Sprint · 9 Oct – 16 Oct · 6 of 6 working days left',
    'Committed: 0 of 2 done · 0 of 2 points',
    '  ○ T2 Prisma schema for keys',
    '  ○ T3 Issue and revoke keys',
    'Added since the start: +1, 0 done',
    '  ○ T4 Rate limit per key',
  ])
  await band.redraw(props)
  expect(await band.find({ text: /^sprint · 6d left · 0\/2 committed · \+1$/ })).toBeDefined()
  const board = await mountBoard($)
  expect(await board.find({ text: /^sprint · 6d left · 0\/2 committed · \+1$/ })).toBeDefined()
  expect((await $.command.run(run('sprint stop'))).text).toBe('Use: /progress sprint, or /progress sprint start 2026-10-24 T4 T5 (it starts today and ends that day).')
})

// ceremonies T8 (C5): the sprint review, rebuilt from tasks/todo.md's history and copied.
test('/progress report sprint reviews the last ended sprint from history, copies it and writes nothing; /progress sprint shows it too', async ($, on) => {
  const S = '---\nsprint: 2026-09-28..2026-10-02\ncommit: T2, T3\n---\n'
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: S + TODO_T2_DONE }
  const seen = world(on, files, gitOutput([['2026-10-02', S + TODO_T2_DONE], ['2026-09-28', S + TODO_TEMPLATE.slice(0, TODO_TEMPLATE.indexOf('## Task 4'))]]))
  const out = (await $.command.run(run('report sprint'))).text!
  const text = out.split('\n\n')[0]!
  expect(text.split('\n')).toEqual([
    'Sprint review · 28 Sep – 2 Oct · ended 2 Oct',
    '1 of 2 committed done (1 of 2 points) · +1 added · 1 carries over',
    'Done',
    '  ✓ T2 Prisma schema for keys',
    'Carries over',
    '  ○ T3 Issue and revoke keys',
    'Added, not done',
    '  ○ T4 Rate limit per key',
    'Demo checklist',
    '  - [ ] T2 Prisma schema for keys: Key table with hashed secret',
    '  - [ ] T2 Prisma schema for keys: Migration runs on a clean database',
  ])
  expect(out.endsWith('\n\nCopied to the clipboard.')).toBe(true)
  expect(seen.copied).toEqual([text])
  expect((await $.command.run(run('report sprint 2026-11-02'))).text).toBe('No sprint ran on 2026-11-02. Sprints: 28 Sep – 2 Oct.')
  expect((await $.command.run(run('report sprint soon'))).text).toBe('Use: /progress report sprint, or /progress report sprint 2026-10-13 for the sprint that day fell in.')
  const sprint = (await $.command.run(run('sprint'))).text!
  expect(sprint.startsWith(`${text}\n\nThe sprint has ended. To start the next, for two weeks: /progress sprint start 2026-10-22 T3 T4`)).toBe(true)
  // Read from git objects already here: nothing written, nothing committed.
  expect(Object.keys(files)).toEqual([`${CWD}/tasks/todo.md`])
  expect(files[`${CWD}/tasks/todo.md`]).toBe(S + TODO_T2_DONE)
  expect(seen.git.every(c => /^git (log|cat-file|rev-list|config|for-each-ref|rev-parse)$/.test(c))).toBe(true)
})

// ceremonies T9 (C6): the retro, about the work and never about people.
test('/progress retro looks back on the whole plan without a sprint; no owner in the reply', async ($, on) => {
  const task = (n: number, owner: string, started: string, done: string) => `## Task ${n}: Part ${n}\n**Status:** done · ${owner} · started ${started} · done ${done}\n**Size:** S\n- [x] works\n`
  const todo = [task(1, '@amila', '2026-10-01', '2026-10-02'), task(2, '@sara', '2026-10-02', '2026-10-03'), task(3, '@amila', '2026-10-03', '2026-10-04'), task(4, '@sara', '2026-10-03', '2026-10-08'), '## Task 5: Next\n- [ ] later\n'].join('\n')
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: todo }
  world(on, files)
  const out = (await $.command.run(run('retro'))).text!
  expect(out.split('\n').slice(0, 3)).toEqual(['Retro · the whole plan (no sprint)', 'Slow against their size', '  T4 Part 4 (S) took 5d, the usual S is 1d'])
  expect(out).not.toMatch(/@\w|amila|sara/)
  expect(Object.keys(files)).toEqual([`${CWD}/tasks/todo.md`])
  expect((await $.command.run(run('retro now'))).text).toMatch(/^Unknown argument "retro now"/)
})

// ceremonies T7 (C1): the sprint plan replies with the proposal and the start line, and writes nothing.
test('/progress sprint plan proposes by count without a pace, names what is not ready, prints the start line and writes nothing', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files)
  expect((await $.command.run(run('sprint plan'))).text!.split('\n')).toEqual([
    'Sprint plan · 10 working days · no pace yet (under 2 working days of history), so by count: every ready task, keep what fits',
    '  T2  Prisma schema for keys  -  1  running 1  under way',
    '  - no size: counts as 1 point',
    'Not ready:',
    '  ✗ T3  Issue and revoke keys   no verification',
    '  ✗ T4  Rate limit per key      no verification',
    'To start it: /progress sprint start 2026-10-22 T2',
  ])
  expect((await $.command.run(run('sprint plan 5'))).text!.split('\n').at(-1)).toBe('To start it: /progress sprint start 2026-10-15 T2')
  expect((await $.command.run(run('sprint plan two'))).text).toBe('"two" is not a number of working days. Use: /progress sprint plan 10 (1 to 60; 10 by default).')
  expect(files).toEqual({ [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
})

// ceremonies T3: the backlog, listed and added to; the file is made on the first add.
test('/progress backlog lists the items with sizes; backlog add appends the next B id, making the file first', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files)
  expect((await $.command.run(run('backlog'))).text).toBe('No tasks/backlog.md here. /progress backlog add "title" [S|M|L] starts one.')
  expect((await $.command.run(run('backlog add "Per-tenant quotas" L'))).text).toBe('Started tasks/backlog.md with B1 Per-tenant quotas (L).')
  expect(files[`${CWD}/tasks/backlog.md`]).toBe('---\nbacklog: api-keys\n---\n# Backlog\n\n## B1: Per-tenant quotas\n**Size:** L\n')
  expect((await $.command.run(run('backlog add Audit log export'))).text).toBe('Added B2 Audit log export to tasks/backlog.md (no size: it counts as 1 point).')
  expect((await $.command.run(run('backlog add Retry policy s'))).text).toBe('Added B3 Retry policy (S) to tasks/backlog.md.')
  expect((await $.command.run(run('backlog'))).text).toBe(
    ['Backlog · tasks/backlog.md · 3 items, 3½ points', '  B1  Per-tenant quotas  L', '  B2  Audit log export   no size', '  B3  Retry policy       S'].join('\n'),
  )
  expect((await $.command.run(run('backlog add'))).text).toBe('Say what it is: /progress backlog add "Per-tenant quotas" [S|M|L].')
  expect((await $.command.run(run('backlog add "Docs" XL'))).text).toBe('"XL" is not a size. Use S, M or L: /progress backlog add "Docs" M.')
  expect((await $.command.run(run('backlog nope'))).text).toBe('Use: /progress backlog, or /progress backlog add "title" [S|M|L].')
  expect(files[`${CWD}/tasks/todo.md`]).toBe(TODO_TEMPLATE)
  files[`${CWD}/tasks/backlog.md`] += '\n## B2: Again\n- [ ] x\n'
  expect((await $.command.run(run('doctor'))).text).toContain('tasks/backlog.md\n  × B2 is used by 2 items; give each item its own number')
})

// ceremonies T4: pull and defer from the command line, and a file changed under them writes neither.
test('/progress defer and pull move a task between the two files and say so; refusals write nothing', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files)
  expect((await $.command.run(run('defer T2'))).text).toBe('T2 Prisma schema for keys is started: only a task not yet started goes back to the backlog.')
  expect(`${CWD}/tasks/backlog.md` in files).toBe(false)
  expect((await $.command.run(run('defer t4'))).text).toBe('T4 Rate limit per key is deferred: it is B1 in tasks/backlog.md now, and /progress pull B1 brings it back as T4.')
  expect(files[`${CWD}/tasks/backlog.md`]).toContain('## B1: Rate limit per key\n**Was:** T4 · deferred 2026-10-09\n')
  expect(files[`${CWD}/tasks/todo.md`]).not.toContain('Task 4')
  expect((await $.command.run(run('pull B7'))).text).toBe('No B7 in tasks/backlog.md. Items: B1.')
  expect((await $.command.run(run('pull b1'))).text).toBe('B1 Rate limit per key is T4 in tasks/todo.md now, its old number, after the last task.')
  expect(files[`${CWD}/tasks/todo.md`]).toBe(TODO_TEMPLATE.replace('## Task 4: Rate limit per key\n', '## Task 4: Rate limit per key\n**Status:** todo\n'))
  expect((await $.command.run(run('pull'))).text).toBe('Say which item: /progress pull B3.')
})

// ceremonies T5: what isn't ready to start, from the list, the plan's open questions and the backlog; nothing written.
test('/progress ready lists each task not ready with its reasons, and writes nothing', async ($, on) => {
  const todo = TODO_TEMPLATE.replace('**Dependencies:** 1\n', '**Dependencies:** 1, B2\n')
  const plan = '# Plan\n\n## Open Questions\n\n- Q1: Does T3 need a flag?\n  → A: No · @lucksy 2026-10-11\n- Q2: Should T4 count bursts?\n'
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: todo, [`${CWD}/tasks/plan.md`]: plan, [`${CWD}/tasks/backlog.md`]: '# Backlog\n\n## B2: Quotas\n- [ ] per tenant\n' }
  world(on, files)
  expect((await $.command.run(run('ready'))).text).toBe(
    [
      'Not ready · 2 of 2 tasks not yet started',
      '  ✗ T3  Issue and revoke keys  no verification, waits on T2 · no size',
      '  ✗ T4  Rate limit per key     no verification, waits on Q2, backlog B2 · no size',
      "✗ can't start yet · ○ can start; a size is recommended",
    ].join('\n'),
  )
  expect(files[`${CWD}/tasks/todo.md`]).toBe(todo)
  expect(files[`${CWD}/tasks/plan.md`]).toBe(plan)
})

test('/progress pull writes neither file when one changed while it ran', async ($, on) => {
  const backlog = '# Backlog\n\n## B1: Quotas\n- [ ] per tenant\n'
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  // The backlog as the action reads it, then changed by someone else before the write.
  let reads = 0
  Object.defineProperty(files, `${CWD}/tasks/backlog.md`, { enumerable: true, configurable: true, get: () => (++reads > 1 ? `${backlog}\n## B2: Theirs\n` : backlog) })
  world(on, files)
  expect((await $.command.run(run('pull B1'))).text).toBe('tasks/backlog.md changed while this ran, so nothing was written. Run it again.')
  expect(files[`${CWD}/tasks/todo.md`]).toBe(TODO_TEMPLATE)
})

test('claim needs to know who you are', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files, asPerson('sara@example.com'))
  expect((await $.command.run(run('claim T3'))).text).toBe("Can't tell who you are: no tasks/team.md here. /progress team init sets one up; or name someone: /progress assign T3 @name.")
  files[`${CWD}/tasks/team.md`] = TEAM_MD.replace('sara@example.com', 'sara@elsewhere.org')
  expect((await $.command.run(run('claim T3'))).text).toBe("Can't tell who you are: sara@example.com is not in tasks/team.md. Add a row with it, or name someone: /progress assign T3 @name.")
  expect(files[`${CWD}/tasks/todo.md`]).toBe(TODO_TEMPLATE)
})

// format-v2 T4: work on an unowned task claims it for whoever runs the session.
test('auto-claim: the first step on an unowned task writes you as its owner; an owned task keeps its owner', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/tasks/team.md`]: TEAM_MD }
  world(on, files, asPerson('sara@example.com'))
  await $.command.run(run('refresh'))
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete({ answer: 'done' } as never)
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/## Task 2: Prisma schema for keys\n\*\*Status:\*\* in progress · @sara · started 2026-10-09 · step build\n/)
  // Someone else's task stays theirs.
  files[`${CWD}/tasks/todo.md`] = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** todo · @amila\n')
  await $.command.run(run('refresh'))
  await $.tool.call({ tool: 'Bash', command: 'pnpm test keys' } as never)
  await $.turn.complete({ answer: 'done' } as never)
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/\*\*Status:\*\* in progress · @amila · started 2026-10-09 · step test\n/)
})

test('/progress start claims an unowned task too', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/tasks/team.md`]: TEAM_MD }
  world(on, files, asPerson('amila@example.com'))
  await $.command.run(run('start T3'))
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/## Task 3: Issue and revoke keys\n\*\*Status:\*\* in progress · @amila · started 2026-10-09\n/)
})

test('auto-claim does nothing without tasks/team.md, or when it does not know you', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  world(on, files, asPerson('sara@example.com'))
  await $.command.run(run('refresh'))
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/keys.ts`, old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete({ answer: 'done' } as never)
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/\*\*Status:\*\* in progress · started 2026-10-09 · step build\n/)
  files[`${CWD}/tasks/team.md`] = TEAM_MD.replace('sara@example.com', 'sara@elsewhere.org')
  await $.command.run(run('start T3'))
  expect(files[`${CWD}/tasks/todo.md`]).toMatch(/## Task 3: Issue and revoke keys\n\*\*Status:\*\* in progress · started 2026-10-09\n/)
})

// format-v2 T5 (F4): put a task up for review.
test('/progress review sets in review with its PR and reviewer; a done or untouched task is refused', async ($, on) => {
  const todo = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · @amila · started 2026-10-07 · step test\n')
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: todo, [`${CWD}/tasks/team.md`]: TEAM_MD }
  world(on, files, asPerson('amila@example.com'))
  const line = (id: string) => files[`${CWD}/tasks/todo.md`]!.split('\n').find((_, i, all) => all[i - 1]?.startsWith(`## Task ${id}:`))
  expect((await $.command.run(run('review T2 #42 @sara'))).text).toBe('T2 Prisma schema for keys is in review: PR #42, reviewer @sara.')
  expect(line('2')).toBe('**Status:** in review · @amila · started 2026-10-07 · PR #42 · reviewer @sara')
  expect((await $.command.run(run('review T2 https://github.com/acme/api/pull/43'))).text).toBe('T2 Prisma schema for keys is in review: PR https://github.com/acme/api/pull/43, reviewer @sara.')
  expect((await $.command.run(run('review T1'))).text).toBe('T1 Monorepo scaffold is done: a review comes before its last box is ticked.')
  expect((await $.command.run(run('review T3'))).text).toBe('T3 Issue and revoke keys has no box ticked yet: build it first, or /progress start T3.')
  expect((await $.command.run(run('review T2 later'))).text).toBe('Not a PR or a reviewer: "later". Use /progress review T2 #42 @bob (both optional).')
})

test('handles and PR links keep the case they were typed in', async ($, on) => {
  const todo = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · started 2026-10-07\n')
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: todo }
  world(on, files, asPerson('x@example.com'))
  await $.command.run(run('assign T2 @Sara-K'))
  await $.command.run(run('review T2 https://github.com/Acme/API/pull/42 @Bob'))
  expect(files[`${CWD}/tasks/todo.md`]).toContain('**Status:** in review · @Sara-K · started 2026-10-07 · PR https://github.com/Acme/API/pull/42 · reviewer @Bob')
})

// format-v2 T7 (F6): hand a task over, with a note.
test('/progress handoff sets the new owner and leaves a dated note; it needs a note and a handle', async ($, on) => {
  const todo = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · @sara · started 2026-10-07\n')
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: todo, [`${CWD}/tasks/team.md`]: TEAM_MD }
  world(on, files, asPerson('sara@example.com'))
  expect((await $.command.run(run('handoff T2 @amila "Migration done; tests left"'))).text).toBe('T2 Prisma schema for keys → @amila, from @sara. Note: "Migration done; tests left".')
  expect(files[`${CWD}/tasks/todo.md`]).toContain('**Status:** in progress · @amila · started 2026-10-07\n**Handoff:** 2026-10-09 @sara → @amila: Migration done; tests left\n')
  expect((await $.command.run(run('handoff T2 @bob'))).text).toBe('Say what the next person needs to know: /progress handoff T2 @bob "migration done, tests left".')
  expect((await $.command.run(run('handoff T2 "note"'))).text).toBe('Say who takes it: /progress handoff T2 @bob "note".')
})

// format-v2 T8 (F5): the spec pane signs by role when tasks/team.md asks for approvals.
test('the spec pane signs for your roles, and approves only on the last signature', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/SPEC.md`]: SPEC, [`${CWD}/tasks/team.md`]: TEAM_MD }
  const seen = world(on, files, asPerson('sara@example.com'))
  await $.command.run({ command: 'spec-view', args: '', origin: { kind: 'composer' } } as never)
  const pane = await mountSpec($)
  expect(await pane.find({ text: /^0\/2 approved · waiting on @sara \(design\), @amila \(eng\)$/ })).toBeDefined()
  await pane.press({ key: 'spec-approve' })
  expect(files[`${CWD}/SPEC.md`]).toMatch(/^---\nstatus: draft\ncreated: 2026-10-09\napprovals: design @sara 2026-10-09\n---/)
  expect(seen.toasts).toContain('✓ @sara signed SPEC.md for design · waiting on @amila (eng)')
  expect(await pane.find({ text: /^1\/2 approved · waiting on @amila \(eng\)$/ })).toBeDefined()
  // Sara takes on eng too, and signs for it: the last role approves the spec.
  files[`${CWD}/tasks/team.md`] = TEAM_MD.replace('| @sara | design |', '| @sara | design, eng |')
  await pane.press({ key: 'spec-approve' })
  expect(files[`${CWD}/SPEC.md`]).toMatch(/^---\nstatus: approved\ncreated: 2026-10-09\napprovals: design @sara 2026-10-09, eng @sara 2026-10-09\napproved: 2026-10-09\n---/)
  expect(seen.toasts).toContain('✓ SPEC.md approved: every role has signed (design, eng)')
  await pane.press({ key: 'spec-draft' })
  expect(files[`${CWD}/SPEC.md`]).not.toContain('approvals:')
})

test('signing needs a role the spec still waits on, and to know who you are', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/SPEC.md`]: SPEC, [`${CWD}/tasks/team.md`]: TEAM_MD.replace('| @sara | design |', '| @sara | qa |') }
  const seen = world(on, files, asPerson('sara@example.com'))
  await $.command.run({ command: 'spec-view', args: '', origin: { kind: 'composer' } } as never)
  const pane = await mountSpec($)
  await pane.press({ key: 'spec-approve' })
  expect(seen.toasts).toContain('@sara (qa) holds no role SPEC.md still waits on: design, eng.')
  expect(files[`${CWD}/SPEC.md`]).toBe(SPEC)
  files[`${CWD}/tasks/team.md`] = TEAM_MD.replace('sara@example.com', 'sara@elsewhere.org')
  await pane.press({ key: 'spec-approve' })
  expect(seen.toasts).toContain("Can't sign: sara@example.com is not in tasks/team.md.")
})

// format-v2 T10 (F7): every module at a glance.
const MAP_MD = '---\nstatus: approved\n---\n# Capability Map: keys\n\n| Module id | Responsibility | Depends on |\n|---|---|---|\n| core | Library | — |\n| api | The API | core |\n| ui | Console | api |\n'
test('/progress modules lists each module of the capability map, archived plans included', async ($, on) => {
  const archived = '---\nplan: core\ncreated: 2026-09-20\n---\n## Task 1: Lib\n**Status:** done · started 2026-09-20 · done 2026-09-25\n- [x] lib\n'
  const active = `---\nplan: api\nmodule: api\ncreated: 2026-10-01\n---\n${TODO_TEMPLATE.replace(/^# .*\n/, '')}`
  world(on, { [`${CWD}/SPEC.md`]: MAP_MD, [`${CWD}/SPEC-api.md`]: SPEC, [`${CWD}/tasks/todo.md`]: active, [`${CWD}/tasks/archive/2026-09-26-core/todo.md`]: archived, [`${CWD}/tasks/archive/2026-09-26-core/README.md`]: '# x\n' })
  const out = (await $.command.run(run('modules'))).text
  expect(out).toMatch(/^Modules · SPEC\.md · 3 modules · 1 done/)
  expect(out).toMatch(/✓ core +done · 1\/1 · no spec file · finished 25 Sep \(tasks\/archive\/2026-09-26-core\)/)
  expect(out).toMatch(/● api +building · 1\/4 · spec draft · started 1 Oct/)
  expect(out).toMatch(/○ ui +not started · needs api/)
})

test('/progress modules without a capability map says where one goes', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/SPEC.md`]: SPEC })
  expect((await $.command.run(run('modules'))).text).toBe('No capability map in SPEC.md: a table under a "# Capability Map" heading, with a Module id column, lists the modules (the spec skill writes one when a request spans several).')
})

test('/progress modules <id> prints that module\'s run timeline, from its archive', async ($, on) => {
  const archived = '---\nplan: core\ncreated: 2026-09-20\n---\n## Task 1: Lib\n**Status:** done · started 2026-09-20 · done 2026-09-25\n- [x] lib\n'
  world(on, { [`${CWD}/SPEC.md`]: MAP_MD, [`${CWD}/tasks/archive/2026-09-26-core/todo.md`]: archived, [`${CWD}/tasks/archive/2026-09-26-core/history.json`]: '[{"day":"2026-09-25","done":1,"total":1}]' })
  const out = (await $.command.run(run('modules core'))).text
  expect(out).toMatch(/^Module core · done · 1\/1 · plan core in tasks\/archive\/2026-09-26-core/)
  expect(out).toMatch(/✓ T1 Lib +▬▬▬ done 25 Sep/)
  expect((await $.command.run(run('modules ui'))).text).toBe('ui has no plan yet (not started; needs api).')
})

// team-view T2: answer an open question, sign off the checkpoint that is due.
const PLAN_MD = '# Plan\n\n## Open Questions\n\n- Q1 (T3): argon2 or bcrypt?\n- Q2 (T4): Upstash or self-hosted?\n'
test('/progress answer writes your answer under the question; the question drops out of what needs you', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/tasks/plan.md`]: PLAN_MD, [`${CWD}/tasks/team.md`]: TEAM_MD }
  world(on, files, asPerson('sara@example.com'))
  expect((await $.command.run(run('answer Q2 "Upstash, with a fallback"'))).text).toBe('Q2 answered: "Upstash, with a fallback" · @sara 2026-10-09.')
  expect(files[`${CWD}/tasks/plan.md`]).toBe(PLAN_MD.replace('self-hosted?\n', 'self-hosted?\n  → A: Upstash, with a fallback · @sara 2026-10-09\n'))
  expect((await $.command.run(run('answer Q9 "x"'))).text).toBe('No Q9 under Open Questions in tasks/plan.md. Questions: Q1, Q2.')
  expect((await $.command.run(run('answer'))).text).toBe('Say which question and the answer: /progress answer Q2 "Upstash".')
  const digest = (await $.command.run(run('digest'))).text
  expect(digest).toContain('Q1 (T3): argon2 or bcrypt?')
  expect(digest).not.toContain('Q2 (T4)')
})

test('/progress signoff signs the checkpoint that is due; with none due it says why and writes nothing', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/tasks/team.md`]: TEAM_MD }
  world(on, files, asPerson('amila@example.com'))
  expect((await $.command.run(run('signoff'))).text).toBe('No checkpoint is due: "After Tasks 1-2" comes after T2, which is not done yet.')
  expect(files[`${CWD}/tasks/todo.md`]).toBe(TODO_TEMPLATE)
  files[`${CWD}/tasks/todo.md`] = TODO_T2_DONE
  expect((await $.command.run(run('signoff'))).text).toBe('Checkpoint "After Tasks 1-2" signed off by @amila on 2026-10-09. Still open: All tests pass.')
  expect(files[`${CWD}/tasks/todo.md`]).toContain('## Checkpoint: After Tasks 1-2\n**Signed off:** @amila 2026-10-09\n- [ ] All tests pass\n- [x] Review with human before proceeding\n')
  expect((await $.command.run(run('signoff'))).text).toBe('No checkpoint is due: every checkpoint reached is signed off.')
})

// team-view T8: the merge driver is installed only after a yes, and uninstall puts both files back.
const ATTRS_BEFORE = '*.png binary\n'
const CONFIG_BEFORE = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = git@example.com:x.git\n'
const inRepo = { log: '', cat: '', answer: (argv: string[]) => (argv[1] === 'rev-parse' ? '.git\n' : '') }
test('/progress merge-driver install asks first, writes exactly the spec\'s lines, and uninstall restores both files byte for byte', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [`${CWD}/.gitattributes`]: ATTRS_BEFORE, [`${CWD}/.git/config`]: CONFIG_BEFORE }
  world(on, files, inRepo)
  expect((await $.command.run(run('merge-driver'))).text).toBe('The merge driver is not installed. /progress merge-driver install shows what it writes and asks first.')

  const asked = (await $.command.run(run('merge-driver install'))).text
  // This copy's CLI, by its absolute path.
  const script = /driver = node (\/\S+\/scripts\/agent-skills-progress\.mjs) --merge/.exec(asked ?? '')?.[1] ?? ''
  expect(script).not.toBe('')
  files[script] = '// the CLI\n'
  expect(asked).toContain('tasks/todo.md   merge=agent-skills\n')
  expect(asked).toContain(`driver = node ${script} --merge %O %A %B %P`)
  expect(asked).toMatch(/Run `\/progress merge-driver install yes` to write them\.$/)
  expect(files[`${CWD}/.gitattributes`]).toBe(ATTRS_BEFORE)
  expect(files[`${CWD}/.git/config`]).toBe(CONFIG_BEFORE)

  expect((await $.command.run(run('merge-driver install yes'))).text).toMatch(/^Installed the merge driver/)
  expect(files[`${CWD}/.gitattributes`]).toBe(
    `${ATTRS_BEFORE}tasks/todo.md   merge=agent-skills\ntasks/plan.md   merge=agent-skills\nSPEC*.md        merge=agent-skills\nspecs/*.md      merge=agent-skills\ntasks/backlog.md merge=agent-skills\n`,
  )
  expect(files[`${CWD}/.git/config`]).toBe(`${CONFIG_BEFORE}[merge "agent-skills"]\n    name = agent-skills task-aware merge\n    driver = node ${script} --merge %O %A %B %P\n`)
  expect((await $.command.run(run('merge-driver status'))).text).toBe(`The merge driver is installed: git merges tasks/todo.md by task, tasks/backlog.md by item and specs' approvals by role. It runs ${script}.`)
  expect((await $.command.run(run('merge-driver install'))).text).toBe(`The merge driver is already installed; it runs ${script}.`)

  // A broken path: the plugin moved.
  delete files[script]
  expect((await $.command.run(run('merge-driver status'))).text).toMatch(new RegExp(`^Broken path: \\.git/config runs ${script.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}, which isn't there`))

  const removing = (await $.command.run(run('merge-driver uninstall'))).text
  expect(removing).toMatch(/Run `\/progress merge-driver uninstall yes` to remove them\.$/)
  expect(files[`${CWD}/.git/config`]).toContain('[merge "agent-skills"]')
  expect((await $.command.run(run('merge-driver uninstall yes'))).text).toMatch(/^Removed the merge driver/)
  expect(files[`${CWD}/.gitattributes`]).toBe(ATTRS_BEFORE)
  expect(files[`${CWD}/.git/config`]).toBe(CONFIG_BEFORE)
  expect((await $.command.run(run('merge-driver uninstall yes'))).text).toBe('The merge driver is not installed, so there is nothing to remove.')
})

test('/progress merge-driver: a .gitattributes install created goes again on uninstall; outside git it says so', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/.git/config`]: CONFIG_BEFORE }
  world(on, files, inRepo)
  await $.command.run(run('merge-driver install yes'))
  expect(files[`${CWD}/.gitattributes`]).toBe(ATTRIBUTE_TEXT)
  // Half installed: the lines without the driver.
  files[`${CWD}/.git/config`] = CONFIG_BEFORE
  expect((await $.command.run(run('merge-driver status'))).text).toMatch(/^\.gitattributes names the driver, but \.git\/config has no \[merge "agent-skills"\] entry/)
  await $.command.run(run('merge-driver uninstall yes'))
  expect(`${CWD}/.gitattributes` in files).toBe(false)
  expect(files[`${CWD}/.git/config`]).toBe(CONFIG_BEFORE)
  expect((await $.command.run(run('merge-driver install now'))).text).toBe('Use: /progress merge-driver [install|uninstall|status]. install and uninstall ask first.')
})

test('/progress merge-driver outside a git repository writes nothing', async ($, on) => {
  const files: Record<string, string> = {}
  world(on, files)
  expect((await $.command.run(run('merge-driver install yes'))).text).toBe('Not a git repository here, so there is no merge for the driver to run.')
  expect(Object.keys(files)).toEqual([])
})
const ATTRIBUTE_TEXT = 'tasks/todo.md   merge=agent-skills\ntasks/plan.md   merge=agent-skills\nSPEC*.md        merge=agent-skills\nspecs/*.md      merge=agent-skills\ntasks/backlog.md merge=agent-skills\n'
// team-view T3 (V1): the board across branches.
test('/progress branches shows each task\'s furthest state across refs, with the fetch age', async ($, on) => {
  const theirs = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in review · @bob · started 2026-10-07\n')
  const answer = (argv: string[], stdin = '') => {
    if (argv[1] === 'for-each-ref') return `refs/heads/main\t${'a'.repeat(40)}\t${Date.parse('2026-10-09T09:00:00Z') / 1000}\nrefs/remotes/origin/feat/keys\t${'b'.repeat(40)}\t${Date.parse('2026-10-08T09:00:00Z') / 1000}\nrefs/heads/docs\t${'c'.repeat(40)}\t${Date.parse('2026-10-08T09:00:00Z') / 1000}\n`
    if (argv[1] === 'rev-parse' && argv.includes('--abbrev-ref')) return `${'a'.repeat(40)}\nmain\n`
    if (argv[1] === 'rev-parse') return '.git\n'
    if (argv[1] === 'cat-file') return stdin.split('\n').filter(Boolean).map(l => (l.startsWith('b') ? `@@asm blob\n${theirs}\n` : `${l} missing\n`)).join('')
    return ''
  }
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }, { log: '', cat: '', answer })
  seen.git.length = 0
  const out = (await $.command.run(run('branches'))).text
  expect(out.split('\n')).toEqual([
    'Board across branches · main + 1 ref · never fetched',
    '✓ T1 Monorepo scaffold · done on main',
    '◐ T2 Prisma schema for keys · in review on origin/feat/keys @bob (never fetched)',
    '○ T3 Issue and revoke keys · todo',
    '○ T4 Rate limit per key · todo',
    'No tasks/todo.md on: docs.',
  ])
  // Git objects already here, nothing that fetches; asked again, the copies are not read twice.
  expect(seen.git.every(c => /^git (for-each-ref|rev-parse|cat-file|log|rev-list|config)$/.test(c))).toBe(true)
  expect(seen.git.filter(c => c === 'git cat-file')).toHaveLength(1)
  await $.command.run(run('branches'))
  expect(seen.git.filter(c => c === 'git cat-file')).toHaveLength(1)
})

// ceremonies T10 (C3): the team standup.
test('/progress standup team: a line per person from the branches and the commits naming tasks; copied', async ($, on) => {
  const here = TODO_TEMPLATE.replace('## Task 1: Monorepo scaffold\n', '## Task 1: Monorepo scaffold\n**Status:** done · done 2026-10-01\n').replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · @amila · started 2026-10-07 · step test\n')
  const theirs = here.replace('## Task 3: Issue and revoke keys\n', '## Task 3: Issue and revoke keys\n**Status:** done · @sara · started 2026-10-08 · done 2026-10-09\n').replace('- [ ] POST /keys returns the secret once', '- [x] POST /keys returns the secret once')
  const answer = (argv: string[], stdin = '') => {
    if (argv[1] === 'for-each-ref') return `refs/heads/feat/keys\t${'b'.repeat(40)}\t${Date.parse('2026-10-09T09:00:00Z') / 1000}\n`
    if (argv[1] === 'rev-parse' && argv.includes('--abbrev-ref')) return `${'a'.repeat(40)}\nmain\n`
    if (argv[1] === 'rev-parse') return '.git\n'
    if (argv[1] === 'cat-file') return stdin.split('\n').filter(Boolean).map(() => `@@asm blob\n${theirs}\n`).join('')
    return ''
  }
  const at = Date.parse('2026-10-08T15:00:00Z') / 1000
  const log = `amila@example.com\t${at}\tT2: migration\nsara@example.com\t${at}\tIT4 not a task\n`
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: here, [`${CWD}/tasks/team.md`]: TEAM_MD }
  const seen = world(on, files, { log, cat: '', answer })
  const out = (await $.command.run(run('standup team'))).text!
  const text = out.split('\n\n')[0]!
  expect(text.split('\n')).toEqual([
    'Team standup · Plan · Fri 9 Oct · done since Thu 8 Oct',
    '@amila: done T2 (commits) · today T2 (test, 2 boxes left) · blocked —',
    '@sara: done T3 · today — · blocked —',
    'Unowned: nothing under way',
  ])
  expect(out.endsWith('\n\nCopied to the clipboard.')).toBe(true)
  expect(seen.copied).toEqual([text])
  // Git objects already here, nothing that fetches; nothing written.
  expect(seen.git.every(c => /^git (for-each-ref|rev-parse|cat-file|log|rev-list|config)$/.test(c))).toBe(true)
  expect(Object.keys(files)).toEqual([`${CWD}/tasks/todo.md`, `${CWD}/tasks/team.md`])
})

test('/progress standup team outside a git repository reads this branch only', async ($, on) => {
  const here = TODO_TEMPLATE.replace('## Task 1: Monorepo scaffold\n', '## Task 1: Monorepo scaffold\n**Status:** done · done 2026-10-01\n').replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · @sara · started 2026-10-07\n')
  world(on, { [`${CWD}/tasks/todo.md`]: here, [`${CWD}/tasks/team.md`]: TEAM_MD })
  const lines = (await $.command.run(run('standup team'))).text!.split('\n')
  expect(lines.slice(1, 4)).toEqual(['@amila: nothing under way', '@sara: done — · today T2 (2 boxes left) · blocked —', 'Unowned: nothing under way'])
})

test('/progress branches outside a git repository says why there is no board', async ($, on) => {
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  expect((await $.command.run(run('branches'))).text).toBe('Not a git repository: the board across branches reads the other branches from git.')
})

// team-view T4 (V1): collision alerts.
test('starting a task under way on another branch shows the collision in the reply, the band and the board pane', async ($, on) => {
  const theirs = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · @bob · started 2026-10-07\n')
  const answer = (argv: string[], stdin = '') => {
    if (argv[1] === 'for-each-ref') return `refs/heads/main\t${'a'.repeat(40)}\t${Date.parse('2026-10-09T09:00:00Z') / 1000}\nrefs/heads/feat/rate-limit\t${'b'.repeat(40)}\t${Date.parse('2026-10-08T09:00:00Z') / 1000}\n`
    if (argv[1] === 'rev-parse' && argv.includes('--abbrev-ref')) return `${'a'.repeat(40)}\nmain\n`
    if (argv[1] === 'rev-parse') return '.git\n'
    if (argv[1] === 'cat-file') return stdin.split('\n').filter(Boolean).map(l => (l.startsWith('b') ? `@@asm blob\n${theirs}\n` : `${l} missing\n`)).join('')
    return ''
  }
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }, { log: '', cat: '', answer })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const props = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } as never
  const band = await $.ui.mount({ plugin: 'agent-skills-mods', surface: 'terminal', component: 'AbovePrompt', props })
  // T2 is current but not started here: no collision yet.
  expect(await band.find({ text: /is also/ })).toBeUndefined()
  const said = (await $.command.run(run('start T2'))).text
  expect(said).toContain('! T2 is also in progress on feat/rate-limit by @bob (2d)')
  await band.redraw(props)
  expect((await band.find({ text: /^! T2 is also in progress on feat\/rate-limit by @bob \(2d\)$/ }))?.props).toMatchObject({ color: 'warning' })
  const board = await mountBoard($)
  expect(await board.find({ text: /^ {2}! T2 is also in progress on feat\/rate-limit by @bob \(2d\)$/ })).toBeDefined()
  // Read from git objects already here: nothing that fetches.
  expect(seen.git.every(c => /^git (for-each-ref|rev-parse|cat-file|log|rev-list|config)$/.test(c))).toBe(true)
})

// team-view T5 (V1): the dashboard's Board across branches.
test('/progress dashboard puts the other branches on the Board: furthest states, refs and collisions', async ($, on) => {
  const here = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · @amila · started 2026-10-08\n')
  const theirs = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · @bob · started 2026-10-07\n')
  const answer = (argv: string[], stdin = '') => {
    if (argv[1] === 'for-each-ref') return `refs/heads/feat/rate-limit\t${'b'.repeat(40)}\t${Date.parse('2026-10-08T09:00:00Z') / 1000}\n`
    if (argv[1] === 'rev-parse' && argv.includes('--abbrev-ref')) return `${'a'.repeat(40)}\nmain\n`
    if (argv[1] === 'rev-parse') return '.git\n'
    if (argv[1] === 'cat-file') return stdin.split('\n').filter(Boolean).map(() => `@@asm blob\n${theirs}\n`).join('')
    return ''
  }
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: here }
  const seen = world(on, files, { log: '', cat: '', answer })
  await $.command.run(run('dashboard board'))
  const html = files[`${CWD}/tasks/progress-dashboard.html`]!
  expect(html).toContain('<select id="board-branches">')
  expect(html).toMatch(/<div class="across js-only">[\s\S]*?data-task="T2"[\s\S]*?on <code>main<\/code>/)
  expect(html).toContain('T2 is also in progress on feat/rate-limit by @bob (2d)')
  expect(embedded(html).collisions.map((c: { id: string }) => c.id)).toEqual(['T2'])
  // Read from git objects already here: nothing that fetches.
  expect(seen.git.every(c => /^git (for-each-ref|rev-parse|cat-file|log|rev-list|config)$/.test(c))).toBe(true)
})

// team-view T6 (V6): the Team tab.
test('/progress dashboard team opens on the Team tab: a row per person in tasks/team.md, plus unowned', async ($, on) => {
  const todo = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in review · @sara · started 2026-10-06 · PR #42 · reviewer @amila\n')
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: todo, [`${CWD}/tasks/team.md`]: TEAM_MD }
  const seen = world(on, files, asPerson('sara@example.com'))
  const out = await $.command.run(run('dashboard team'))
  expect(out.text).toMatch(/opened it in your browser on team/)
  expect(seen.launched).toEqual([`${CWD}/tasks/progress-dashboard.html`])
  const html = files[`${CWD}/tasks/progress-dashboard.html`]!
  expect(html).toContain('data-view="team"')
  expect([...html.matchAll(/data-person="([^"]*)"/g)].map(m => m[1])).toEqual(['amila', 'sara', '-'])
  expect(html).toMatch(/<a href="#card-T2">T2<\/a>[^<]*Prisma schema for keys · PR #42/)
})

test('done on another branch is no collision: the band stays quiet', async ($, on) => {
  const theirs = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** done · @bob · started 2026-10-01 · done 2026-10-03\n')
  const answer = (argv: string[], stdin = '') => {
    if (argv[1] === 'for-each-ref') return `refs/heads/feat/rate-limit\t${'b'.repeat(40)}\t${Date.parse('2026-10-08T09:00:00Z') / 1000}\n`
    if (argv[1] === 'rev-parse' && argv.includes('--abbrev-ref')) return `${'a'.repeat(40)}\nmain\n`
    if (argv[1] === 'rev-parse') return '.git\n'
    if (argv[1] === 'cat-file') return stdin.split('\n').filter(Boolean).map(() => `@@asm blob\n${theirs}\n`).join('')
    return ''
  }
  world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }, { log: '', cat: '', answer })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect((await $.command.run(run('start T2'))).text).not.toContain('is also')
  const band = await $.ui.mount({ plugin: 'agent-skills-mods', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } as never })
  expect(await band.find({ text: /is also/ })).toBeUndefined()
})

// team-view T12: /progress dashboard live starts --serve as the session's child, once per project.
test('/progress dashboard live starts --serve, opens its address, and a second call reuses the running server', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  const seen = world(on, files)
  const first = (await $.command.run(run('dashboard live'))).text
  expect(first).toBe('Live dashboard at http://127.0.0.1:50123/?token=ab12 · stops when this session ends.')
  expect(seen.spawned).toHaveLength(1)
  const argv = seen.spawned[0]!
  expect(argv[0]).toBe('node')
  expect(argv[2]).toMatch(/\/scripts\/agent-skills-progress\.mjs$/)
  expect(argv.slice(3)).toEqual([CWD, '--serve', '--port', '0', '--no-open'])
  expect(seen.launched).toEqual(['http://127.0.0.1:50123/?token=ab12'])
  // No page written: the server builds it from the files on each load.
  expect(files[`${CWD}/tasks/progress-dashboard.html`]).toBeUndefined()

  const second = (await $.command.run(run('dashboard live'))).text
  expect(second).toBe('Live dashboard at http://127.0.0.1:50123/?token=ab12 (already running, opened it again) · stops when this session ends.')
  expect(seen.spawned).toHaveLength(1)
  expect(seen.launched).toHaveLength(2)

  // Once the server has stopped, the next call starts another.
  for (const end of seen.ends.splice(0)) end()
  await new Promise(done => setTimeout(done, 20))
  seen.serve.stdout = 'Serving /p at http://127.0.0.1:50999/?token=cd34\n'
  expect((await $.command.run(run('dashboard live'))).text).toBe('Live dashboard at http://127.0.0.1:50999/?token=cd34 · stops when this session ends.')
  expect(seen.spawned).toHaveLength(2)
  for (const end of seen.ends.splice(0)) end()
})

test('/progress dashboard live with no Node or an old one says why and prints the command to run instead', async ($, on) => {
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  seen.node = null
  const none = (await $.command.run(run('dashboard live'))).text ?? ''
  expect(none).toMatch(/^The live dashboard needs Node 22\.6 or newer, and there is no `node` on this machine's PATH\. Install it, then run: ! node --experimental-strip-types \/\S+\/scripts\/agent-skills-progress\.mjs \/p --serve$/m)
  expect(none).toMatch(/Ctrl-C stops it\.$/)
  seen.node = 'v20.11.0'
  const old = (await $.command.run(run('dashboard live'))).text ?? ''
  expect(old).toMatch(/^The live dashboard needs Node 22\.6 or newer; this machine has v20\.11\.0\. With a newer Node, run: ! node --experimental-strip-types \S+ \/p --serve$/m)
  expect(seen.spawned).toEqual([])
  expect(seen.launched).toEqual([])
})

test('/progress dashboard live when the server fails to start passes on its reason and the command to run instead', async ($, on) => {
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  seen.serve = { stdout: '', stderr: 'agent-skills-progress: EACCES: permission denied, open tasks\n', code: 2 }
  const out = (await $.command.run(run('dashboard live'))).text ?? ''
  expect(out).toMatch(/^The live dashboard didn't start: EACCES: permission denied, open tasks\. Run it yourself instead: ! node --experimental-strip-types \S+ \/p --serve$/m)
  expect(out).toMatch(/Ctrl-C stops it\.$/)
  expect(seen.launched).toEqual([])
  // Nothing is kept running, so the next call tries again.
  seen.serve = { ...seen.serve, stdout: 'Serving /p at http://127.0.0.1:50123/?token=ab12\n', stderr: '', code: null }
  expect((await $.command.run(run('dashboard live'))).text).toMatch(/^Live dashboard at http:\/\/127\.0\.0\.1:50123\//)
  expect(seen.spawned).toHaveLength(2)
  for (const end of seen.ends.splice(0)) end()
})

// team-view T9 (V4): since you last looked.
const SEEN_JSON = `${CWD}/.git/agent-skills/seen.json`
const sinceGit = (email: string) => ({ log: '', cat: '', answer: (argv: string[]) => (argv[1] === 'rev-parse' && argv.includes('--git-dir') ? '.git\n' : argv[1] === 'config' ? `${email}\n` : '') })
const submit = ($: Parameters<TestBody>[0], text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

test('since you last looked: once a session, one line naming who did what; /progress since lists it all', async ($, on) => {
  const files: Record<string, string> = {
    [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE
      .replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** done · @amila · started 2026-10-07 · done 2026-10-08\n')
      .replace('## Task 3: Issue and revoke keys\n', '## Task 3: Issue and revoke keys\n**Status:** todo · @sara\n'),
    [`${CWD}/tasks/plan.md`]: PLAN_MD.replace('self-hosted?\n', 'self-hosted?\n  → A: Upstash · @amila 2026-10-08\n'),
    [`${CWD}/tasks/team.md`]: TEAM_MD,
    // The last look, two days ago.
    [SEEN_JSON]: seenText(seenOf({ list: parseTasks(TODO_TEMPLATE), specs: [], plan: parsePlan(PLAN_MD), collisions: [] }, Date.parse('2026-10-07T17:00:00Z'))),
  }
  const seen = world(on, files, sinceGit('sara@example.com'))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await submit($, 'what next?')
  expect(seen.logs).toEqual(['Since you last looked (2026-10-07): T3 assigned to you · Q2 answered by @amila · T2 done by @amila'])
  // seen.json now holds what you saw.
  expect(parseSeen(files[SEEN_JSON]!)?.tasks.T3?.owner).toBe('@sara')
  await submit($, 'and then?')
  expect(seen.logs).toHaveLength(1)
  expect((await $.command.run(run('since'))).text).toBe('Since you last looked (2026-10-07), 3 changes:\n- T3 assigned to you\n- Q2 answered by @amila\n- T2 done by @amila')
})

test('the very first look says nothing and stores the snapshot; what you then see happen is not news later', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  const seen = world(on, files, sinceGit('sara@example.com'))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await submit($, 'hello')
  expect(seen.logs).toEqual([])
  expect(parseSeen(files[SEEN_JSON]!)?.day).toBe('2026-10-09')
  // The session's own work, kept in seen.json after the turn.
  files[`${CWD}/tasks/todo.md`] = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** done · started 2026-10-09 · done 2026-10-09\n')
  await $.turn.complete({ answer: 'done' } as never)
  expect(parseSeen(files[SEEN_JSON]!)?.tasks.T2?.state).toBe('done')
  expect((await $.command.run(run('since'))).text).toBe('Nothing changed since you last looked (2026-10-09).')
})

test('a corrupt seen.json is a first look: no line, no crash, and a good file in its place', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE, [SEEN_JSON]: '{"schema":1,"at":17' }
  const seen = world(on, files, sinceGit('sara@example.com'))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await submit($, 'hello')
  expect(seen.logs).toEqual([])
  expect(parseSeen(files[SEEN_JSON]!)).not.toBeNull()
})

test('/progress since outside a git repository says why, and the first prompt stays quiet', async ($, on) => {
  const files: Record<string, string> = { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE }
  const seen = world(on, files)
  await submit($, 'hello')
  expect(seen.logs).toEqual([])
  expect((await $.command.run(run('since'))).text).toBe('Not a git repository: "since you last looked" keeps its snapshot in the git folder.')
  expect(Object.keys(files)).toEqual([`${CWD}/tasks/todo.md`])
})

test('/progress names the team-view verbs in its description and argument hint (T13)', async ($, on) => {
  const seen = world(on, { [`${CWD}/tasks/todo.md`]: TODO_TEMPLATE })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const progress = seen.commands.find(c => c.name === 'progress')
  expect(progress).toBeDefined()
  for (const verb of ['branches', 'since', 'answer', 'signoff', 'merge-driver']) {
    expect(progress!.description).toContain(verb)
    expect(progress!.argumentHint).toContain(verb)
  }
  expect(progress!.argumentHint).toContain('merge-driver [install|uninstall|status]')
  expect(progress!.argumentHint).toMatch(/dashboard \[[^\]]*team[^\]]*live\]/)
})
