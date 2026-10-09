import { expect, mock, test, type TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SPEC, GOOD_SPEC, TODO_TEMPLATE, TODO_T2_DONE, TODO_CP_DONE, TODO_T3_DONE, TODO_NONE_DONE, PLAN_INDEX, WEAK_SPEC, gitOutput, decodeCells } from './fixtures'

const CWD = '/p'

/** Each world's mocked clock, for tests that move time on. */
const clocks = new WeakMap<object, ReturnType<typeof mock.clock>>()

/** Stands for the engine beneath the mod: a project folder in memory and the UI calls. */
type Git = { log: string; cat: string; messages?: string; named?: string; diff?: string; revList?: string } | 'no-repo' | 'no-commits'

function world(
  on: On,
  files: Record<string, string>,
  git: Git = 'no-repo',
  stored: Record<string, unknown> = {},
  surfaces: readonly ('terminal' | 'desktop' | 'vscode' | 'mobile')[] = ['terminal'],
) {
  const seen = { status: [] as unknown[], opened: [] as string[], toasts: [] as string[], git: [] as string[], copied: [] as string[], launched: [] as string[], calls: [] as Record<string, unknown>[] }
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
    if (e.argv[0] === 'open') {
      seen.launched.push(e.argv[1]!)
      return out(0, '')
    }
    seen.git.push(e.argv.slice(0, 2).join(' '))
    if (git === 'no-repo') return out(128, '')
    if (git === 'no-commits') return { value: { ...out(128, '').value, stderr: "fatal: your current branch 'main' does not have any commits yet" } }
    if (e.argv[1] === 'log' && e.argv.includes('--format=%h %as %s')) return out(0, git.named ?? '')
    if (e.argv[1] === 'diff') return out(0, git.diff ?? '')
    if (e.argv[1] === 'rev-list' && e.argv.includes('-1')) return out(0, git.revList ?? '')
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
  expect(await board.find({ text: /^tests failed$/ })).toBeDefined()
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
  expect(await pane.find({ text: /^■ done  ■ running  ■ slow  × failed  ♦ needs you  ▫ to come  ◌ waits on another task$/ })).toBeDefined()
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
