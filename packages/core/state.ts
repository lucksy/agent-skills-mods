// The state every surface reads (J2): spec files, task list, plan, history and
// forecast, plus what needs a person, in one versioned shape. The plugin builds it
// from what it has loaded (toState); the CLI, the dashboard and other tools read
// the project through `io` (buildState). The same parts give the same state, so
// every surface shows the same numbers. `stateJson` is the contract other tools
// read (J3): `agent-skills-progress --json` prints it. Pure.

import { forecast, dayOf, shortDay, snapshotOf, type Forecast, type Snapshot } from './forecast'
import { combine, earliestDays, gitSources, type Runner } from './history'
import { parseBacklog, parsePlan, parseSpec, parseTasks, withBlockers, type Backlog, type PlanDoc, type Spec, type Task, type TaskList } from './parse'
import { decisions } from './report'
import { alerts, specApproval, specFiles, taskDates, type TaskDate } from './view'
import { parseTeam, TEAM_FILE, whoIs, type Member, type Team } from './team'
import { moduleRows, parseCapabilityMap, type ModuleRow } from './modules'
import { readBranches, type BranchBoard } from './branches'
import { collisions, type Collision } from './collisions'
import { look, parseSeen, seenOf, type Since } from './since'
import { inbox, type InboxItem } from './inbox'
import type { TaskSize, Was } from './format'
import { BACKLOG_FILE } from './backlog'
import { pointsOf } from './size'

/** How a project is read: the plugin's file system, Node's in the CLI, a fixture in tests. */
export type ProjectIo = {
  cwd: string
  /** A file's text relative to the project, or null when there is none. */
  read: (rel: string) => Promise<string | null>
  /** The file names in a folder relative to the project; empty when it is missing. */
  list: (rel: string) => Promise<string[]>
  /** Runs git; absent, history starts today. */
  run?: Runner
  /** The folder names in a folder relative to the project (format-v2: tasks/archive); absent, none are read. */
  dirs?: (rel: string) => Promise<string[]>
  /** When this clone last fetched (team-view: FETCH_HEAD's time), ms; absent or null, never. */
  fetchedAt?: () => Promise<number | null>
  /** team-view (V4): `<git dir>/agent-skills/seen.json`'s text, the last look; absent or null, none. */
  seen?: () => Promise<string | null>
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
  /** format-v2: tasks/team.md, and who is looking (from `git config user.email`). */
  team?: Team | null
  me?: Member | null
  /** format-v2 (F7): every module of SPEC.md's capability map, with its spec and plans; null without a map. */
  modules?: ModuleRow[] | null
  /** team-view (V1): tasks/todo.md across the other branches; null when not read. */
  branches?: BranchBoard | null
  /** team-view (V1): tasks under way on two branches or with two owners; null when branches were not read. */
  collisions?: Collision[] | null
  /** team-view (V4): what changed since the last look (seen.json); null when not asked for. */
  since?: Since | null
  /** ceremonies (C2): tasks/backlog.md, parsed; absent or null when there is none. */
  backlog?: Backlog | null
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
    team: p.team ?? null,
    me: p.me ?? null,
    modules: p.modules ?? null,
    branches: p.branches ?? null,
    collisions: p.collisions ?? null,
    since: p.since ?? null,
    spec,
    specFiles: p.specs.map(x => x.file),
    alerts: alerts({ list: p.list, snapshots: p.snapshots, today: p.today }),
    needsYou: decisions({ spec, list: p.list, plan: p.plan, forecast: p.forecast, snapshots: p.snapshots, specFile: p.specFile }),
  }
}

/**
 * Reads the project through `io` the way the plugin does, with history from git
 * when there is a runner. `branches` also reads the board across branches, and
 * `since` compares the last look with now (team-view); neither writes anything.
 */
export async function buildState(io: ProjectIo, opts: { specFile?: string; branches?: boolean; since?: boolean } = {}): Promise<State> {
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
  const teamText = await io.read(TEAM_FILE)
  const team = teamText === null ? null : parseTeam(teamText)
  const email = team && io.run ? await io.run(['git', 'config', 'user.email']).then(r => (r.exitCode === 0 ? r.stdout.trim() || null : null), () => null) : null
  const parts: StateParts = { cwd: io.cwd, today, specs, specFile, list, listFile, plan, forecast: null, snapshots: [], dates: {}, history: null, team, me: whoIs(team, email), modules: await readModules(io, specs, todoText) }
  const backlogText = await io.read(BACKLOG_FILE)
  if (backlogText !== null) parts.backlog = parseBacklog(backlogText)
  if (opts.branches && io.run) {
    const fetchedAt = (await io.fetchedAt?.().catch(() => null)) ?? null
    parts.branches = await readBranches(io.run, { file: 'tasks/todo.md', now: io.now, here: todoText === null ? null : parseTasks(todoText), fetchedAt })
    parts.collisions = parts.branches ? collisions(parts.branches, io.now) : null
  }
  if (opts.since && io.seen) {
    const prev = parseSeen(await io.seen().catch(() => null))
    parts.since = look(prev, seenOf(parts, io.now), parts.me?.handle ?? null).since
  }
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

/** The capability map's modules with their specs, the active plan and the archived ones (format-v2, F7). */
export async function readModules(io: Pick<ProjectIo, 'read' | 'dirs'>, specs: { file: string; spec: Spec }[], todoText: string | null): Promise<ModuleRow[] | null> {
  const mapText = await io.read('SPEC.md')
  const map = mapText === null ? null : parseCapabilityMap(mapText)
  if (!map) return null
  const plans: { where: 'active' | 'archive'; dir: string; text: string }[] = []
  for (const d of ((await io.dirs?.('tasks/archive')) ?? []).sort()) {
    const text = await io.read(`tasks/archive/${d}/todo.md`)
    if (text !== null) plans.push({ where: 'archive', dir: `tasks/archive/${d}`, text })
  }
  if (todoText !== null) plans.push({ where: 'active', dir: 'tasks', text: todoText })
  return moduleRows(map, specs, plans)
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
  /** format-v2: who owns it, its reviewer and its pull request; null when its Status line doesn't say. */
  owner: string | null
  reviewer: string | null
  pr: string | null
  /** ceremonies (C1): its `**Size:**` line; the key is left out for a task without one, so a plan with no sizes prints as before. */
  size?: TaskSize
  /** The checkpoint after this task, with its items still open. */
  checkpoint: { title: string; open: string[] } | null
}

/** State v1 as JSON (J3). The fields printed before v1 keep their shape; the rest are added. */
export type StateJson = {
  schema: 1
  today: string
  cwd: string
  spec: { file: string | null; title: string | null; approval: ReturnType<typeof specApproval>; areas: Record<string, { state: string; hint: string | null }>; openQuestions: string[]; approvals: Spec['approvals'] } | null
  specs: { file: string; title: string | null; status: Spec['status']; created: string | null; approved: string | null; approvals: Spec['approvals'] }[]
  /** `answered` (team-view): the questions with an answer under them, which `openQuestions` no longer lists. */
  plan: { status: PlanDoc['status'] | null; created: string | null; approved: string | null; openQuestions: string[]; answered: PlanDoc['answered'] } | null
  tasks: { file: string | null; done: number; total: number; current: string | null; items: TaskJson[] } | null
  forecast: Forecast | null
  snapshots: Snapshot[]
  alerts: string[]
  needsYou: string[]
  history: string | null
  commits: number | null
  /** format-v2: handles and roles only; emails stay in tasks/team.md, out of shared pages. */
  team: { members: { handle: string; roles: string[] }[]; approvals: string[] } | null
  me: string | null
  modules: ModuleRow[] | null
  /** team-view (V1): each task's furthest state across branches; null unless asked for (`--json` asks). */
  branches: BranchBoard | null
  /** team-view (V1): each colliding task with its refs, owners and ages; null unless branches were read. */
  collisions: Collision[] | null
  /** team-view (V4): what changed since the last look, each change with who made it; null unless asked for (`--json` asks). */
  since: Since | null
  /** ceremonies (C7): what waits on me, the handle tasks/team.md gives my git email; without one, everything waiting. */
  inbox: InboxItem[]
  /** ceremonies (C2): the backlog's items and their points; the key is left out when there is no tasks/backlog.md. */
  backlog?: { file: string; points: number; items: { id: string; title: string; size: TaskSize | null; was: Was | null; deps: string[]; open: string[] }[] }
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
      approvals: s.spec.approvals ?? [],
    },
    specs: s.specs.map(({ file, spec }) => ({ file, title: spec.title, status: spec.status, created: spec.created ?? null, approved: spec.approvedOn ?? null, approvals: spec.approvals ?? [] })),
    plan: s.plan && { status: s.plan.status ?? null, created: s.plan.created ?? null, approved: s.plan.approvedOn ?? null, openQuestions: s.plan.openQuestions, answered: s.plan.answered ?? [] },
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
        owner: t.owner ?? null,
        reviewer: t.reviewer ?? null,
        pr: t.pr ?? null,
        ...(t.size ? { size: t.size } : {}),
        checkpoint: t.checkpoint && { title: t.checkpoint.title, open: t.checkpoint.items.filter(b => !b.isDone).map(b => b.text) },
      })),
    },
    forecast: s.forecast,
    snapshots: s.snapshots,
    alerts: s.alerts,
    needsYou: s.needsYou,
    history: s.history,
    commits: s.commits ?? null,
    team: s.team ? { members: s.team.members.map(m => ({ handle: m.handle, roles: m.roles })), approvals: s.team.approvals } : null,
    me: s.me?.handle ?? null,
    modules: s.modules,
    branches: s.branches ?? null,
    collisions: s.collisions ?? null,
    since: s.since ?? null,
    inbox: inbox(s, 'me'),
    ...(s.backlog
      ? {
          backlog: {
            file: BACKLOG_FILE,
            points: pointsOf(s.backlog.items),
            items: s.backlog.items.map(i => ({ id: i.id, title: i.title, size: i.size ?? null, was: i.was ?? null, deps: i.deps, open: i.boxes.filter(b => !b.isDone).map(b => b.text) })),
          },
        }
      : {}),
  }
}
