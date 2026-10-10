import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { AsmProject } from '../types'
import { parsePlan, parseSpec, parseTasks, taskKey, withBlockers, type TaskList } from '../packages/core/parse'
import { dayOf, forecast, record, shortDay, snapshotOf, type Snapshot } from '../packages/core/forecast'
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
} from '../packages/core/history'
import { historyFromLogs, logsDir, mentions } from '../packages/core/logs'
import { burnup, chartLegends, COLOR, flow, hex, revealCells, throughput } from '../packages/core/chart'
import { timeline, type Seg } from '../packages/core/timeline'
import { criticalPath, graphLines } from '../packages/core/graph'
import { TABS, type Tab } from './ui/tabs'
import { digestText, headline, nowCounts, reportHtml, sparkline, standupText, taskDays } from '../packages/core/report'
import { burnupSvg, flowSvg } from '../packages/core/svg'
import { toState } from '../packages/core/state'
import { approvalStatus, clearApprovals, signSpec } from '../packages/core/approvals'
import { draftTeam, parseTeam, TEAM_FILE, teamText, whoIs, type Team } from '../packages/core/team'
import { dashboardHtml, VIEW_IDS, type ViewId } from '../packages/core/dashboard/page'
import { burnupPixels, cachedPixels, CELL_PX, dateRow, drawsPixels, flowPixels, type PixelChart } from '../packages/core/pixels'
import { spinnerWord, stepOf, testCounts, type Step } from '../packages/core/steps'
import { checkOverwrite, denyMessage, GUARDED } from '../packages/core/guard'
import { archiveDir, archiveReadme } from '../packages/core/archive'
import { diagnose, doctorText, type DoctorPast } from '../packages/core/doctor'
import { checkpointWarning, gateWarning } from '../packages/core/gate'
import { editorArgvs } from '../packages/core/specedit'
import { addHandoff, setOwner, setReview, addQuestion, applyEdit, backdateDoc, backdateTodo, driftedSpec, editBetween, FORMAT_RULES, hasTaskSection, planName, readFrontMatter, setFrontMatter, stampDoc, stampTodo, tickTask, toggleBox, type TaskState } from '../packages/core/format'
import {
  bandText,
  bar,
  areaSummary,
  alerts,
  boardRows,
  commitsNaming,
  taskDetail,
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
} from '../packages/core/view'
import { replyLines, type Inline, type ReplyLine } from '../packages/core/reply'

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
/** Whether the checkpoint gate already raised its toast this turn. */
const cpWarned = atom({ plugin: 'agent-skills-mods', key: 'cpWarned' } as const, false)
/**
 * The task opened on the board with a click, its boxes shown to tick. Null: the
 * current task is open by default; '' when that was closed with a click.
 */
const expanded = atom({ plugin: 'agent-skills-mods', key: 'expanded' } as const, null as string | null)
/** The spec area opened for reading in the spec pane (A1), by key. */
const specSection = atom({ plugin: 'agent-skills-mods', key: 'specSection' } as const, null as string | null)
/** The spec's changes since approval, shown under the spec pane after `/spec-view diff`. */
const specDiff = atom({ plugin: 'agent-skills-mods', key: 'specDiff' } as const, null as { file: string; since: string; diff: string } | null)
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
const DASHBOARD_FILE = 'tasks/progress-dashboard.html'
const WATCHED = /(^|[\\/])(SPEC(-[\w.-]+)?\.md|specs[\\/][\w.-]+\.md|tasks[\\/](plan|todo)\.md)$/
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

type $ = EngineInterface

/** Text cut to a column width with an ellipsis, then padded to it. */
const fitTo = (text: string, w: number) => (text.length > w ? `${text.slice(0, w - 1)}…` : text.padEnd(w))

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
// v5: from 0.34.1 the copies are read in groups under the 4 MiB output limit; a long
// task list read before that kept only its newest copies, so it is gathered again.
const sourcesKey = (cwd: string) => `sources:v5:${cwd}`

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
      const wasFailed = (await read($, failed)) === task
      await update($, failed, f => (isFailed ? task : f === task ? null : f))
      if (isFailed && !wasFailed) notify($, `Tests failed on ${task}`, `${p?.list?.current?.title ?? task}: the last test run failed.`)
    }
    if (p && s === 'test') {
      const counts = testCounts(String((result as { text?: unknown }).text ?? ''))
      if (counts) await setFacts($, p.cwd, f => ({ ...f, tests: counts }))
    }
    if (p && s === 'commit' && p.list) await countCommits($, p.cwd, began(p, dayOf(await $.clock.now())), true)
    // The progress format (E1): the current task is in progress, at this step.
    if (keepFormat && task && p?.listFile === 'tasks/todo.md') {
      const today = dayOf(await $.clock.now())
      const pending = await readPending($, p.cwd)
      // format-v2 (T4): an unowned task is claimed for whoever runs the session, when tasks/team.md knows them.
      const owner = p.list?.tasks.find(t => t.id === task)?.owner ? undefined : (pending[task]?.owner ?? (await sessionHandle($, p.cwd)) ?? undefined)
      await $.store.set(pendingKey(p.cwd), { ...pending, [task]: { ...pending[task], status: 'in progress', started: pending[task]?.started ?? today, step: s, ...(owner ? { owner } : {}) } })
    }
  } catch {}
}

/** Facts the timeline's header shows (mockup 11): commits since the plan began, the last test run, the last review. */
/** The plan's first day: its front matter's, or the history's when that is older (the format came in late). */
function began(p: AsmProject, today: string): string {
  return [p.list?.meta?.created, p.plan?.created, p.snapshots[0]?.day, today].filter((d): d is string => !!d).sort()[0]!
}

type Facts = { commits?: number; commitsDay?: string; commitsSince?: string; tests?: { passed: number; failed: number }; reviewed?: string }
const factsKey = (cwd: string) => `facts:${cwd}`
async function setFacts($: $, cwd: string, fn: (f: Facts) => Facts) {
  const f = ((await $.store.get(factsKey(cwd))) as Facts | undefined) ?? {}
  await $.store.set(factsKey(cwd), fn(f))
}

/** Commits since `since`, once a day (and after each commit the agent makes). */
async function countCommits($: $, cwd: string, since: string, force = false) {
  const today = dayOf(await $.clock.now())
  const f = ((await $.store.get(factsKey(cwd))) as Facts | undefined) ?? {}
  if (!force && f.commitsDay === today && f.commitsSince === since) return
  try {
    const out = await $.process.run(['git', 'rev-list', '--count', `--since=${since}T00:00:00`, 'HEAD'], { timeoutMs: 10_000 })
    const n = Number(out.stdout.trim())
    if (out.exitCode === 0 && Number.isFinite(n)) await setFacts($, cwd, x => ({ ...x, commits: n, commitsDay: today, commitsSince: since }))
    else await setFacts($, cwd, x => ({ ...x, commitsDay: today }))
  } catch {}
}

/** Whether native notifications are on (the `notifications` option), set at register. */
let notifyOn = true

/** A native notification through the person's own channel, for the moments that need them. Never throws. */
function notify($: $, title: string, text: string) {
  if (!notifyOn) return
  void $.ui.notify(text, { title: `agent-skills · ${title}` }).catch(() => undefined)
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

/** A tool result with a note for the model after it; a refusal is left as it is. */
function withNote<R extends ToolCallResult>(r: R, note: string | null): R {
  if (!note || r.deny !== undefined) return r
  return { ...r, context: [...(r.context ?? []), note] } as R
}

/** A spec file, as opposed to the plan: what spec drift watches. */
const SPEC_DOC = /(^|[\\/])(SPEC(-[\w.-]+)?\.md|specs[\\/][\w.-]+\.md)$/

/**
 * Spec drift: an agent edit that changes an approved spec puts it back to
 * draft, with a toast for the person and a note for the agent.
 */
async function drift($: $, path: string, before: string | null, after: string): Promise<{ text: string; note: string | null }> {
  if (!keepFormat || before === null || !SPEC_DOC.test(path)) return { text: after, note: null }
  const next = driftedSpec(before, after)
  if (next === null) return { text: after, note: null }
  const file = specOfPath(path) ?? path
  $.ui.toast(`○ ${file} changed after approval: back to draft · /spec-view diff shows what changed`)
  return {
    text: next,
    note: `agent-skills-mods: ${file} was approved, and this edit changed it, so it is back to status: draft. Tell the user what changed and ask them to approve it again before building on the change.`,
  }
}

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
/**
 * What git shows of a project already under way, for the dates the format
 * writes: each file's first commit, the spec's approval (the plan's first
 * commit), each task's first done day. Empty where there is no git.
 */
async function pastOf($: $, p: AsmProject): Promise<DoctorPast> {
  const files: DoctorPast['files'] = {}
  const first = async (file: string) => {
    try {
      const out = await $.process.run(['git', 'log', '--diff-filter=A', '--format=%as', '--', file], { timeoutMs: 10_000 })
      const days = out.exitCode === 0 ? out.stdout.split('\n').filter(l => /^\d{4}-\d{2}-\d{2}$/.test(l.trim())) : []
      return days[days.length - 1]?.trim()
    } catch {
      return undefined
    }
  }
  const names = [...p.specFiles, 'tasks/plan.md', 'tasks/todo.md']
  const days = await Promise.all(names.map(first))
  names.forEach((f, i) => (files[f] = { created: days[i] }))
  const planned = [files['tasks/plan.md']?.created, files['tasks/todo.md']?.created].filter((d): d is string => !!d).sort()[0]
  for (const f of p.specFiles) files[f] = { ...files[f], approved: planned }
  // The plan itself was approved by the time its tasks were.
  if (files['tasks/plan.md']) files['tasks/plan.md'] = { ...files['tasks/plan.md'], approved: files['tasks/todo.md']?.created ?? files['tasks/plan.md'].created }
  const src = (await $.store.get(sourcesKey(p.cwd))) as Sources | undefined
  const byKey = src ? earliestDays(src.git.doneDays, src.messages.doneDays, src.logsChoice === 'yes' ? src.logs.doneDays : {}) : {}
  const doneDays: Record<string, string> = {}
  for (const t of p.list?.tasks ?? []) if (byKey[taskKey(t)]) doneDays[t.id] = byKey[taskKey(t)]!
  return { files, doneDays }
}

/** A task list stamped with the format, its dates from git where git has them. */
const stampTodoPast = (text: string, today: string, past: DoctorPast, changes?: Record<string, Partial<TaskState>>) =>
  backdateTodo(stampTodo(text, today, { changes, plan: planName(text), created: past.files['tasks/todo.md']?.created, doneDays: past.doneDays }), {
    created: past.files['tasks/todo.md']?.created,
    doneDays: past.doneDays,
  })

async function applyFormat($: $): Promise<string> {
  const cwd = await $.session.cwd()
  const today = dayOf(await $.clock.now())
  const done: string[] = []
  const p = await load($)
  const past = await pastOf($, p)
  const todoPath = `${cwd}/tasks/todo.md`
  const todo = await readText($, todoPath)
  if (todo !== null) {
    const next = stampTodoPast(todo, today, past, await readPending($, cwd))
    if (next !== todo) {
      await $.fs.write(todoPath, next)
      done.push(`tasks/todo.md: ${(next.match(/^\*\*Status:\*\*/gm) ?? []).length} Status lines and front matter`)
    }
    await $.store.set(pendingKey(cwd), {})
  }
  for (const file of [...p.specFiles, 'tasks/plan.md']) {
    const text = await readText($, `${cwd}/${file}`)
    if (text === null) continue
    // A spec agent-skills already planned against was approved before the format came in;
    // so was a plan whose tasks are under way.
    const fp = past.files[file] ?? {}
    const approvedBefore = !readFrontMatter(text).fields.status && !!p.list && (file !== 'tasks/plan.md' || p.list.done > 0)
    const approvedOn = fp.approved && fp.created && fp.approved < fp.created ? fp.created : (fp.approved ?? today)
    const created = readFrontMatter(text).fields.created || (fp.created ?? today)
    const stamped = stampDoc(approvedBefore ? setFrontMatter(text, { status: 'approved', created, approved: approvedOn }) : text, today, fp)
    const next = backdateDoc(stamped, fp)
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
  const team = await readTeam($, p.cwd)
  // format-v2 (F5): with approvals: in tasks/team.md, `a` signs for your roles.
  if (status === 'approved' && team?.approvals.length) {
    const email = await gitEmail($)
    const me = whoIs(team, email)
    if (!me) {
      $.ui.toast(`Can't sign: ${email ? `${email} is not in ${TEAM_FILE}` : 'git config user.email is not set'}.`)
      return
    }
    const r = signSpec(stampDoc(text, today), me, team.approvals, today)
    if (!r.signed.length) {
      const sigs = parseSpec(text).approvals
      const open = team.approvals.filter(role => !sigs.some(s => s.role === role))
      $.ui.toast(open.length ? `${me.handle} (${me.roles.join(', ') || 'no role'}) holds no role ${p.specFile} still waits on: ${open.join(', ')}.` : `${p.specFile} has every signature it needs.`)
      return
    }
    await $.fs.write(path, r.text)
    await load($)
    const waiting = approvalStatus(parseSpec(r.text).approvals, team).waiting
    $.ui.toast(
      r.complete
        ? `✓ ${p.specFile} approved: every role has signed (${team.approvals.join(', ')})`
        : `✓ ${me.handle} signed ${p.specFile} for ${r.signed.join(', ')} · waiting on ${waiting.map(w => `${w.who.join(' or ') || w.role} (${w.role})`).join(', ')}`,
    )
    return
  }
  const base = status === 'draft' ? clearApprovals(text) : text
  await $.fs.write(path, stampDoc(setFrontMatter(base, { status, approved: status === 'approved' ? today : null }), today))
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

  const value: AsmProject = { cwd, spec, list, listFile, plan, forecast: fc, history: backfilled, snapshots, dates, specFile, specFiles: files, team: await readTeam($, cwd) }
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

/** Your git email, which tasks/team.md maps to a handle (format-v2); null when git has none. */
async function gitEmail($: $): Promise<string | null> {
  const r = await $.process.run(['git', 'config', 'user.email'], { timeoutMs: 10_000 }).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout.trim() || null : null
}

/** Each project's git email, read once a session: auto-claim asks on every step. */
const emails = new Map<string, Promise<string | null>>()

/** Who runs this session, as tasks/team.md names them; null without the file or a matching email. */
async function sessionHandle($: $, cwd: string): Promise<string | null> {
  const team = await readTeam($, cwd)
  if (!team) return null
  if (!emails.has(cwd)) emails.set(cwd, gitEmail($))
  return whoIs(team, await emails.get(cwd)!)?.handle ?? null
}

/** tasks/team.md, parsed; null when there is none. */
async function readTeam($: $, cwd: string): Promise<Team | null> {
  const text = await readText($, `${cwd}/${TEAM_FILE}`)
  return text === null ? null : parseTeam(text)
}

/**
 * `/progress team` (F1): the team, what a spec needs and who you are.
 * `/progress team init [force]`: a first tasks/team.md drafted from the git
 * authors, never over an existing one without `force`.
 */
async function teamCommand($: $, arg: string): Promise<string> {
  const cwd = await $.session.cwd()
  const words = arg.split(/\s+/).slice(1)
  if (words[0] !== 'init') return teamText(await readTeam($, cwd), await gitEmail($))
  const path = `${cwd}/${TEAM_FILE}`
  if ((await readText($, path)) !== null && words[1] !== 'force') {
    return `${TEAM_FILE} is already here, so nothing was written. /progress team shows it; /progress team init force replaces it with a fresh draft.`
  }
  const log = await $.process.run(['git', 'log', '--format=%an%x09%ae'], { timeoutMs: 15_000 }).catch(() => null)
  const authors = (log && log.exitCode === 0 ? log.stdout : '')
    .split('\n')
    .map(l => l.split('\t'))
    .filter(p => p.length === 2 && p[1]!.trim())
    .map(([name, email]) => ({ name: name!.trim(), email: email!.trim() }))
  const draft = draftTeam(authors)
  await $.fs.write(path, draft)
  const n = parseTeam(draft).members.length
  return n
    ? `Wrote ${TEAM_FILE} with ${n} ${n === 1 ? 'person' : 'people'} from the git authors: fill in their roles, and in approvals: the roles that must sign a spec.`
    : `Wrote ${TEAM_FILE} with an empty table: git shows no authors yet. Add a row per person (handle, role, git email).`
}

/**
 * `/progress assign T4 @sara`, `assign T4 me`, `claim T4`, `unassign T4`
 * (format-v2, F2 and F3): the owner on the task's Status line, every other
 * byte kept. Anyone may assign: roles are shown, never enforced.
 */
async function ownerCommand($: $, verb: 'assign' | 'claim' | 'unassign', words: string[]): Promise<string> {
  const p = await load($)
  const path = `${p.cwd}/tasks/todo.md`
  const text = await readText($, path)
  if (text === null) return 'No tasks/todo.md here.'
  const rawId = words[0] ?? ''
  if (!rawId) return `Say which task: /progress ${verb} T4${verb === 'assign' ? ' @sara' : ''}.`
  const id = /^\d+$/.test(rawId) ? `T${rawId}` : rawId.toUpperCase()
  const task = p.list?.tasks.find(t => t.id === id)
  if (!task || !hasTaskSection(text, id)) return `No "## Task ${id.slice(1)}:" section in tasks/todo.md.${p.list?.tasks.length ? ` Tasks: ${p.list.tasks.map(t => t.id).join(', ')}.` : ''}`
  const team = await readTeam($, p.cwd)
  let owner: string | null = null
  let isYou = false
  if (verb !== 'unassign') {
    const who = verb === 'claim' ? 'me' : words[1]
    if (!who) return `Say who: /progress assign ${id} @sara, or /progress claim ${id} for yourself.`
    if (who === 'me') {
      const email = await gitEmail($)
      const me = whoIs(team, email)
      if (!me) {
        const why = !team ? 'no tasks/team.md here. /progress team init sets one up;' : !email ? 'git config user.email is not set. Set it,' : `${email} is not in tasks/team.md. Add a row with it,`
        return `Can't tell who you are: ${why} or name someone: /progress assign ${id} @name.`
      }
      owner = me.handle
      isYou = true
    } else owner = who.startsWith('@') ? who : `@${who}`
  }
  const was = task.owner
  await $.fs.write(path, setOwner(text, id, owner))
  await load($)
  if (!owner) return `${id} ${task.title} has no owner now${was ? ` (was ${was})` : ''}.`
  const unknown = team && !team.members.some(m => m.handle.toLowerCase() === owner!.toLowerCase()) ? ` ${owner} is not in tasks/team.md (/progress team).` : ''
  return `${id} ${task.title} → ${owner}${isYou ? ' (you)' : ''}${was && was !== owner ? `, was ${was}` : ''}.${unknown}`
}

/**
 * `/progress handoff T4 @bob "migration done, tests left"` (format-v2, F6): the
 * task's new owner, and a dated note under it from the old owner (else you), which
 * the next person's agent reads with the current task.
 */
async function handoffCommand($: $, rest: string): Promise<string> {
  const m = /^(\S+)?\s*(@[\w.-]+)?\s*([\s\S]*)$/.exec(rest)!
  const rawId = m[1] ?? ''
  const to = m[2]
  const note = (m[3] ?? '').trim().replace(/^["'“”]|["'“”]$/g, '').trim()
  const p = await load($)
  const path = `${p.cwd}/tasks/todo.md`
  const text = await readText($, path)
  if (text === null) return 'No tasks/todo.md here.'
  if (!rawId) return 'Say which task: /progress handoff T4 @bob "migration done, tests left".'
  const id = /^\d+$/.test(rawId) ? `T${rawId}` : rawId.toUpperCase()
  const task = p.list?.tasks.find(t => t.id === id)
  if (!task || !hasTaskSection(text, id)) return `No "## Task ${id.slice(1)}:" section in tasks/todo.md.${p.list?.tasks.length ? ` Tasks: ${p.list.tasks.map(t => t.id).join(', ')}.` : ''}`
  if (!to) return `Say who takes it: /progress handoff ${id} @bob "${note || 'note'}".`
  if (!note) return `Say what the next person needs to know: /progress handoff ${id} ${to} "migration done, tests left".`
  const from = task.owner ?? (await sessionHandle($, p.cwd))
  await $.fs.write(path, addHandoff(text, id, { day: dayOf(await $.clock.now()), from, to, note }))
  await load($)
  return `${id} ${task.title} → ${to}${from ? `, from ${from}` : ''}. Note: "${note}".`
}

/**
 * `/progress review T4 [#42 | PR link] [@bob]` (format-v2, F4): the task in
 * review, with its PR and reviewer; owner and dates kept. A done task, or one
 * with nothing ticked yet, is refused with why.
 */
async function reviewCommand($: $, words: string[]): Promise<string> {
  const p = await load($)
  const path = `${p.cwd}/tasks/todo.md`
  const text = await readText($, path)
  if (text === null) return 'No tasks/todo.md here.'
  const rawId = words[0] ?? ''
  if (!rawId) return 'Say which task: /progress review T4 #42 @bob (PR and reviewer optional).'
  const id = /^\d+$/.test(rawId) ? `T${rawId}` : rawId.toUpperCase()
  const task = p.list?.tasks.find(t => t.id === id)
  if (!task || !hasTaskSection(text, id)) return `No "## Task ${id.slice(1)}:" section in tasks/todo.md.${p.list?.tasks.length ? ` Tasks: ${p.list.tasks.map(t => t.id).join(', ')}.` : ''}`
  let pr: string | undefined
  let reviewer: string | undefined
  for (const w of words.slice(1)) {
    if (/^#\d+$/.test(w) || /^https?:\/\//i.test(w)) pr = w
    else if (/^@[\w.-]+$/.test(w)) reviewer = w
    else return `Not a PR or a reviewer: "${w}". Use /progress review ${id} #42 @bob (both optional).`
  }
  if (task.status === 'done') return `${id} ${task.title} is done: a review comes before its last box is ticked.`
  if (!task.boxes.some(b => b.isDone) && task.state?.status !== 'in progress' && task.state?.status !== 'in review') {
    return `${id} ${task.title} has no box ticked yet: build it first, or /progress start ${id}.`
  }
  await $.fs.write(path, setReview(text, id, { pr, reviewer }))
  const after = (await load($)).list?.tasks.find(t => t.id === id)
  const bits = [after?.pr && `PR ${after.pr}`, after?.reviewer && `reviewer ${after.reviewer}`].filter(Boolean)
  return `${id} ${task.title} is in review${bits.length ? `: ${bits.join(', ')}` : ''}.`
}

/**
 * `/progress dashboard [view]` (K6): the dashboard page from the same project the
 * board shows (the plugin's own history included), opened on `view`. Written even
 * without a task list, since the page then says how to start.
 */
async function writeDashboard($: $, p: AsmProject, view: string): Promise<string> {
  if (view && !VIEW_IDS.includes(view as ViewId)) return `No view "${view}". Views: ${VIEW_IDS.join(', ')}.`
  // Every spec file, for the Spec view: the one in focus is parsed already.
  const specs = (
    await Promise.all(
      p.specFiles.map(async file => {
        if (file === p.specFile && p.spec) return { file, spec: p.spec }
        const text = await readText($, `${p.cwd}/${file}`)
        return text === null ? null : { file, spec: parseSpec(text) }
      }),
    )
  ).filter(x => x !== null)
  const state = toState({
    cwd: p.cwd,
    today: dayOf(await $.clock.now()),
    specs,
    specFile: p.specFile,
    list: p.list,
    listFile: p.listFile,
    plan: p.plan,
    forecast: p.forecast,
    snapshots: p.snapshots,
    dates: p.dates,
    history: p.history ? historyNote(p.history, p.listFile) : null,
    ...(await (async () => {
      const team = await readTeam($, p.cwd)
      return { team, me: team ? whoIs(team, await gitEmail($)) : null }
    })()),
  })
  const html = dashboardHtml(state, { view: (view || undefined) as ViewId | undefined })
  const path = `${p.cwd}/${DASHBOARD_FILE}`
  await $.fs.write(path, html)
  const size = `${Math.max(1, Math.round(html.length / 1024))} KB`
  return (await openFile($, path))
    ? `Wrote ${DASHBOARD_FILE} (${size}) and opened it in your browser${view ? ` on ${view}` : ''}. One self-contained page: it works offline and can be attached to an email.`
    : `Wrote ${DASHBOARD_FILE} (${size}): one self-contained page that works offline. Open ${path} in a browser.`
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

/** `/progress doctor [fix]`: problems in the task files, plan and specs; `fix` applies the fixable ones. */
async function doctor($: $, fix: boolean): Promise<string> {
  const p = await load($)
  const cwd = p.cwd
  const today = dayOf(await $.clock.now())
  const read = async (f: string) => readText($, `${cwd}/${f}`)
  const gather = async () => ({
    todo: await read('tasks/todo.md'),
    plan: await read('tasks/plan.md'),
    specs: (await Promise.all(p.specFiles.map(async file => ({ file, text: await read(file) })))).filter((x): x is { file: string; text: string } => x.text !== null),
    today,
    keepFormat,
    past,
  })
  const past = await pastOf($, p)
  let input = await gather()
  if (fix) {
    const fixed: string[] = []
    if (input.todo !== null) {
      const next = stampTodoPast(input.todo, today, past)
      if (next !== input.todo) await $.fs.write(`${cwd}/tasks/todo.md`, next), fixed.push('tasks/todo.md')
    }
    for (const [file, text] of [['tasks/plan.md', input.plan] as const, ...input.specs.map(x => [x.file, x.text] as const)]) {
      if (text === null) continue
      const next = backdateDoc(stampDoc(text, today, past.files[file]), past.files[file] ?? {})
      if (next !== text) await $.fs.write(`${cwd}/${file}`, next), fixed.push(file)
    }
    await load($)
    input = await gather()
    const rest = diagnose(input)
    return `${fixed.length ? `Fixed ${fixed.join(', ')}.` : 'Nothing fixable to change.'}\n\n${doctorText(rest)}`
  }
  return doctorText(diagnose(input))
}

/**
 * `/progress start|done|block|unblock T4 ["why"]`: the person sets a task's
 * state, written into tasks/todo.md (and a blocking question into plan.md).
 */
async function setTask($: $, verb: string, rawId: string, why: string): Promise<string> {
  const p = await load($)
  const cwd = p.cwd
  const path = `${cwd}/tasks/todo.md`
  const text = await readText($, path)
  if (text === null) return 'No tasks/todo.md here.'
  const id = /^\d+$/.test(rawId) ? `T${rawId}` : rawId.toUpperCase()
  const task = p.list?.tasks.find(t => t.id === id)
  if (!task || !hasTaskSection(text, id)) return `No "## Task ${id.slice(1)}:" section in tasks/todo.md.${p.list?.tasks.length ? ` Tasks: ${p.list.tasks.map(t => t.id).join(', ')}.` : ''}`
  const today = dayOf(await $.clock.now())
  const changes = await readPending($, cwd)
  let next = text
  let said = ''
  if (verb === 'start') {
    const owner = task.owner ? undefined : ((await sessionHandle($, cwd)) ?? undefined)
    next = stampTodo(text, today, { changes: { ...changes, [id]: { status: 'in progress', started: today, ...(owner ? { owner } : {}) } } })
    said = `${id} ${task.title} is in progress (started ${shortDay(task.state?.started ?? today)}).`
  } else if (verb === 'done') {
    next = stampTodo(tickTask(text, id), today, { changes })
    said = `${id} ${task.title} is done: ${task.boxes.filter(b => !b.isDone).length} box(es) ticked.`
  } else if (verb === 'block') {
    if (!why) return 'Say why: /progress block T6 "Upstash or self-hosted?"'
    next = stampTodo(text, today, { changes: { ...changes, [id]: { status: 'blocked' } } })
    const planPath = `${cwd}/tasks/plan.md`
    const added = addQuestion(await readText($, planPath), id, why)
    await $.fs.write(planPath, added.text)
    said = `${id} ${task.title} is blocked. Added ${added.q} to tasks/plan.md: "${why}".`
  } else {
    next = stampTodo(text, today, { changes: { ...changes, [id]: { status: 'todo' } } })
    said = `${id} ${task.title} is unblocked. Remove or answer its question in tasks/plan.md so it stays that way.`
  }
  if (next !== text) await $.fs.write(path, next)
  await $.store.set(pendingKey(cwd), {})
  await load($)
  return said
}

/**
 * `/spec-view diff`: what changed in the spec since it was approved (the last
 * commit of it on or before the approval day), or since its last commit.
 */
async function specChanges($: $): Promise<string> {
  const p = await load($)
  if (!p.spec || !p.specFile) return `No SPEC.md in ${p.cwd}.`
  const file = p.specFile
  const run = (argv: string[]) => $.process.run(argv, { timeoutMs: 15_000 }).catch(() => null)
  let base = 'HEAD'
  let since = 'its last commit'
  if (p.spec.approvedOn) {
    const r = await run(['git', 'rev-list', '-1', `--before=${p.spec.approvedOn}T23:59:59`, 'HEAD', '--', file])
    if (r && r.exitCode === 0 && r.stdout.trim()) {
      base = r.stdout.trim()
      since = `its approval on ${shortDay(p.spec.approvedOn)} (${base.slice(0, 7)})`
    }
  }
  const d = await run(['git', 'diff', '--no-color', base, '--', file])
  if (!d || d.exitCode !== 0) {
    await update($, specDiff, () => null)
    return `Can't diff ${file}: ${d ? 'git has no commit of it to compare with' : 'git is not available'}.`
  }
  const diff = d.stdout.trimEnd()
  if (!diff) {
    await update($, specDiff, () => null)
    return `${file} has not changed since ${since}.`
  }
  const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length
  const removed = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length
  await update($, specDiff, () => ({ file, since, diff }))
  void $.ui.open({ id: SPEC_PANE, title: 'Spec' })
  return `${file} since ${since}: +${added} −${removed} lines. The spec pane shows the diff.\n\n\`\`\`diff\n${diff}\n\`\`\``
}

/** The checkpoint gate: a source edit while a reached checkpoint waits for review. Never blocks. */
async function checkpointGate<R extends { context?: readonly string[] }>($: $, path: string, result: R): Promise<R> {
  try {
    const p = (await read($, project)) ?? (await load($))
    const warning = checkpointWarning({ cwd: p.cwd, path, list: p.list })
    if (!warning) return result
    if (!(await read($, cpWarned))) {
      await update($, cpWarned, () => true)
      $.ui.toast(warning.toast)
    }
    return { ...result, context: [...(result.context ?? []), warning.context] }
  } catch {
    return result
  }
}

/** A box ticked or unticked from the board: written to tasks/todo.md, Status line and toast as for any edit. */
async function pressBox($: $, id: string, index: number) {
  const p = await read($, project)
  if (!p) return
  const path = `${p.cwd}/tasks/todo.md`
  const text = await readText($, path)
  if (text === null) return
  const toggled = toggleBox(text, id, index)
  if (toggled === text) return
  const next = keepFormat ? stampTodo(toggled, dayOf(await $.clock.now()), { changes: await readPending($, p.cwd) }) : toggled
  await $.fs.write(path, next)
  if (keepFormat) await $.store.set(pendingKey(p.cwd), {})
  const before = p.list
  const after = (await load($)).list
  const toast = completionToast(before, after)
  if (toast) $.ui.toast(toast)
}

/** `build T4` while building or testing, the stage alone otherwise. */
async function stageLabel($: $): Promise<string | null> {
  const s = await read($, stage)
  if (!s) return null
  const t = (await read($, project))?.list?.current
  return s === 'build' || s === 'test' ? `${s}${t ? ` ${t.id}` : ''}` : s
}

const reply = (text: string) => ({ text })

/** The commands whose replies are drawn styled (see `drawReply`). */
const REPLY_COMMANDS = new Set(['progress', 'spec-view'])

/** A reply as kinds of line (lib/reply.ts), drawn at the transcript's width. */
function drawReply($: $, e: Parameters<$['ui']['resolve']>[0], lines: ReplyLine[]) {
  const { Box, Text } = $.ui.resolve(e)
  const words = (parts: Inline[], props: { bold?: boolean; dim?: boolean } = {}) =>
    parts.map((x, i) =>
      x.isCode ? (
        <Text key={`w${i}`} color="claude">
          {x.text}
        </Text>
      ) : (
        <Text key={`w${i}`} bold={props.bold} dimColor={props.dim}>
          {x.text}
        </Text>
      ),
    )
  // A glyph in its own column, so a wrapped line stays under the text, not the glyph.
  const row = (key: string, indent: number, glyph: JSX.Element | null, body: JSX.Element) => (
    <Box key={key} flexDirection="row" paddingLeft={Math.min(indent, 8)}>
      {glyph && (
        <Box width={2} flexShrink={0}>
          {glyph}
        </Box>
      )}
      <Box flexGrow={1} flexShrink={1}>
        {body}
      </Box>
    </Box>
  )
  // Under the echo, as every command's row is: `  ⎿  ` then the reply.
  return (
    <Box flexDirection="row">
      <Box width={5} flexShrink={0}>
        <Text dimColor>{'  ⎿  '}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      {lines.map((l, i) => {
        const k = `r${i}`
        switch (l.kind) {
          case 'blank':
            return <Text key={k}> </Text>
          case 'title':
            return (
              <Text key={k} wrap="wrap">
                {l.label && <Text color="claude">{`${l.label}  `}</Text>}
                {words(l.text, { bold: true })}
                {l.note && <Text dimColor>{`  ${l.note}`}</Text>}
              </Text>
            )
          case 'heading':
            return (
              <Text key={k} bold color="claude">
                {l.text}
              </Text>
            )
          case 'box':
            return row(k, l.indent, <Text color={l.isDone ? 'success' : 'subtle'}>{l.isDone ? '✓' : '☐'}</Text>, <Text wrap="wrap" dimColor={l.isDone}>{words(l.text)}</Text>)
          case 'mark':
            return row(
              k,
              l.indent,
              <Text color={l.level === 'error' ? 'error' : 'warning'}>{l.level === 'error' ? '×' : '!'}</Text>,
              <Text wrap="wrap">
                {words(l.text)}
                {l.note && <Text dimColor>{`  ${l.note}`}</Text>}
              </Text>,
            )
          case 'bullet':
            return row(k, l.indent, <Text dimColor>·</Text>, <Text wrap="wrap">{words(l.text)}</Text>)
          case 'field':
            return row(
              k,
              l.indent,
              null,
              <Text wrap="wrap">
                <Text dimColor>{`${l.label}  `}</Text>
                {words(l.text)}
              </Text>,
            )
          default:
            return row(k, l.indent, null, <Text wrap="wrap">{words(l.text)}</Text>)
        }
      })}
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  keepFormat = options.progressFormat !== false
  notifyOn = options.notifications !== false
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'agent-skills plan pane: tasks, or timeline | charts | graph. Also next | digest | report | dashboard | history | format | allow-overwrite | refresh',
      argumentHint: '[timeline|charts|graph|next|digest|report|dashboard [view]|team [init]|history|format|allow-overwrite|refresh]',
    })
    await $.command.register({
      name: 'spec-view',
      description: 'Open SPEC.md, or a module spec (specs/<id>.md or SPEC-<id>.md), as a pane with its six core areas; diff shows its changes since approval',
      argumentHint: '[module id | diff]',
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
    if (arg === 'diff') return reply(await specChanges($))
    if (arg === '') await update($, specDiff, () => null)
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
    // As typed: handles and links keep their case.
    const rawWords = e.args.trim().split(/\s+/)
    const p = await load($)
    if (arg === 'next') return reply(nextText(p.list, p.plan))
    if (arg === 'allow-overwrite') {
      await update($, allowOverwrite, () => true)
      return reply('The next turn may overwrite tasks/plan.md or tasks/todo.md even with unfinished tasks.')
    }
    if (arg === 'refresh') return reply(statusText(p.spec, p.list) ?? 'No SPEC.md or tasks files here.')
    const one = /^task\s+#?(t?\d+)$/i.exec(e.args.trim())
    if (one) {
      const id = /^\d+$/.test(one[1]!) ? `T${one[1]}` : one[1]!.toUpperCase()
      if (!p.list?.tasks.some(t => t.id === id)) return reply(`No ${id} in ${p.listFile ?? 'tasks/todo.md'}.${p.list?.tasks.length ? ` Tasks: ${p.list.tasks.map(t => t.id).join(', ')}.` : ''}`)
      const n = id.slice(1)
      const log = await $.process
        .run(['git', 'log', '--max-count=300', '--format=%h %as %s', `--grep=T${n}`, `--grep=Task ${n}`, '-i'], { timeoutMs: 10_000 })
        .catch(() => null)
      const commits = log && log.exitCode === 0 ? commitsNaming(log.stdout, id) : []
      await update($, focus, () => id)
      await showTab($, 'tasks')
      void $.ui.open({ id: BOARD_PANE, title: 'Plan' })
      return reply(taskDetail(p.list, id, { today: dayOf(await $.clock.now()), dates: p.dates, commits })!)
    }
    const taskVerb = /^(start|done|block|unblock)\s+#?(t?\d+)\s*(.*)$/i.exec(e.args.trim())
    if (taskVerb) return reply(await setTask($, taskVerb[1]!.toLowerCase(), taskVerb[2]!, taskVerb[3]!.replace(/^["']|["']$/g, '').trim()))
    if (arg === 'doctor' || arg === 'doctor fix') return reply(await doctor($, arg.endsWith('fix')))
    if (arg === 'archive' || arg === 'archive force') return reply(await archivePlan($, arg.endsWith('force')))
    if (arg === 'graph') {
      await showTab($, 'graph')
      await $.ui.open({ id: BOARD_PANE, title: 'Plan' })
      return reply(p.list ? `Dependency graph opened: critical path ${criticalPath(p.list).join(' → ') || 'none, every task is done'}.` : nextText(null, p.plan))
    }
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
    if (arg === 'standup') {
      const text = standupText(p, dayOf(await $.clock.now()))
      const copied = await $.ui.copy({ text }).catch(() => ({ isCopied: false as const, reason: 'refused' as const }))
      return reply(`${text}\n\n${copied.isCopied ? 'Copied to the clipboard.' : `Not copied (${copied.reason}); select the lines above.`}`)
    }
    if (arg === 'report') return reply(await writeReport($, p))
    if (arg === 'team' || arg.startsWith('team ')) return reply(await teamCommand($, arg))
    {
      const verb = rawWords[0]?.toLowerCase()
      const words = rawWords.slice(1)
      if (verb === 'assign' || verb === 'claim' || verb === 'unassign') return reply(await ownerCommand($, verb, words))
      if (verb === 'review') return reply(await reviewCommand($, words))
      if (verb === 'handoff') return reply(await handoffCommand($, e.args.trim().replace(/^\S+\s*/, '')))
    }
    if (arg === 'dashboard' || arg.startsWith('dashboard ')) return reply(await writeDashboard($, p, arg.slice('dashboard'.length).trim()))
    if (arg === 'format') return reply(await applyFormat($))
    if (arg === 'history') return reply(historyText(p.history, p.listFile))
    if (arg === 'history logs on' || arg === 'history logs off') return reply(await chooseLogs($, arg.endsWith('on')))
    if (arg !== '') return reply(`Unknown argument "${arg}". Use: /progress [timeline|charts|graph|next|task T4|start T4|done T4|block T6 "why"|unblock T6|assign T4 @sara|claim T4|unassign T4|review T4 #42 @bob|handoff T4 @bob \"note\"|digest|standup|report|dashboard [view]|team [init]|history|format|archive|doctor|allow-overwrite|refresh]`)
    await showTab($, 'tasks')
    await $.ui.open({ id: BOARD_PANE, title: 'Plan' })
    return reply(p.list ? `Board opened: ${p.list.done}/${p.list.total} tasks done.` : nextText(null, p.plan))
  })

  // ----------------------------------------------------------- write guard (D1)

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const write = async () => {
      const d = await drift($, e.file_path, await readText($, e.file_path), e.content).catch(() => ({ text: e.content, note: null }))
      const content = await formatted($, e.file_path, d.text).catch(() => d.text)
      return withNote(await next(content === e.content ? e : { ...e, content }), d.note)
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
    const d = await drift($, e.file_path, before, after)
    const stamped = await formatted($, e.file_path, d.text)
    const edit = stamped === after ? null : editBetween(before, stamped)
    return withNote(await next(edit ? { ...e, ...edit, replace_all: false } : e), d.note)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // ----------------------------------------------------------- after each tool call: refresh (A1, B1) and step (H3, F1)

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await trackStep($, e, result)
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : null
    if (path && EDIT_TOOLS.has(String(e.tool)) && !result.isError && !result.deny && !WATCHED.test(path)) {
      let out = result
      if (options.specGate === true) out = await specGate($, path, out)
      if (options.checkpointGate === true) out = await checkpointGate($, path, out)
      return out
    }
    if (!path || !EDIT_TOOLS.has(String(e.tool)) || !WATCHED.test(path) || result.isError) return result
    // A refresh that fails must never change the tool's own result.
    try {
      const before = (await read($, project))?.list ?? null
      const after = (await load($)).list
      const toast = GUARDED.test(path) ? completionToast(before, after) : undefined
      if (toast) $.ui.toast(toast)
      // The moments that need a person: a checkpoint to review, or the whole plan done.
      if (toast?.startsWith('♦ Checkpoint reached')) notify($, 'Checkpoint reached', toast.replace(/^♦ Checkpoint reached: /, ''))
      else if (toast && after && after.total > 0 && after.done === after.total) notify($, 'All tasks done', `${after.total} of ${after.total} tasks done. Next: /review.`)
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
      await update($, cpWarned, () => false)
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

  // ------------------------------------------------------------ command replies

  // The plugin's replies are plain text, which is what the model reads. The row
  // that shows them is drawn styled: a bold title, boxes with their glyph, marks
  // in their colour, fields with a dim label, wrapped lines kept under their text.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.isErrored || !REPLY_COMMANDS.has(e.props.command)) return next(e)
    // The row's text carries the plugin's name in front: `agent-skills-mods: Next: …`.
    const lines = replyLines(e.props.text.replace(/^agent-skills-mods:\s*/, ''))
    if (lines.length === 0) return next(e)
    return drawReply($, e, lines)
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
    const warnings = list && t ? alerts({ list, snapshots: p?.snapshots ?? [], today: dayOf(await $.clock.now()) }) : []
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
                {t.owner && <Text dimColor> · {t.owner}</Text>}
              </Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {openCounts(t)}
            </Text>
            {t.checkpoint && <Text dimColor>checkpoint after this task</Text>}
          </Box>
        )}
        {warnings.map(w => (
          <Text color="warning" wrap="truncate-end">
            ! {w}
          </Text>
        ))}
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
    const Code = $.ui.resolve(e).Code
    const changes = await read($, specDiff)
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
              {approval === 'approved'
                ? `approved${approvedNote}`
                : p?.team?.approvals.length
                  ? approvalStatus(spec.approvals ?? [], p.team).text
                  : 'awaiting approval'}
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
        {changes && changes.file === p?.specFile && (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text bold>Changes</Text> <Text dimColor>since {changes.since}</Text>
            </Text>
            <Code source={changes.diff} format="diff" wrap="truncate-end" />
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
  const view =
    active === 'timeline'
      ? await timelineView($, e, p)
      : active === 'charts'
        ? await chartsView($, e, p)
        : active === 'graph'
          ? await graphView($, e, p)
          : await tasksView($, e, p)
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
    const { Box, Button, Text } = $.ui.resolve(e)
    const picked = await read($, expanded)
    const list = p?.list
    // The current task is open by default, so its boxes can be ticked with a click.
    const open = picked === null ? (list?.current?.id ?? null) : picked || null
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
              {/* The current task's row is shaded (mockups 7, 9) with the theme's own dimmed diff tint, so it reads in light and dark. */}
              <Box flexDirection="row" justifyContent="space-between" gap={1} backgroundColor={row.isCurrent ? 'diffAddedDimmed' : undefined}>
                <Button key={`task-${row.id}`} label={`${row.glyph} ${row.id} ${row.title}`} plain onPress={() => void update($, expanded, () => (open === row.id ? '' : row.id))}>
                  <Text inverse={row.id === focused} bold={row.isCurrent}>
                    <Text color={color[row.tone]}>{row.glyph}</Text> <Text bold={row.isCurrent}>{row.id}</Text>{' '}
                    <Text dimColor={row.tone === 'muted' && !row.isCurrent}>{row.title}</Text>
                  </Text>
                </Button>
                <Box flexShrink={0}>
                  <Text color={color[row.rightTone]} bold={row.isCurrent}>
                    {open === row.id ? '▾ ' : ''}
                    {row.right}
                  </Text>
                </Box>
              </Box>
              {open === row.id
                ? (list.tasks.find(t => t.id === row.id)?.boxes ?? []).map((b, bi) => (
                    <Box key={`box-${row.id}-${bi}`} paddingLeft={2}>
                      <Button key={`box-${row.id}-${bi}`} label={`${b.isDone ? '☑' : '☐'} ${b.text}`} plain dimColor={b.isDone} onPress={() => void pressBox($, row.id, bi)}>
                        <Text color={b.isDone ? 'success' : undefined}>{b.isDone ? '☑' : '☐'}</Text> {b.text}
                      </Button>
                    </Box>
                  ))
                : row.under.map(u => (
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
  // The desktop mockup's figures, now-bar and days per task, on every surface.
  const figures = p ? headline(p) : []
  const counts = list ? nowCounts(list) : null
  const barWidth = Math.max(10, Math.min(60, body - 2))
  const seg = (n: number) => (counts && list && list.total ? Math.round((n / list.total) * barWidth) : 0)
  const today = dayOf(await $.clock.now())
  const perTask = p ? taskDays({ ...p, today, charts: { burnup: null, flow: null } }) : []
  const maxDays = Math.max(1, ...perTask.map(x => x.days))
  const nameW = Math.min(26, Math.max(0, ...perTask.map(x => `${x.id} ${x.title}`.length)))
  const figureW = Math.max(16, Math.floor((body - 6) / 4))
  return (
    <Box flexDirection="column" gap={1}>
      {figures.length > 0 && (
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {figures.map(f => (
            <Box key={f.label} flexDirection="column" width={figureW}>
              <Text dimColor>{f.label.toUpperCase()}</Text>
              <Text>
                <Text bold>{f.value}</Text>
                {f.unit ? <Text dimColor> {f.unit}</Text> : ''}
              </Text>
              <Text dimColor wrap="truncate-end">
                {f.sub}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      {counts && list && list.total > 0 && (
        <Box flexDirection="column">
          <Text bold>Now</Text>
          <Text>
            <Text color={hex(COLOR.done)}>{'█'.repeat(seg(counts.done))}</Text>
            <Text color={hex(COLOR.doing)}>{'█'.repeat(seg(counts.doing))}</Text>
            <Text color={hex(COLOR.blocked)}>{'█'.repeat(seg(counts.blocked))}</Text>
            <Text color={hex(COLOR.todo)}>{'█'.repeat(Math.max(0, barWidth - seg(counts.done) - seg(counts.doing) - seg(counts.blocked)))}</Text>
          </Text>
          <Text dimColor>
            done {counts.done} · in progress {counts.doing} · blocked {counts.blocked} · to do {counts.todo}
          </Text>
        </Box>
      )}
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
      {perTask.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Days per task</Text>
          {perTask.map(x => (
            <Text key={`d-${x.id}`} wrap="truncate-end">
              {fitTo(`${x.id} ${x.title}`, nameW)}{' '}
              <Text color={x.isRunning ? 'warning' : 'success'}>{'█'.repeat(Math.max(1, Math.round((x.days / maxDays) * Math.max(6, Math.min(30, body - nameW - 14)))))}</Text>
              <Text dimColor>
                {' '}
                {x.days}d{x.isRunning ? ' so far' : ''}
              </Text>
            </Text>
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

async function graphView($: $, e: PaneEvent, p: AsmProject | null) {
  const { Box, Text } = $.ui.resolve(e) as any
  const list = p?.list
  if (!list || list.total === 0) return <Text dimColor>{nextText(list ?? null, p?.plan ?? null)}</Text>
  const color = { text: undefined, strong: undefined, muted: 'subtle', done: 'success', run: 'warning', bad: 'error', needsYou: 'permission', accent: 'claude' } as const
  const line = (l: Seg[], i: number) => (
    <Text key={i} wrap="truncate-end">
      {l.length === 0
        ? ' '
        : l.map(seg => (
            <Text color={color[seg.tone]} bold={seg.tone === 'strong'}>
              {seg.text}
            </Text>
          ))}
    </Text>
  )
  const path = criticalPath(list)
  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        <Text bold color="claude">
          dependencies
        </Text>
        <Text dimColor> · each arrow points to a task that waits on the one above</Text>
      </Text>
      <Box flexDirection="column">{graphLines(list).map(line)}</Box>
      {path.length > 0 && (
        <Text wrap="wrap">
          <Text bold>Critical path </Text>
          <Text color="warning">{path.join(' → ')}</Text>
          <Text dimColor>
            {' '}
            · {path.length} unfinished task{path.length === 1 ? '' : 's'} in a row bound the finish date
          </Text>
        </Text>
      )}
      <Text dimColor>✓ done ◐ current ○ to do · waits ■ blocked</Text>
    </Box>
  )
}

async function timelineView($: $, e: PaneEvent, p: AsmProject | null) {
  const { Box, Text } = $.ui.resolve(e) as any
  const list = p?.list
  if (!p || !list || list.total === 0) return <Text dimColor>{nextText(list ?? null, p?.plan ?? null)}</Text>
  const today = dayOf(await $.clock.now())
  await countCommits($, p.cwd, began(p, today))
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
