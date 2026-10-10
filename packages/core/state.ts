// The state every surface reads (J2): spec files, task list, plan, history and
// forecast, plus what needs a person, in one versioned shape. The plugin builds it
// from what it has loaded (toState); the CLI, the dashboard and other tools read
// the project through `io` (buildState). The same parts give the same state, so
// every surface shows the same numbers. `stateJson` is the contract other tools
// read (J3): `agent-skills-progress --json` prints it. Pure.

import { forecast, dayOf, shortDay, snapshotOf, type Forecast, type Snapshot } from './forecast'
import { combine, earliestDays, gitSources, type Runner } from './history'
import { parsePlan, parseSpec, parseTasks, withBlockers, type PlanDoc, type Spec, type Task, type TaskList } from './parse'
import { decisions } from './report'
import { alerts, specApproval, specFiles, taskDates, type TaskDate } from './view'

/** How a project is read: the plugin's file system, Node's in the CLI, a fixture in tests. */
export type ProjectIo = {
  cwd: string
  /** A file's text relative to the project, or null when there is none. */
  read: (rel: string) => Promise<string | null>
  /** The file names in a folder relative to the project; empty when it is missing. */
  list: (rel: string) => Promise<string[]>
  /** Runs git; absent, history starts today. */
  run?: Runner
  now: number
}

/** What a surface has read, before anything is derived from it. */
export type StateParts = {
  cwd: string
  /** The day the state is for, YYYY-MM-DD; passed in so output is deterministic. */
  today: string
  /** Every spec file read: SPEC.md first, then SPEC-<id>.md, then specs/<module>.md. */
  specs: { file: string; spec: Spec }[]
  /** The spec in focus, one of `specs`. */
  specFile: string | null
  list: TaskList | null
  listFile: string | null
  plan: PlanDoc | null
  forecast: Forecast | null
  /** One per day, oldest first. */
  snapshots: Snapshot[]
  /** By task id: the day it was done, or the day the forecast expects it. */
  dates: Record<string, TaskDate>
  /** Where the history came from, in a few words. */
  history: string | null
  /** Commits since the plan began, when git could say. */
  commits?: number
}

/** State v1: the parts, plus what follows from them. */
export type State = StateParts & {
  schema: 1
  /** The spec in focus, parsed. */
  spec: Spec | null
  specFiles: string[]
  /** The band's warnings: a task running long, scope growing. */
  alerts: string[]
  /** What waits on a person: checkpoints reached, open questions, a spec to approve. */
  needsYou: string[]
}

/** Derives State v1 from what a surface has read. */
export function toState(p: StateParts): State {
  const spec = p.specs.find(x => x.file === p.specFile)?.spec ?? null
  return {
    schema: 1,
    ...p,
    spec,
    specFiles: p.specs.map(x => x.file),
    alerts: alerts({ list: p.list, snapshots: p.snapshots, today: p.today }),
    needsYou: decisions({ spec, list: p.list, plan: p.plan, forecast: p.forecast, snapshots: p.snapshots, specFile: p.specFile }),
  }
}

/** Reads the project through `io` the way the plugin does, with history from git when there is a runner. */
export async function buildState(io: ProjectIo, opts: { specFile?: string } = {}): Promise<State> {
  const files = specFiles(await io.list(''), await io.list('specs'))
  const texts = await Promise.all(files.map(f => io.read(f)))
  const specs = files.flatMap((file, i) => (texts[i] === null ? [] : [{ file, spec: parseSpec(texts[i]!) }]))
  const specFile = opts.specFile && specs.some(x => x.file === opts.specFile) ? opts.specFile : (specs[0]?.file ?? null)
  const spec = specs.find(x => x.file === specFile)?.spec ?? null
  const [todoText, planText] = await Promise.all([io.read('tasks/todo.md'), io.read('tasks/plan.md')])
  const plan = planText === null ? null : parsePlan(planText)
  const listSource = todoText ?? planText
  const questions = [
    ...(plan?.openQuestions ?? []).map(text => ({ file: 'tasks/plan.md', text })),
    ...(spec?.openQuestions ?? []).map(text => ({ file: specFile ?? 'SPEC.md', text })),
  ]
  const list = listSource === null ? null : withBlockers(parseTasks(listSource), questions)
  const listFile = todoText !== null ? 'tasks/todo.md' : planText !== null ? 'tasks/plan.md' : null
  const today = dayOf(io.now)
  const parts: StateParts = { cwd: io.cwd, today, specs, specFile, list, listFile, plan, forecast: null, snapshots: [], dates: {}, history: null }
  if (!list || !listFile || list.total === 0) return toState(parts)

  const src = io.run ? await gitSources(io.run, listFile, list) : null
  const empty = { snaps: [], doneDays: {} }
  const combined = combine([snapshotOf(today, list)], [src?.git ?? empty], src?.messages ?? empty)
  parts.snapshots = combined.snaps
  parts.forecast = forecast(combined.snaps, io.now)
  parts.dates = taskDates(list, earliestDays(src?.git.doneDays ?? {}, src?.messages.doneDays ?? {}), parts.forecast, today)
  const since = combined.snaps[0]?.day ?? today
  const gitDays = (combined.added.files[0] ?? 0) + combined.added.messages
  if (io.run) {
    // The earliest known day: front matter added late says the day it came in.
    const began = [list.meta?.created, plan?.created, since].filter((d): d is string => !!d).sort()[0]!
    const out = await io.run(['git', 'rev-list', '--count', `--since=${began}T00:00:00`, 'HEAD']).catch(() => null)
    const n = out && out.exitCode === 0 ? Number(out.stdout.trim()) : NaN
    if (Number.isFinite(n)) parts.commits = n
  }
  parts.history = src?.gitNote
    ? `history from today: ${src.gitNote}`
    : !src
      ? 'history from today (no git)'
      : `history since ${shortDay(since)}: ${gitDays} day${gitDays === 1 ? '' : 's'} from git`
  return toState(parts)
}

/** A task as other tools see it. */
export type TaskJson = {
  id: string
  title: string
  phase: string | null
  status: Task['status']
  deps: string[]
  /** The text of each box still open. */
  open: string[]
  date: TaskDate | null
  /** Its Status line, when the progress format is kept. */
  state: Task['state'] | null
  blockedBy: string | null
  /** The checkpoint after this task, with its items still open. */
  checkpoint: { title: string; open: string[] } | null
}

/** State v1 as JSON (J3). The fields printed before v1 keep their shape; the rest are added. */
export type StateJson = {
  schema: 1
  today: string
  cwd: string
  spec: { file: string | null; title: string | null; approval: ReturnType<typeof specApproval>; areas: Record<string, { state: string; hint: string | null }>; openQuestions: string[] } | null
  specs: { file: string; title: string | null; status: Spec['status']; created: string | null; approved: string | null }[]
  plan: { status: PlanDoc['status'] | null; created: string | null; approved: string | null; openQuestions: string[] } | null
  tasks: { file: string | null; done: number; total: number; current: string | null; items: TaskJson[] } | null
  forecast: Forecast | null
  snapshots: Snapshot[]
  alerts: string[]
  needsYou: string[]
  history: string | null
  commits: number | null
}

export function stateJson(s: State): StateJson {
  const list = s.list
  return {
    schema: 1,
    today: s.today,
    cwd: s.cwd,
    spec: s.spec && {
      file: s.specFile,
      title: s.spec.title,
      approval: specApproval(s.spec, !!list),
      areas: Object.fromEntries(s.spec.areas.map(a => [a.key, { state: a.state, hint: a.hint }])),
      openQuestions: s.spec.openQuestions,
    },
    specs: s.specs.map(({ file, spec }) => ({ file, title: spec.title, status: spec.status, created: spec.created ?? null, approved: spec.approvedOn ?? null })),
    plan: s.plan && { status: s.plan.status ?? null, created: s.plan.created ?? null, approved: s.plan.approvedOn ?? null, openQuestions: s.plan.openQuestions },
    tasks: list && {
      file: s.listFile,
      done: list.done,
      total: list.total,
      current: list.current?.id ?? null,
      items: list.tasks.map(t => ({
        id: t.id,
        title: t.title,
        phase: t.phase,
        status: t.status,
        deps: t.deps,
        open: t.boxes.filter(b => !b.isDone).map(b => b.text),
        date: s.dates[t.id] ?? null,
        state: t.state ?? null,
        blockedBy: t.blockedBy ?? null,
        checkpoint: t.checkpoint && { title: t.checkpoint.title, open: t.checkpoint.items.filter(b => !b.isDone).map(b => b.text) },
      })),
    },
    forecast: s.forecast,
    snapshots: s.snapshots,
    alerts: s.alerts,
    needsYou: s.needsYou,
    history: s.history,
    commits: s.commits ?? null,
  }
}
