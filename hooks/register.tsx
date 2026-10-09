import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AsmProject } from '../types'
import { parsePlan, parseSpec, parseTasks, taskKey, withBlockers, type TaskList } from './lib/parse'
import { dayOf, forecast, record, shortDay, snapshotOf, type Snapshot } from './lib/forecast'
import {
  combine,
  earliestDays,
  emptySource,
  gitSources,
  snapshotsFromDoneDays,
  type Backfill,
  type GitSources,
  type LogsChoice,
  type SourceData,
} from './lib/history'
import { historyFromLogs, logsDir, mentions } from './lib/logs'
import { burnup, chartLegends, flow, revealCells, throughput } from './lib/chart'
import { timeline, type Seg } from './lib/timeline'
import { TABS, type Tab } from './ui/tabs'
import { digestText, reportHtml, sparkline } from './lib/report'
import { burnupSvg, flowSvg } from './lib/svg'
import { burnupPixels, cachedPixels, CELL_PX, dateRow, drawsPixels, flowPixels, type PixelChart } from './lib/pixels'
import { spinnerWord, stepOf, testCounts, type Step } from './lib/steps'
import { checkOverwrite, denyMessage, GUARDED } from './lib/guard'
import { archiveDir, archiveReadme } from './lib/archive'
import { gateWarning } from './lib/gate'
import { editorArgvs } from './lib/specedit'
import { applyEdit, editBetween, FORMAT_RULES, planName, readFrontMatter, setFrontMatter, stampDoc, stampTodo, type TaskState } from './lib/format'
import {
  bandText,
  bar,
  areaSummary,
  boardRows,
  openCounts,
  phaseLabel,
  phaseOf,
  completionToast,
  taskDates,
  progressBrief,
  taskInPrompt,
  forecastText,
  historyNote,
  historyText,
  nextText,
  specApproval,
  specCandidates,
  specFileFor,
  specFiles,
  specOfPath,
  stageOfSkill,
  statusText,
  timelineRows,
  type Stage,
} from './lib/view'

const NAME = 'agent-skills-mods'
const project = atom({ plugin: 'agent-skills-mods', key: 'project' } as const, null as AsmProject | null)
const stage = atom({ plugin: 'agent-skills-mods', key: 'stage' } as const, null as Stage | null)
const allowOverwrite = atom({ plugin: 'agent-skills-mods', key: 'allowOverwrite' } as const, false)
/** What the agent is doing in plan terms, for the spinner (H3). */
const step = atom({ plugin: 'agent-skills-mods', key: 'step' } as const, null as { step: Step; task: string | null } | null)
/** The task whose last test run failed, marked × on the timeline (F1). */
const failed = atom({ plugin: 'agent-skills-mods', key: 'failed' } as const, null as string | null)
/** The spec file picked in the spec pane or by `/spec-view <id>` (A3). */
const specChoice = atom({ plugin: 'agent-skills-mods', key: 'specChoice' } as const, null as string | null)
/** The task the last prompt asked about, highlighted on the board (C1). */
const focus = atom({ plugin: 'agent-skills-mods', key: 'focus' } as const, null as string | null)
/** Whether the spec gate already warned this turn (D2): one toast per turn, not one per edit. */
const gateWarned = atom({ plugin: 'agent-skills-mods', key: 'gateWarned' } as const, false)
/** The spec area opened for reading in the spec pane (A1), by key. */
const specSection = atom({ plugin: 'agent-skills-mods', key: 'specSection' } as const, null as string | null)
/** Whether this terminal draws pictures (F3), read from its environment at session start. */
const pixels = atom({ plugin: 'agent-skills-mods', key: 'pixels' } as const, false)
/** How much of the cell charts is drawn (0 to 1): they sweep in left to right when the pane opens. */
/** The plan pane's tab (mockup 12): timeline, charts or tasks. */
const tab = atom({ plugin: 'agent-skills-mods', key: 'tab' } as const, 'tasks' as Tab)
const chartReveal = atom({ plugin: 'agent-skills-mods', key: 'chartReveal' } as const, 1)

const SPEC_PANE = 'asm-spec'
const BOARD_PANE = 'asm-board'
const CHARTS_PANE = 'asm-charts'
/** Where /progress report writes its page (G1), next to the task list it reports on. */
const REPORT_FILE = 'tasks/progress-report.html'
const WATCHED = /(^|[\\/])(SPEC(-[\w.-]+)?\.md|specs[\\/][\w.-]+\.md|tasks[\\/](plan|todo)\.md)$/
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

type $ = EngineInterface

async function readText($: $, path: string): Promise<string | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/** What the history sources found for a project, kept apart and stored once (F5). */
type Sources = GitSources & { logs: SourceData; logsChoice: LogsChoice }
// v4: from 0.7.1 a task waiting on another no longer counts as blocked, and no commits
// yet is told apart from no repository; projects seen by 0.7.0 gather again once.
const sourcesKey = (cwd: string) => `sources:v4:${cwd}`

/** Git's two sources for the task list (F5), through the session's process runner. */
function fromGit($: $, file: string, list: TaskList): Promise<GitSources> {
  return gitSources((argv, opts) => $.process.run(argv, { stdin: opts?.stdin, timeoutMs: 20_000 }), file, list)
}

/** Every session log of this project that writes the task list, as text. */
async function readLogs($: $, cwd: string, file: string): Promise<string[]> {
  const home = await $.env.get('HOME')
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : null)
  if (!configDir) return []
  const dir = logsDir(configDir, cwd)
  const entries = await $.fs.list(dir).catch(() => [])
  const texts = await Promise.all(
    entries.filter(f => f.kind === 'file' && f.name.endsWith('.jsonl')).map(f => readText($, `${dir}/${f.name}`)),
  )
  return texts.filter((t): t is string => t !== null && mentions(t, `${cwd}/${file}`))
}

/** The answer to the session-log question (band button or /progress history logs on|off). */
async function chooseLogs($: $, allow: boolean): Promise<string> {
  const p = await read($, project)
  const sources = p ? ((await $.store.get(sourcesKey(p.cwd))) as Sources | undefined) : undefined
  if (!p || !p.list || !p.listFile || !sources) return 'No task list here, so there is no history to read.'
  if (!allow) {
    await $.store.set(sourcesKey(p.cwd), { ...sources, logsChoice: 'no' })
    await load($)
    return 'Session logs are off for this project.'
  }
  const texts = await readLogs($, p.cwd, p.listFile)
  const logs = historyFromLogs(texts, `${p.cwd}/${p.listFile}`, p.list)
  await $.store.set(sourcesKey(p.cwd), { ...sources, logs, logsChoice: logs.snaps.length ? 'yes' : 'empty' })
  const after = await load($)
  if (!logs.snaps.length) return `No session log of this project writes ${p.listFile}.`
  return `Session logs read: ${after.history?.days.logs ?? 0} more day(s) of history. ${after.history ? historyNote(after.history, after.listFile) : ''}`.trim()
}

/** The build loop in plan terms (H3, F1): what the spinner says, and × for a failed test run. */
async function trackStep($: $, e: { tool: unknown }, result: { isError?: boolean }) {
  try {
    const s = stepOf(String(e.tool), e as never)
    if (!s) return
    const p = await read($, project)
    const task = p?.list?.current?.id ?? null
    await update($, step, () => ({ step: s, task }))
    if (s === 'test' && task) {
      const isFailed = result.isError === true
      await update($, failed, f => (isFailed ? task : f === task ? null : f))
    }
    if (p && s === 'test') {
      const counts = testCounts(String((result as { text?: unknown }).text ?? ''))
      if (counts) await setFacts($, p.cwd, f => ({ ...f, tests: counts }))
    }
    if (p && s === 'commit' && p.list) await countCommits($, p.cwd, p.list.meta?.created ?? p.snapshots[0]?.day ?? dayOf(await $.clock.now()), true)
    // The progress format (E1): the current task is in progress, at this step.
    if (keepFormat && task && p?.listFile === 'tasks/todo.md') {
      const today = dayOf(await $.clock.now())
      const pending = await readPending($, p.cwd)
      await $.store.set(pendingKey(p.cwd), { ...pending, [task]: { ...pending[task], status: 'in progress', started: pending[task]?.started ?? today, step: s } })
    }
  } catch {}
}

/** Facts the timeline's header shows (mockup 11): commits since the plan began, the last test run, the last review. */
type Facts = { commits?: number; commitsDay?: string; tests?: { passed: number; failed: number }; reviewed?: string }
const factsKey = (cwd: string) => `facts:${cwd}`
async function setFacts($: $, cwd: string, fn: (f: Facts) => Facts) {
  const f = ((await $.store.get(factsKey(cwd))) as Facts | undefined) ?? {}
  await $.store.set(factsKey(cwd), fn(f))
}

/** Commits since `since`, once a day (and after each commit the agent makes). */
async function countCommits($: $, cwd: string, since: string, force = false) {
  const today = dayOf(await $.clock.now())
  const f = ((await $.store.get(factsKey(cwd))) as Facts | undefined) ?? {}
  if (!force && f.commitsDay === today) return
  try {
    const out = await $.process.run(['git', 'rev-list', '--count', `--since=${since}T00:00:00`, 'HEAD'], { timeoutMs: 10_000 })
    const n = Number(out.stdout.trim())
    if (out.exitCode === 0 && Number.isFinite(n)) await setFacts($, cwd, x => ({ ...x, commits: n, commitsDay: today }))
    else await setFacts($, cwd, x => ({ ...x, commitsDay: today }))
  } catch {}
}

/** Whether the plugin keeps the progress format (the `progressFormat` option), set at register. */
let keepFormat = true

/** Task state changes seen since the task list was last written, by task id (E1). */
const pendingKey = (cwd: string) => `pending:${cwd}`
async function readPending($: $, cwd: string): Promise<Record<string, Partial<TaskState>>> {
  return ((await $.store.get(pendingKey(cwd))) as Record<string, Partial<TaskState>> | undefined) ?? {}
}

/** A spec or plan document whose front matter the format keeps. */
const FORMAT_DOC = /(^|[\\/])(SPEC(-[\w.-]+)?\.md|specs[\\/][\w.-]+\.md|tasks[\\/]plan\.md)$/
const TODO_FILE = /(^|[\\/])tasks[\\/]todo\.md$/

/** A file's new text with the progress format kept: Status lines and front matter (E1). */
async function formatted($: $, path: string, text: string): Promise<string> {
  if (!keepFormat) return text
  const today = dayOf(await $.clock.now())
  if (TODO_FILE.test(path)) {
    const cwd = await $.session.cwd()
    const changes = await readPending($, cwd)
    const out = stampTodo(text, today, { changes, plan: planName(text) })
    if (Object.keys(changes).length) await $.store.set(pendingKey(cwd), {})
    return out
  }
  if (FORMAT_DOC.test(path) && !/(^|[\\/])specs[\\/](readme|index)\.md$/i.test(path)) return stampDoc(text, today)
  return text
}

/** Writes the state changes nobody wrote into tasks/todo.md this turn (E1). */
async function flushPending($: $): Promise<void> {
  if (!keepFormat) return
  const cwd = await $.session.cwd()
  const pending = await readPending($, cwd)
  if (Object.keys(pending).length === 0) return
  const path = `${cwd}/tasks/todo.md`
  const text = await readText($, path)
  if (text !== null) {
    const next = stampTodo(text, dayOf(await $.clock.now()), { changes: pending, plan: planName(text) })
    if (next !== text) await $.fs.write(path, next)
  }
  await $.store.set(pendingKey(cwd), {})
}

/** `/progress format`: the format applied to the files here, and its rules in the project's agent instructions. */
async function applyFormat($: $): Promise<string> {
  const cwd = await $.session.cwd()
  const today = dayOf(await $.clock.now())
  const done: string[] = []
  const p = await load($)
  const todoPath = `${cwd}/tasks/todo.md`
  const todo = await readText($, todoPath)
  if (todo !== null) {
    const next = stampTodo(todo, today, { changes: await readPending($, cwd), plan: planName(todo) })
    if (next !== todo) {
      await $.fs.write(todoPath, next)
      done.push(`tasks/todo.md: ${(next.match(/^\*\*Status:\*\*/gm) ?? []).length} Status lines and front matter`)
    }
    await $.store.set(pendingKey(cwd), {})
  }
  for (const file of [...p.specFiles, 'tasks/plan.md']) {
    const text = await readText($, `${cwd}/${file}`)
    if (text === null) continue
    // A spec agent-skills already planned against was approved before the format came in.
    const approvedBefore = !readFrontMatter(text).fields.status && file !== 'tasks/plan.md' && !!p.list
    const next = stampDoc(approvedBefore ? setFrontMatter(text, { status: 'approved', approved: today }) : text, today)
    if (next !== text) {
      await $.fs.write(`${cwd}/${file}`, next)
      done.push(`${file}: front matter`)
    }
  }
  const target = (await readText($, `${cwd}/AGENTS.md`)) !== null ? 'AGENTS.md' : 'CLAUDE.md'
  const current = (await readText($, `${cwd}/${target}`)) ?? ''
  const block = `${FORMAT_BEGIN}\n## agent-skills progress format\n\n${FORMAT_RULES}\n${FORMAT_END}`
  const has = current.includes(FORMAT_BEGIN) && current.includes(FORMAT_END)
  const next = has
    ? current.slice(0, current.indexOf(FORMAT_BEGIN)) + block + current.slice(current.indexOf(FORMAT_END) + FORMAT_END.length)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${block}\n`
  if (next !== current) {
    await $.fs.write(`${cwd}/${target}`, next)
    done.push(`${target}: the format's rules${has ? ' (updated)' : ''}, so every agent and session keeps it`)
  }
  await load($)
  return done.length ? `Progress format applied:\n${done.map(d => `- ${d}`).join('\n')}` : 'The progress format is already in place here.'
}

const FORMAT_BEGIN = '<!-- agent-skills-mods:progress-format -->'
const FORMAT_END = '<!-- /agent-skills-mods:progress-format -->'

/** The spec pane's Approve and Back to draft buttons (A1): the status in front matter. */
async function setApproval($: $, status: 'approved' | 'draft'): Promise<void> {
  const p = await read($, project)
  if (!p?.specFile) return
  const path = `${p.cwd}/${p.specFile}`
  const text = await readText($, path)
  if (text === null) return
  const today = dayOf(await $.clock.now())
  await $.fs.write(path, stampDoc(setFrontMatter(text, { status, approved: status === 'approved' ? today : null }), today))
  await load($)
  $.ui.toast(status === 'approved' ? `✓ ${p.specFile} approved · planning can start` : `○ ${p.specFile} back to draft`)
}

/** The spec pane's Open in editor button: a windowed $VISUAL/$EDITOR, else the default app. */
async function openInEditor($: $): Promise<void> {
  const p = await read($, project)
  if (!p?.specFile) return
  const path = `${p.cwd}/${p.specFile}`
  const env = { visual: await $.env.get('VISUAL'), editor: await $.env.get('EDITOR') }
  for (const argv of editorArgvs(env, path)) {
    try {
      if ((await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0) return
    } catch {}
  }
  $.ui.toast(`Could not open ${p.specFile}; it is at ${path}`)
}

/** The charts' draw-in: eight frames, about a third of a second, then the whole chart. */
const SWEEP_FRAMES = 8
let sweep: { cancel: () => void } | null = null
async function sweepCharts($: $): Promise<void> {
  sweep?.cancel()
  await update($, chartReveal, () => 0)
  let frame = 0
  sweep = $.clock.every(45, () => {
    frame++
    void update($, chartReveal, () => Math.min(1, frame / SWEEP_FRAMES))
    if (frame >= SWEEP_FRAMES) {
      sweep?.cancel()
      sweep = null
    }
  })
}

/** The spec pane's picker (A3): show another spec file. */
async function pick($: $, file: string) {
  await update($, specChoice, () => file)
  await load($)
}

/**
 * Opens a file with the machine's default app (G1): macOS `open`, Linux
 * `xdg-open`, Windows `start`. Only where someone sits at this machine: a
 * terminal, VS Code or the desktop app, never a print run or a phone.
 */
async function openFile($: $, path: string): Promise<boolean> {
  const surfaces = await $.session.surfaces().catch(() => [] as const)
  if (!surfaces.some(s => s === 'terminal' || s === 'vscode' || s === 'desktop')) return false
  for (const argv of [['open', path], ['xdg-open', path], ['cmd', '/c', 'start', '', path]]) {
    try {
      if ((await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0) return true
    } catch {}
  }
  return false
}

/** Projects whose backfill is running, so a second load does not start another. */
const backfilling = new Set<string>()

/** Re-reads the three files, records today's snapshot and updates the status entry. */
async function load($: $, opts: { recheckLogs?: boolean } = {}): Promise<AsmProject> {
  const cwd = await $.session.cwd()
  const names = await $.fs.list(cwd).then(
    entries => entries.filter(f => f.kind === 'file').map(f => f.name),
    () => [] as string[],
  )
  const specsDir = await $.fs.list(`${cwd}/specs`).then(
    entries => entries.filter(f => f.kind === 'file').map(f => f.name),
    () => [] as string[],
  )
  const files = specFiles(names, specsDir)
  const choice = await read($, specChoice)
  const specFile = choice && files.includes(choice) ? choice : (files[0] ?? null)
  const [specText, todoText, planText] = await Promise.all([
    specFile ? readText($, `${cwd}/${specFile}`) : null,
    readText($, `${cwd}/tasks/todo.md`),
    readText($, `${cwd}/tasks/plan.md`),
  ])
  const spec = specText === null ? null : parseSpec(specText)
  const plan = planText === null ? null : parsePlan(planText)
  // The task list lives in todo.md; a plan.md alone still carries the phase index.
  const listSource = todoText ?? planText
  const questions = [
    ...(plan?.openQuestions ?? []).map(text => ({ file: 'tasks/plan.md', text })),
    ...(spec?.openQuestions ?? []).map(text => ({ file: specFile ?? 'SPEC.md', text })),
  ]
  const list = listSource === null ? null : withBlockers(parseTasks(listSource), questions)

  const listFile = todoText !== null ? 'tasks/todo.md' : planText !== null ? 'tasks/plan.md' : null
  let fc: AsmProject['forecast'] = null
  let backfilled: Backfill | null = null
  let snapshots: Snapshot[] = []
  let dates: AsmProject['dates'] = {}
  if (list && list.total > 0) {
    const now = await $.clock.now()
    const key = `history:${cwd}`
    let seen = ((await $.store.get(key)) as Snapshot[] | undefined) ?? []
    const daysKey = `doneDays:${cwd}`
    let seenDone = ((await $.store.get(daysKey)) as Record<string, string> | undefined) ?? {}
    let sources = ((await $.store.get(sourcesKey(cwd))) as Sources | undefined) ?? null
    let isFirst = false
    if (!sources && listFile && !backfilling.has(cwd)) {
      backfilling.add(cwd)
      try {
        sources = { ...(await fromGit($, listFile, list)), logs: emptySource(), logsChoice: 'unasked' }
        isFirst = true
      } finally {
        backfilling.delete(cwd)
      }
    }
    const today = dayOf(now)
    seen = record(seen, snapshotOf(today, list))
    await $.store.set(key, seen)
    const src = sources ?? { git: emptySource(), messages: emptySource(), logs: emptySource(), logsChoice: 'unasked' as const, gitNote: null }
    const logs = src.logsChoice === 'yes' ? src.logs : emptySource()
    // Done dates written in the task list (the progress format) are history of their own.
    const fileDone = Object.fromEntries(list.tasks.filter(t => t.status === 'done' && t.state?.done).map(t => [taskKey(t), t.state!.done!]))
    const marked = earliestDays(fileDone, src.messages.doneDays)
    const combined = combine(seen, [src.git, logs], { snaps: snapshotsFromDoneDays(marked, list), doneDays: marked })
    snapshots = combined.snaps
    fc = forecast(snapshots, now)
    // Ask about the session logs only when git left too little for charts or a forecast:
    // on first sight, and again at a session's start while they had nothing to read,
    // since the session that wrote the plan logs its edits only after the plugin saw them.
    const recheck = opts.recheckLogs === true && sources?.logsChoice === 'empty'
    if (sources && (isFirst || recheck)) {
      const thin = new Set(snapshots.map(s => s.day)).size < 2 || fc.kind === 'not-enough'
      const hasLogs = thin && (await readLogs($, cwd, listFile!).catch(() => [])).length > 0
      const logsChoice: LogsChoice = thin ? (hasLogs ? 'ask' : 'empty') : isFirst ? 'unasked' : 'empty'
      if (isFirst || logsChoice !== sources.logsChoice) {
        sources = { ...sources, logsChoice }
        await $.store.set(sourcesKey(cwd), sources)
      }
    }
    // A task first seen done today is dated today, unless a source saw it done earlier.
    const other = earliestDays(fileDone, src.git.doneDays, logs.doneDays, src.messages.doneDays)
    const fresh = list.tasks.filter(t => t.status === 'done' && !seenDone[taskKey(t)] && !other[taskKey(t)])
    if (fresh.length > 0) {
      for (const t of fresh) seenDone = { ...seenDone, [taskKey(t)]: today }
      await $.store.set(daysKey, seenDone)
    }
    dates = taskDates(list, earliestDays(seenDone, other), fc, today)
    backfilled = {
      since: snapshots[0]?.day ?? today,
      days: { seen: combined.added.seen, git: combined.added.files[0] ?? 0, logs: combined.added.files[1] ?? 0, messages: combined.added.messages },
      logs: sources?.logsChoice ?? 'unasked',
      gitNote: src.gitNote,
    }
    if (isFirst) {
      const ask = backfilled.logs === 'ask' ? ' Claude Code session logs could add more: the band above the prompt asks.' : ''
      $.ui.toast(`${historyNote(backfilled, listFile)}${ask}`)
    }
  }

  const value: AsmProject = { cwd, spec, list, listFile, plan, forecast: fc, history: backfilled, snapshots, dates, specFile, specFiles: files }
  await update($, project, () => value)
  $.ui.status(statusText(spec, list))
  return value
}

/**
 * The spec gate (D2): a source edit while the spec awaits approval. The model is
 * told on every such edit; the person gets one toast a turn. Never blocks.
 */
async function specGate<R extends { context?: readonly string[] }>($: $, path: string, result: R): Promise<R> {
  try {
    const p = (await read($, project)) ?? (await load($))
    const warning = gateWarning({ cwd: p.cwd, path, spec: p.spec, specFile: p.specFile, hasPlan: !!p.list })
    if (!warning) return result
    if (!(await read($, gateWarned))) {
      await update($, gateWarned, () => true)
      $.ui.toast(warning.toast)
    }
    return { ...result, context: [...(result.context ?? []), warning.context] }
  } catch {
    return result
  }
}

/** `/progress digest` and the panes' Copy digest button (G2). */
async function copyDigest($: $, p: AsmProject): Promise<string> {
  const text = digestText(p)
  const copied = await $.ui.copy({ text }).catch(() => ({ isCopied: false as const, reason: 'refused' as const }))
  return `${text}\n\n${copied.isCopied ? 'Copied to the clipboard.' : `Not copied (${copied.reason}); select the lines above.`}`
}

/** `/progress report` and the panes' Report button (G1). */
async function writeReport($: $, p: AsmProject): Promise<string> {
  if (!p.list || p.list.total === 0) return 'No task list yet, so there is nothing to report.'
  const path = `${p.cwd}/${REPORT_FILE}`
  const html = reportHtml({
    ...p,
    today: dayOf(await $.clock.now()),
    charts: { burnup: burnupSvg(p.snapshots, p.forecast), flow: flowSvg(p.snapshots) },
    historyLine: p.history ? historyNote(p.history, p.listFile) : undefined,
  })
  await $.fs.write(path, html)
  const size = `${Math.round(html.length / 1024)} KB`
  return (await openFile($, path))
    ? `Wrote ${REPORT_FILE} (${size}) and opened it in your browser. It is one self-contained page, so it also opens offline or as an email attachment.`
    : `Wrote ${REPORT_FILE} (${size}): one self-contained page that opens offline. Open ${path} in a browser or attach it to an email.`
}

/** The board's and charts' Report and Copy digest buttons: the command's work, its outcome as a toast. */
async function paneAction($: $, what: 'report' | 'digest'): Promise<void> {
  const p = await load($)
  const text = what === 'report' ? await writeReport($, p) : await copyDigest($, p)
  $.ui.toast(what === 'report' ? text : (text.split('\n').at(-1) ?? text))
}

/**
 * `/progress archive` (the guard's way forward): tasks/todo.md and tasks/plan.md
 * moved into tasks/archive/<date>-<plan>/ with their history, so the next /plan
 * starts clean. An unfinished plan needs `/progress archive force`.
 */
async function archivePlan($: $, force: boolean): Promise<string> {
  const p = await load($)
  const cwd = p.cwd
  const todo = await readText($, `${cwd}/tasks/todo.md`)
  const plan = await readText($, `${cwd}/tasks/plan.md`)
  if (todo === null && plan === null) return 'Nothing to archive: there is no tasks/todo.md or tasks/plan.md here.'
  const list = p.list
  const open = list ? list.tasks.filter(t => t.status !== 'done') : []
  if (open.length && !force) {
    return [
      `tasks/todo.md still has ${open.length} unfinished task${open.length === 1 ? '' : 's'} (${open.slice(0, 5).map(t => t.id).join(', ')}${open.length > 5 ? ', …' : ''}).`,
      'Run `/progress archive force` to archive it anyway; the open tasks are listed in the archive.',
    ].join('\n')
  }
  const today = dayOf(await $.clock.now())
  // A folder is taken when it already holds an archive's README.
  const taken: string[] = []
  let dir = archiveDir(today, todo, plan, taken)
  while (await $.fs.exists(`${cwd}/${dir}/README.md`)) {
    taken.push(dir.slice('tasks/archive/'.length))
    dir = archiveDir(today, todo, plan, taken)
  }
  const files: string[] = []
  if (todo !== null) await $.fs.write(`${cwd}/${dir}/todo.md`, todo), files.push('todo.md')
  if (plan !== null) await $.fs.write(`${cwd}/${dir}/plan.md`, plan), files.push('plan.md')
  const history = (await $.store.get(`history:${cwd}`)) as Snapshot[] | undefined
  if (history?.length) await $.fs.write(`${cwd}/${dir}/history.json`, `${JSON.stringify(history, null, 2)}\n`), files.push('history.json')
  const name = dir.slice('tasks/archive/'.length).replace(/^\d{4}-\d{2}-\d{2}-/, '')
  await $.fs.write(
    `${cwd}/${dir}/README.md`,
    archiveReadme({ dir, today, name, done: list?.done ?? 0, total: list?.total ?? 0, files, open: open.map(t => `${t.id} ${t.title}`) }),
  )
  // The originals go; where `rm` is missing, they are left as a one-line pointer.
  for (const f of ['tasks/todo.md', 'tasks/plan.md']) {
    if (!(await $.fs.exists(`${cwd}/${f}`))) continue
    let removed = false
    try {
      removed = (await $.process.run(['rm', '--', `${cwd}/${f}`], { timeoutMs: 10_000 })).exitCode === 0
    } catch {}
    if (!removed) await $.fs.write(`${cwd}/${f}`, `# Archived\n\nThis plan moved to ${dir}/.\n`)
  }
  // A new plan starts its own history.
  for (const key of [`history:${cwd}`, `doneDays:${cwd}`, sourcesKey(cwd), pendingKey(cwd), factsKey(cwd)]) await $.store.delete(key)
  await update($, allowOverwrite, () => false)
  await load($)
  return `Archived ${files.join(', ')} to ${dir}/ (${list?.done ?? 0} of ${list?.total ?? 0} tasks done). /plan can start the next plan.`
}

/** `build T4` while building or testing, the stage alone otherwise. */
async function stageLabel($: $): Promise<string | null> {
  const s = await read($, stage)
  if (!s) return null
  const t = (await read($, project))?.list?.current
  return s === 'build' || s === 'test' ? `${s}${t ? ` ${t.id}` : ''}` : s
}

const reply = (text: string) => ({ text })

export const register: Register = (on, options) => {
  keepFormat = options.progressFormat !== false
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'agent-skills plan pane: tasks, or timeline | charts. Also next | digest | report | history | format | allow-overwrite | refresh',
      argumentHint: '[timeline|charts|next|digest|report|history|format|allow-overwrite|refresh]',
    })
    await $.command.register({
      name: 'spec-view',
      description: 'Open SPEC.md, or a module spec (specs/<id>.md or SPEC-<id>.md), as a pane with its six core areas',
      argumentHint: '[module id]',
    })
    const style = options.chartStyle
    const canDraw = await (async () => {
      try {
        return drawsPixels({
          term: await $.env.get('TERM'),
          termProgram: await $.env.get('TERM_PROGRAM'),
          kitty: await $.env.get('KITTY_WINDOW_ID'),
          tmux: await $.env.get('TMUX'),
        })
      } catch {
        return false
      }
    })()
    await update($, pixels, () => (style === 'pixels' ? true : style === 'cells' ? false : canDraw))
    await load($, { recheckLogs: true }).catch(() => undefined)
    return next(e)
  })

  // ----------------------------------------------------------- commands (A3, B1, C2, D1)

  on('command.run', { command: 'spec-view' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg) {
      const p = await load($)
      const file = specCandidates(arg).find(f => p.specFiles.includes(f))
      if (!file) {
        const here = p.specFiles.length ? ` Specs here: ${p.specFiles.join(', ')}.` : ''
        return reply(`No ${specFileFor(arg)} in ${p.cwd}.${here}`)
      }
      await update($, specChoice, () => file)
    }
    const p = await load($)
    await $.ui.open({ id: SPEC_PANE, title: 'Spec' })
    if (!p.spec) return reply(`No SPEC.md in ${p.cwd}. Run /spec to write one.`)
    const others = p.specFiles.length > 1 ? ` (${p.specFiles.length} specs; pick another in the pane or with /spec-view <id>)` : ''
    return reply(`Spec pane opened: ${p.specFile}${others}.`)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const p = await load($)
    if (arg === 'next') return reply(nextText(p.list, p.plan))
    if (arg === 'allow-overwrite') {
      await update($, allowOverwrite, () => true)
      return reply('The next turn may overwrite tasks/plan.md or tasks/todo.md even with unfinished tasks.')
    }
    if (arg === 'refresh') return reply(statusText(p.spec, p.list) ?? 'No SPEC.md or tasks files here.')
    if (arg === 'archive' || arg === 'archive force') return reply(await archivePlan($, arg.endsWith('force')))
    if (arg === 'timeline') {
      await showTab($, 'timeline')
      await $.ui.open({ id: BOARD_PANE, title: 'Plan' })
      return reply(p.list ? `Timeline opened: ${p.list.done}/${p.list.total} tasks done.` : nextText(null, p.plan))
    }
    if (arg === 'charts') {
      await showTab($, 'charts')
      await $.ui.open({ id: BOARD_PANE, title: 'Plan' })
      const days = new Set(p.snapshots.map(s => s.day)).size
      return reply(days >= 2 ? `Charts opened: ${days} days of history.` : 'Charts opened. They draw once there are two days of history.')
    }
    if (arg === 'digest') return reply(await copyDigest($, p))
    if (arg === 'report') return reply(await writeReport($, p))
    if (arg === 'format') return reply(await applyFormat($))
    if (arg === 'history') return reply(historyText(p.history, p.listFile))
    if (arg === 'history logs on' || arg === 'history logs off') return reply(await chooseLogs($, arg.endsWith('on')))
    if (arg !== '') return reply(`Unknown argument "${arg}". Use: /progress [timeline|charts|next|digest|report|history|format|archive|allow-overwrite|refresh]`)
    await showTab($, 'tasks')
    await $.ui.open({ id: BOARD_PANE, title: 'Plan' })
    return reply(p.list ? `Board opened: ${p.list.done}/${p.list.total} tasks done.` : nextText(null, p.plan))
  })

  // ----------------------------------------------------------- write guard (D1)

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const write = async () => {
      const content = await formatted($, e.file_path, e.content).catch(() => e.content)
      return next(content === e.content ? e : { ...e, content })
    }
    if (!GUARDED.test(e.file_path)) return write()
    const old = await readText($, e.file_path)
    if (old === null) return write()
    const verdict = checkOverwrite(old, e.content)
    if (verdict.isAllowed) return write()
    if (await read($, allowOverwrite)) {
      await update($, allowOverwrite, () => false)
      return write()
    }
    return { deny: denyMessage(e.file_path, verdict) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${NAME}: the plan guard failed, so the write was stopped.` }))

  // An Edit of a task list, spec or plan carries the format's changes with it
  // (E1): the span the agent edits and the Status lines it moves, in one Edit,
  // so the file the agent last saw is the file on disk.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (!keepFormat || !(TODO_FILE.test(e.file_path) || FORMAT_DOC.test(e.file_path))) return next(e)
    const before = await readText($, e.file_path)
    const after = before === null ? null : applyEdit(before, e.old_string, e.new_string, e.replace_all === true)
    if (before === null || after === null) return next(e)
    const stamped = await formatted($, e.file_path, after)
    const edit = stamped === after ? null : editBetween(before, stamped)
    return next(edit ? { ...e, ...edit, replace_all: false } : e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // ----------------------------------------------------------- after each tool call: refresh (A1, B1) and step (H3, F1)

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await trackStep($, e, result)
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : null
    if (path && EDIT_TOOLS.has(String(e.tool)) && !result.isError && !result.deny && options.specGate === true && !WATCHED.test(path)) {
      return specGate($, path, result)
    }
    if (!path || !EDIT_TOOLS.has(String(e.tool)) || !WATCHED.test(path) || result.isError) return result
    // A refresh that fails must never change the tool's own result.
    try {
      const before = (await read($, project))?.list ?? null
      const after = (await load($)).list
      const toast = GUARDED.test(path) ? completionToast(before, after) : undefined
      if (toast) $.ui.toast(toast)
      const spec = specOfPath(path)
      if (spec) {
        await update($, specChoice, () => spec)
        await load($)
        void $.ui.open({ id: SPEC_PANE, title: 'Spec' })
      }
      if (/todo\.md$/.test(path)) void $.ui.open({ id: BOARD_PANE, title: 'Plan' })
    } catch {}
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (options.planSpinner !== true || e.props.message !== null) return next(e)
    const s = await read($, step)
    const word = s ? spinnerWord(s.step, s.task) : spinnerWord(null, (await read($, project))?.list?.current?.id ?? null)
    return word ? next({ ...e, props: { ...e.props, word } }) : next(e)
  })

  // Edits made outside the session show after the next turn. The overwrite allowance
  // lasts the person's whole turn, so a subagent finishing inside it leaves it alone.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await flushPending($).catch(() => undefined)
    await load($).catch(() => undefined)
    if (e.agentId === undefined) {
      await update($, allowOverwrite, () => false)
      await update($, step, () => null)
      await update($, gateWarned, () => false)
    }
    return next(e)
  })

  // ----------------------------------------------------------- answers about progress (C1)

  // Fresh numbers for the turn (edits made outside the session included), and the
  // board focused on the task the prompt asks about.
  on('prompt.submit', async ($, e, next) => {
    const p = await load($)
    const id = taskInPrompt(e.text, p.list)
    await update($, focus, () => id)
    if (id) void $.ui.open({ id: BOARD_PANE, title: 'Plan' })
    return next(e)
  }).catch(($, e, next) => next(e))

  // The parsed state as the last system-prompt section, after the cache boundary.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const p = await read($, project)
    const text = p ? progressBrief(p) : undefined
    const sections = [...result.sections]
    // The progress format's rules wherever agent-skills is at work: its files here, or one of its skills loaded.
    if (keepFormat && ((p && (p.spec || p.list || p.plan)) || (await read($, stage)))) sections.push({ id: `${NAME}:format`, text: FORMAT_RULES, scope: 'session' as const })
    if (text) sections.push({ id: `${NAME}:progress`, text, scope: 'session' as const })
    return sections.length === result.sections.length ? result : { ...result, sections }
  }).catch(($, e, next) => next(e))

  // ----------------------------------------------------------- stage in the footer (H2)

  on('skill.prompt', async ($, e, next) => {
    const s = stageOfSkill(e.skill)
    if (s) await update($, stage, () => s)
    if (s === 'review') {
      const cwd = await $.session.cwd()
      const today = dayOf(await $.clock.now())
      await setFacts($, cwd, f => ({ ...f, reviewed: today }))
    }
    // agent-skills writes checkboxes only; its spec, plan and build skills get the format's rules (E1).
    if (keepFormat && (s === 'spec' || s === 'plan' || s === 'build' || s === 'test')) return next({ ...e, text: `${e.text}\n\n---\n\n${FORMAT_RULES}` })
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const label = await stageLabel($)
    return label ? next({ ...e, props: { ...e.props, tail: `· ${label}` } }) : next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const s = await read($, stage)
    return s ? next({ ...e, props: { ...e.props, modes: [...e.props.modes, s] } }) : next(e)
  })

  // ----------------------------------------------------------- current task band (B2)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const p = await read($, project)
    const list = p?.list ?? null
    const t = list?.current
    const ask = p?.history?.logs === 'ask'
    if ((!list || !t) && !ask) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    // ▸ between turns; a turning marker while the agent works, where surface modules run.
    const working = e.props.isWorking === true && (e.surface === 'terminal' || e.surface === 'desktop')
    const Client = working ? $.ui.resolve(e as typeof e & { surface: 'terminal' }).Client : null
    return (
      <Box flexDirection="column">
        {list && t && (
          <Box flexDirection="row" gap={3}>
            <Box flexDirection="row" gap={1}>
              {Client ? <Client key="pulse" module="./ui/pulse.tsx" props={{ isActive: true, color: 'claude' }} width={1} height={1} /> : <Text color="claude">▸</Text>}
              <Text wrap="truncate-end">
                <Text color="claude">{t.id}</Text> <Text bold>{t.title}</Text>
              </Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {openCounts(t)}
            </Text>
            {t.checkpoint && <Text dimColor>checkpoint after this task</Text>}
          </Box>
        )}
        {ask && (
          <Box flexDirection="row" gap={1}>
            <Text wrap="truncate-end">Too little git history for charts. Also read this project's Claude Code session logs?</Text>
            <Button key="logs-yes" label="Read logs" onPress={() => void chooseLogs($, true).then(t => $.ui.toast(t))} />
            <Button key="logs-no" label="No" onPress={() => void chooseLogs($, false)} />
          </Box>
        )}
      </Box>
    )
  })

  // ----------------------------------------------------------- spec pane (A1, A3)

  on('ui.render', { component: 'Pane', requestId: SPEC_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const p = await read($, project)
    const width = Math.max(20, e.props.bodyColumns)
    // The mobile app draws no Select yet; there /spec-view <id> picks.
    const picker = (() => {
      if (!p || p.specFiles.length < 2) return null
      if (e.surface === 'mobile') return <Text dimColor>Specs: {p.specFiles.join(', ')}</Text>
      const { Select } = $.ui.resolve(e)
      return (
        <Select
          key="spec-file"
          label="Spec"
          options={p.specFiles.map(f => ({ value: f, label: f }))}
          value={p.specFile ?? undefined}
          onSelect={(file: string) => void pick($, file)}
        />
      )
    })()
    const spec = p?.spec
    if (!spec) {
      return (
        <Box flexDirection="column">
          <Text bold color="claude">
            SPEC.md
          </Text>
          <Text color="subtle">{'─'.repeat(width)}</Text>
          <Text>No SPEC.md yet.</Text>
          <Text dimColor>It would be at {p?.cwd ?? '.'}/SPEC.md. Run /spec to write one.</Text>
        </Box>
      )
    }
    const approval = specApproval(spec, !!p?.list)
    const colWidth = Math.max(12, Math.floor((width - 2) / 3))
    const glyph = { present: '✓', empty: '○', missing: '×' } as const
    const tone = { present: 'success', empty: 'warning', missing: 'error' } as const
    const column = (head: string, color: string, items: string[]) => (
      <Box flexDirection="column" width={colWidth} borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text bold color={color}>
          {head}
        </Text>
        {items.length === 0 ? <Text dimColor>none</Text> : items.map(i => <Text wrap="wrap">{i}</Text>)}
      </Box>
    )
    const opened = await read($, specSection)
    const area = spec.areas.find(a => a.key === opened && a.state === 'present')
    const readable = spec.areas.filter(a => a.state === 'present')
    const Select = e.surface === 'mobile' ? null : $.ui.resolve(e as typeof e & { surface: 'terminal' }).Select
    const Markdown = $.ui.resolve(e).Markdown
    const approvedNote = spec.approvedOn ? ` ${shortDay(spec.approvedOn)}` : ''
    return (
      <Box flexDirection="column">
        {picker}
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text bold color="claude" wrap="truncate-end">
            {p?.specFile ?? 'SPEC.md'}
            {spec.title ? <Text dimColor> · {spec.title}</Text> : ''}
          </Text>
          <Box flexShrink={0}>
            <Text bold color={approval === 'approved' ? 'success' : 'warning'}>
              {approval === 'approved' ? `approved${approvedNote}` : 'awaiting approval'}
            </Text>
          </Box>
        </Box>
        <Text color="subtle">{'─'.repeat(width)}</Text>
        {spec.areas.map((a, i) => {
          const sum = areaSummary(a, spec.successCriteria)
          return (
            <Box key={a.key} flexDirection="row" justifyContent="space-between" gap={1}>
              <Text wrap="truncate-end" bold={a.key === area?.key}>
                {a.hint ? <Text color="warning">!</Text> : <Text color={tone[a.state]}>{glyph[a.state]}</Text>} {i + 1} {a.label}
              </Text>
              <Box flexShrink={0}>
                <Text color={sum.isWeak ? (a.state === 'missing' ? 'error' : 'warning') : undefined} dimColor={!sum.isWeak}>
                  {sum.text}
                </Text>
              </Box>
            </Box>
          )
        })}
        <Box flexDirection="row" gap={1} marginTop={1}>
          {column('Always', 'success', spec.boundaries.always)}
          {column('Ask first', 'warning', spec.boundaries.ask)}
          {column('Never', 'error', spec.boundaries.never)}
        </Box>
        {spec.openQuestions.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {spec.openQuestions.map(q => (
              <Text wrap="wrap">
                <Text color="permission">♦</Text> <Text dimColor>{q}</Text>
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
          {Select && readable.length > 0 && (
            <Select
              key="spec-section"
              label="↵ open section"
              options={readable.map(a => ({ value: a.key, label: a.label }))}
              value={area?.key}
              onSelect={(key: string) => void update($, specSection, () => key)}
            />
          )}
          <Text dimColor>·</Text>
          {approval === 'approved' ? (
            spec.status === 'approved' && <Button key="spec-draft" label="back to draft" hotkey="d" plain dimColor onPress={() => void setApproval($, 'draft')} />
          ) : (
            <Button key="spec-approve" label="approve" hotkey="a" plain dimColor onPress={() => void setApproval($, 'approved')} />
          )}
          <Text dimColor>·</Text>
          <Button key="spec-edit" label="edit in $EDITOR" hotkey="e" plain dimColor onPress={() => void openInEditor($)} />
        </Box>
        {area && (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginTop={1}>
            <Text bold>{area.label}</Text>
            <Markdown key="spec-section-body" text={area.body} />
          </Box>
        )}
      </Box>
    )
  })

  // ----------------------------------------------------------- the plan pane: timeline, charts, tasks (B1, F1, F2, G3)

  on('ui.message', async ($, e, next) => {
    const t = (e.data as { tab?: unknown } | null)?.tab
    if (e.element !== 'tabs' || !TABS.includes(t as Tab)) return next(e)
    await showTab($, t as Tab)
    return { props: { active: t } }
  })

  on('ui.render', { component: 'Pane', requestId: BOARD_PANE }, async ($, e) => drawPlan($, e, null))
  // A charts pane opened by 0.14 or earlier: the charts tab on its own.
  on('ui.render', { component: 'Pane', requestId: CHARTS_PANE }, async ($, e) => drawPlan($, e, 'charts'))
}

// ------------------------------------------------------------------ plan pane views

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A Pane's render event, as the plan pane's views take it. */
type PaneEvent = any

/**
 * The plan pane (mockups 11, 12, 7): tabs on top, `r report · c copy digest`
 * beside them, then the timeline, the charts or the task board. `forced`
 * pins a tab, for the charts pane earlier versions opened.
 */
async function drawPlan($: $, e: PaneEvent, forced: Tab | null) {
  const { Box, Button, Text } = $.ui.resolve(e) as any
  const p = await read($, project)
  const active: Tab = forced ?? (await read($, tab))
  const view = active === 'timeline' ? await timelineView($, e, p) : active === 'charts' ? await chartsView($, e, p) : await tasksView($, e, p)
  if (forced) return view
  const hasClient = e.surface === 'terminal' || e.surface === 'desktop'
  const Client = hasClient ? ($.ui.resolve(e) as any).Client : null
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {Client ? (
          <Client key="tabs" module="./ui/tabs.tsx" props={{ active }} />
        ) : (
          TABS.map(t => <Button key={`tab-${t}`} label={t[0]!.toUpperCase() + t.slice(1)} dimColor={t !== active} onPress={() => void showTab($, t)} />)
        )}
        {Client && <Text dimColor>←/→ switch ·</Text>}
        <Button key="report" label="report" hotkey="r" plain dimColor onPress={() => void paneAction($, 'report')} />
        <Text dimColor>·</Text>
        <Button key="digest" label="copy digest" hotkey="c" plain dimColor onPress={() => void paneAction($, 'digest')} />
      </Box>
      <Text color="subtle">{'─'.repeat(Math.max(10, e.props.bodyColumns))}</Text>
      {view}
    </Box>
  )
}

/** The plan pane's tab, from a tab button, the tabs row or a command. The charts sweep in when shown. */
async function showTab($: $, t: Tab) {
  if (t === 'charts') await sweepCharts($)
  await update($, tab, () => t)
}

async function tasksView($: $, e: PaneEvent, p: AsmProject | null) {
    const { Box, Text } = $.ui.resolve(e)
    const list = p?.list
    if (!list || list.total === 0) {
      return <Text dimColor>{nextText(list ?? null, p?.plan ?? null)}</Text>
    }
    const width = Math.max(24, e.props.bodyColumns)
    const focused = await read($, focus)
    const rows = boardRows(list, { failed: await read($, failed) })
    const color = { done: 'success', now: 'warning', muted: 'subtle', blocked: 'error', accent: 'claude', needsYou: 'permission', text: undefined } as const
    const pct = Math.round((list.done / list.total) * 100)
    const where = phaseOf(list)
    // A row: what it is on the left, its state on the right.
    const line = (key: string, left: unknown, right: unknown, opts: { isCurrent?: boolean } = {}) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" gap={1}>
        <Text wrap="truncate-end" bold={opts.isCurrent}>
          {left as never}
        </Text>
        <Box flexShrink={0}>
          <Text>{right as never}</Text>
        </Box>
      </Box>
    )
    return (
      <Box flexDirection="column">
        {line(
          'head',
          <Text>
            <Text bold color="claude">
              tasks
            </Text>
            {where && <Text color="claude"> · {where}</Text>}
          </Text>,
          <Text dimColor>
            {list.done}/{list.total} · {pct}%
          </Text>,
        )}
        <Text color="subtle">{'─'.repeat(width)}</Text>
        {rows.map((row, i) =>
          row.kind === 'phase' ? (
            <Box key={`p${i}`} marginTop={i === 0 ? 0 : 1}>
              <Text dimColor wrap="truncate-end">
                {row.label}
                {row.summary ? `  ${row.summary}` : ''}
              </Text>
            </Box>
          ) : row.kind === 'checkpoint' ? (
            line(
              `c${i}`,
              <Text color={color[row.tone]}>
                {row.glyph} {row.label}
              </Text>,
              <Text color={color[row.rightTone]}>{row.right}</Text>,
            )
          ) : (
            <Box key={row.id} flexDirection="column">
              {line(
                row.id,
                <Text inverse={row.id === focused}>
                  <Text color={color[row.tone]}>{row.glyph}</Text> <Text bold={row.isCurrent}>{row.id}</Text>{' '}
                  <Text dimColor={row.tone === 'muted' && !row.isCurrent}>{row.title}</Text>
                </Text>,
                <Text color={color[row.rightTone]} bold={row.isCurrent}>
                  {row.right}
                </Text>,
                { isCurrent: row.isCurrent },
              )}
              {row.under.map(u => (
                <Text dimColor wrap="truncate-end">
                  {'  '}
                  {u.text}
                </Text>
              ))}
            </Box>
          ),
        )}
        {list.kind === 'checklist' && <Text dimColor>Plain checklist: no "## Task N:" headings found.</Text>}
        {p?.plan?.trackedIn && <Text dimColor>Tasks tracked in {p.plan.trackedIn}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {p?.forecast && (
            <Text dimColor wrap="wrap">
              {forecastText(p.forecast)}
            </Text>
          )}
          {p?.history && <Text dimColor>{historyNote(p.history, p.listFile)}</Text>}
        </Box>
      </Box>
    )
}

async function chartsView($: $, e: PaneEvent, p: AsmProject | null) {
  const { Box, Text } = $.ui.resolve(e) as any
  const snaps = p?.snapshots ?? []
  const body = Math.max(24, Math.min(240, e.props.bodyColumns))
  // Side by side when there is room for two charts of 50 columns, as mockup 12 lays them out.
  const sideBySide = body >= 104
  const columns = sideBySide ? Math.floor((body - 2) / 2) : Math.min(120, body)
  const up = burnup(snaps, p?.forecast ?? null, columns, 10)
  const fl = flow(snaps, columns, 10)
  if (!up || !fl) {
    const since = snaps[0] ? ` Tracking since ${shortDay(snaps[0].day)}.` : ''
    return <Text dimColor wrap="wrap">{`Charts need two days of history.${since}`}</Text>
  }
  // Pictures on kitty and Ghostty (F3), terminal cells elsewhere (F2); interactive
  // SVG on desktop, VS Code and mobile (F4).
  const usePixels = e.surface === 'terminal' && (await read($, pixels))
  const reveal = await read($, chartReveal)
  const picture = (key: 'burnup' | 'flow', c: { columns: number; rows: number }, pic: PixelChart | null) => {
    if (e.surface !== 'terminal' || !pic) return null
    const { Image } = $.ui.resolve(e) as any
    const plotCols = Math.min(255, c.columns - 4)
    const plotRows = c.rows - 1
    const labelAt = new Map(pic.ticks.map((t, i) => [Math.round((i * (plotRows - 1)) / (pic.ticks.length - 1)), t]))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexDirection="column" width={4}>
            {Array.from({ length: plotRows }, (_, r) => (
              <Text color="subtle">{labelAt.has(r) ? `${String(labelAt.get(r)).padStart(2)} ┤` : '   │'}</Text>
            ))}
          </Box>
          <Image key={key} source={{ png: pic.png }} columns={plotCols} rows={plotRows} alt={pic.alt} />
        </Box>
        <Text color="subtle">{`    ${dateRow(pic.dates, plotCols)}`}</Text>
      </Box>
    )
  }
  const chart = (key: 'burnup' | 'flow', c: { columns: number; rows: number; cells: string }) => {
    if (e.surface === 'terminal') {
      if (usePixels) {
        const w = Math.min(255, c.columns - 4) * CELL_PX.w
        const h = (c.rows - 1) * CELL_PX.h
        const fc = p?.forecast ?? null
        const pic = cachedPixels(key, JSON.stringify([snaps, key === 'burnup' ? fc : null, w, h]), () =>
          key === 'burnup' ? burnupPixels(snaps, fc, w, h) : flowPixels(snaps, w, h),
        )
        const drawn = picture(key, c, pic)
        if (drawn) return drawn
      }
      const { Raster } = $.ui.resolve(e) as any
      return <Raster key={key} columns={c.columns} rows={c.rows} cells={revealCells(c.cells, c.columns, c.rows, reveal)} />
    }
    const svg = key === 'burnup' ? burnupSvg(snaps, p?.forecast ?? null) : flowSvg(snaps)
    if (!svg) return null
    const { Svg } = $.ui.resolve(e) as any
    return <Svg source={svg.source} alt={svg.alt} isInteractive />
  }
  const legends = chartLegends(snaps, p?.forecast ?? null)
  const legend = (parts: { mark: string; color: string | null; text: string }[]) => (
    <Text wrap="wrap">
      {parts.map((x, i) => (
        <Text>
          {i > 0 ? '   ' : ''}
          {x.mark ? <Text color={x.color ?? undefined}>{x.mark} </Text> : ''}
          <Text dimColor>{x.text}</Text>
        </Text>
      ))}
    </Text>
  )
  const block = (key: 'burnup' | 'flow', title: string, sub: string, c: typeof up) => (
    <Box flexDirection="column" width={sideBySide ? columns : undefined}>
      <Text>
        <Text bold>{title}</Text> <Text dimColor>{sub}</Text>
      </Text>
      {chart(key, c)}
      {legends ? legend(key === 'burnup' ? legends.burnup : legends.flow) : <Text dimColor wrap="wrap">{c.legend}</Text>}
    </Box>
  )
  const charts = [
    block('burnup', 'Burn-up', `scope vs done${p?.forecast?.kind === 'range' ? ', dotted = forecast' : ''}`, up),
    block('flow', 'Flow', 'tasks by state, per day', fl),
  ]
  // Phases: one bar each, filling in as the pane opens (mockup 12).
  const list = p?.list
  const phases: { name: string; done: number; total: number }[] = []
  for (const t of list?.tasks ?? []) {
    if (!t.phase) continue
    const ph = phases.find(x => x.name === t.phase) ?? (phases.push({ name: t.phase, done: 0, total: 0 }), phases[phases.length - 1]!)
    ph.total++
    if (t.status === 'done') ph.done++
  }
  const labelW = Math.min(28, Math.max(0, ...phases.map(x => phaseLabel(x.name).length)))
  const barW = Math.max(8, Math.min(28, body - labelW - 10))
  const hasClient = e.surface === 'terminal' || e.surface === 'desktop'
  const Client = hasClient ? ($.ui.resolve(e) as any).Client : null
  const pace = throughput(snaps)
  return (
    <Box flexDirection="column" gap={1}>
      {sideBySide ? (
        <Box flexDirection="row" gap={2}>
          {charts}
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          {charts}
        </Box>
      )}
      {phases.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Phases</Text>
          {phases.map((ph, i) => (
            <Box key={`ph${i}`} flexDirection="row" gap={1}>
              <Box width={labelW}>
                <Text wrap="truncate-end">{phaseLabel(ph.name)}</Text>
              </Box>
              {Client ? (
                <Client key={`phase-${i}`} module="./ui/meter.tsx" props={{ done: ph.done, total: ph.total }} width={barW} height={1} />
              ) : (
                <Text color="success">{bar(ph.done, ph.total, barW)}</Text>
              )}
              <Text dimColor>
                {ph.done}/{ph.total}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      {pace && (
        <Text wrap="truncate-end">
          <Text dimColor>Tasks done per day </Text>
          <Text color="success">{sparkline(pace.perDay.slice(-30))}</Text>
          <Text dimColor>
            {' '}
            · {pace.done} in {pace.days} day{pace.days === 1 ? '' : 's'} · {pace.rate.toFixed(2)}/day
          </Text>
        </Text>
      )}
    </Box>
  )
}

async function timelineView($: $, e: PaneEvent, p: AsmProject | null) {
  const { Box, Text } = $.ui.resolve(e) as any
  const list = p?.list
  if (!p || !list || list.total === 0) return <Text dimColor>{nextText(list ?? null, p?.plan ?? null)}</Text>
  const today = dayOf(await $.clock.now())
  await countCommits($, p.cwd, list.meta?.created ?? p.snapshots[0]?.day ?? today)
  const facts = ((await $.store.get(factsKey(p.cwd))) as Facts | undefined) ?? undefined
  const t = timeline({ spec: p.spec, list, plan: p.plan, forecast: p.forecast, dates: p.dates, today, since: p.snapshots[0]?.day, failed: await read($, failed), facts })
  const color = { text: undefined, strong: undefined, muted: 'subtle', done: 'success', run: 'warning', bad: 'error', needsYou: 'permission', accent: 'claude' } as const
  const line = (l: Seg[], i: number) => (
    <Text key={i} wrap="truncate-end">
      {l.map(seg => (
        <Text color={color[seg.tone]} bold={seg.tone === 'strong'}>
          {seg.text}
        </Text>
      ))}
    </Text>
  )
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">{t.header.map(line)}</Box>
      <Box flexDirection="column">{t.rows.map(line)}</Box>
      <Box flexDirection="column">{t.legend.map(line)}</Box>
      {p.history && <Text dimColor>{historyNote(p.history, p.listFile)}</Text>}
    </Box>
  )
}

function areaDetail(a: { key: string; body: string }, criteria: string[]): string {
  if (a.key === 'objective') return `${criteria.length} success criteri${criteria.length === 1 ? 'on' : 'a'}`
  return firstLine(a.body)
}

function firstLine(body: string): string {
  const line = body.split('\n').find(l => l.trim() && !/^\s*(```|~~~)/.test(l)) ?? ''
  return line.replace(/^\s*[-*+]\s+/, '').replace(/\*\*|`/g, '').trim()
}
