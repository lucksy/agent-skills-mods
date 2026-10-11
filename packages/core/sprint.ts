// Sprints (ceremonies, C1, C4, C5): readiness, the sprint plan proposal, the
// sprint now and the sprint review. A sprint is optional, and only ever two lines
// in tasks/todo.md's front matter (`sprint:` and `commit:`). Everything else about
// it is worked out from the task list, the plan, the backlog and the committed
// copies of tasks/todo.md that git already has, so nothing new is committed for
// it. Pure: copies are handed in.

import type { Copy } from './history'
import { dayOf, MIN_DONE, shortDay, type Snapshot } from './forecast'
import type { Sprint } from './format'
import { parseTasks, tasksNamed, type Backlog, type PlanDoc, type Task, type TaskList } from './parse'
import { pointsOf, pointsText } from './size'

// ------------------------------------------------------------------ readiness (T5)

/**
 * Why a task isn't ready to start. `blocking` keeps it out of a sprint proposal:
 * `no acceptance`, `no verification`, `waits on Q3`, `waits on T2`, `waits on
 * backlog B4`, `blocked`. `recommended` doesn't: `no size`, `no owner`.
 */
export type Readiness = { blocking: string[]; recommended: string[] }

/** Done, in progress, in review, or with a box ticked: past starting, so never asked whether it is ready. */
export function isUnderWay(t: Task): boolean {
  const s = t.state?.status
  return t.status === 'done' || s === 'in progress' || s === 'in review' || (s === 'blocked' && !!t.state?.started) || (!t.state && t.mark === 'doing') || t.boxes.some(b => b.isDone)
}

/**
 * `/progress ready`, `sprint plan` and the Sprint tab (C4): the one readiness rule.
 * Ready means acceptance and verification boxes, every dependency done (or in
 * `counted`: committed to the sprint, or earlier in the same proposal), no open
 * question naming it and no dependency on a backlog item. An answered question
 * no longer blocks. A size, and an owner once the plan has owners, are recommended. Pure.
 */
export function readiness(task: Task, list: TaskList, plan: PlanDoc | null, backlog: Backlog | null, counted: ReadonlySet<string> = new Set()): Readiness {
  const blocking: string[] = []
  const kinds = task.kinds ?? []
  if (!kinds.includes('criteria')) blocking.push('no acceptance')
  if (!kinds.includes('verification')) blocking.push('no verification')

  // Open questions: the plan's by number, then one from another file that withBlockers put on the task.
  const asked = (plan?.openQuestions ?? []).filter(q => tasksNamed(q).includes(task.id))
  for (const q of asked) blocking.push(`waits on ${/^Q\d+\b/.exec(q)?.[0] ?? 'a question'}`)
  const other = task.blockedBy && /^(.+?): ([\s\S]*)$/.exec(task.blockedBy)
  if (other && other[1] !== 'tasks/plan.md') blocking.push(`waits on ${/^Q\d+\b/.exec(other[2]!)?.[0] ?? 'a question'} in ${other[1]}`)
  if (task.state?.status === 'blocked') blocking.push('blocked')

  const byId = new Map(list.tasks.map(t => [t.id, t]))
  for (const d of task.deps) {
    if (d === task.id || counted.has(d)) continue
    const dep = byId.get(d)
    if (dep) {
      if (dep.status !== 'done') blocking.push(`waits on ${d}`)
      continue
    }
    // Not in the list: a backlog item, by its own id or by the number it had before it was deferred.
    const item = backlog?.items.find(i => i.id === d || i.was?.id === d)
    blocking.push(item ? `waits on backlog ${item.id}` : /^B\d+$/.test(d) ? `waits on backlog ${d} (not in the backlog)` : `waits on ${d} (not in the list)`)
  }

  const recommended: string[] = []
  if (!task.size) recommended.push('no size')
  if (!task.owner && list.tasks.some(t => t.owner)) recommended.push('no owner')
  return { blocking, recommended }
}

/** The tasks not yet started that miss something, blocking or recommended, in list order. */
export function notReady(list: TaskList, plan: PlanDoc | null, backlog: Backlog | null): { task: Task; readiness: Readiness }[] {
  return list.tasks
    .filter(t => !isUnderWay(t))
    .map(task => ({ task, readiness: readiness(task, list, plan, backlog) }))
    .filter(r => r.readiness.blocking.length + r.readiness.recommended.length > 0)
}

/** Reasons with every wait said once, where the first was: `waits on Q2, T4, backlog B3`. */
function waitsOnce(reasons: string[]): string[] {
  const on = reasons.filter(r => r.startsWith('waits on ')).map(r => r.slice('waits on '.length))
  const at = reasons.findIndex(r => r.startsWith('waits on '))
  const rest = reasons.filter(r => !r.startsWith('waits on '))
  return at < 0 ? reasons : [...rest.slice(0, at), `waits on ${on.join(', ')}`, ...rest.slice(at)]
}

/**
 * `/progress ready` and `--ready` (C4): a line per task not ready, `✗` when
 * something blocks it and `○` when only a size or an owner is missing; its
 * blocking reasons, then after ` · ` the recommended ones. Pure.
 */
export function readyText(list: TaskList | null, plan: PlanDoc | null, backlog: Backlog | null): string {
  if (!list || list.kind === 'empty') return 'No task list yet: readiness reads the tasks in tasks/todo.md.'
  if (list.kind !== 'tasks') return 'No "## Task N:" sections in tasks/todo.md, so there is no readiness to check.'
  const rows = notReady(list, plan, backlog)
  if (!rows.length) return '✓ every task is ready'
  const toStart = list.tasks.filter(t => !isUnderWay(t)).length
  const w = Math.max(...rows.map(r => r.task.id.length))
  const tw = Math.max(...rows.map(r => r.task.title.length))
  const lines = [`Not ready · ${rows.length} of ${toStart} task${toStart === 1 ? '' : 's'} not yet started`]
  for (const { task, readiness: r } of rows) {
    const why = [waitsOnce(r.blocking).join(', '), r.recommended.join(', ')].filter(Boolean).join(' · ')
    lines.push(`  ${r.blocking.length ? '✗' : '○'} ${task.id.padEnd(w)}  ${task.title.padEnd(tw)}  ${why}`)
  }
  lines.push(`✗ can't start yet · ○ can start; ${list.tasks.some(t => t.owner) ? 'a size and an owner are' : 'a size is'} recommended`)
  return lines.join('\n')
}

// ------------------------------------------------------------ the sprint now (T6, C5)

const DAY_MS = 86_400_000
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`)

/** Mon–Fri days from `from` to `to`, both included; 0 when `to` is before `from`. No holidays (Q5). Pure. */
export function workingDays(from: string, to: string): number {
  let n = 0
  for (let t = ms(from); t <= ms(to); t += DAY_MS) {
    const wd = new Date(t).getUTCDay()
    if (wd !== 0 && wd !== 6) n++
  }
  return n
}

/** A committed copy of tasks/todo.md, parsed: what a sprint's history is read from. */
export type TodoVersion = { day: string; list: TaskList }

/** Copies as `readCopiesSince` gives them, parsed, oldest first. Pure. */
export const versionsOf = (copies: Copy[]): TodoVersion[] => copies.map(c => ({ day: c.day, list: parseTasks(c.text) })).sort((a, b) => a.day.localeCompare(b.day))

/**
 * What the plan held when the sprint began: the first copy that carries this
 * sprint (the commit of `sprint start`), else the last copy from before its
 * first day; null when git has neither. Pure.
 */
export function sprintBase(versions: TodoVersion[], sprint: Sprint): TodoVersion | null {
  const sorted = [...versions].sort((a, b) => a.day.localeCompare(b.day))
  return sorted.find(v => v.list.meta?.sprint?.start === sprint.start && v.day >= sprint.start) ?? sorted.filter(v => v.day < sprint.start).at(-1) ?? null
}

export type SprintNow = Sprint & {
  /** Not begun yet, under way, or past its end date. */
  phase: 'upcoming' | 'running' | 'ended'
  /** Working days in the sprint, and those left from today (today included); 0 once it has ended. */
  days: number
  daysLeft: number
  /** The committed tasks still in the plan, those done, and both in points. */
  committed: { ids: string[]; done: string[]; points: number; donePoints: number }
  /** Committed tasks no longer in tasks/todo.md (deferred since). */
  gone: string[]
  /** Scope added: tasks in the plan now, not committed, that it didn't hold when the sprint began. */
  added: { ids: string[]; done: string[] }
}

/**
 * `/progress sprint` (C5): the list's sprint as of `today`, or null without one.
 * Scope added comes from `versions` (tasks/todo.md's committed copies since the
 * start): a task added, or pulled from the backlog, after the sprint began.
 * Without a copy from then, nothing counts as added. Pure.
 */
export function sprintNow(list: TaskList, versions: TodoVersion[], today: string): SprintNow | null {
  const sprint = list.meta?.sprint
  if (!sprint) return null
  const byId = new Map(list.tasks.map(t => [t.id, t]))
  const isDone = (id: string) => byId.get(id)?.status === 'done'
  const committed = sprint.commit.filter(id => byId.has(id))
  const base = sprintBase(versions, sprint)
  const before = new Set(base ? base.list.tasks.map(t => t.id) : list.tasks.map(t => t.id))
  const added = list.tasks.map(t => t.id).filter(id => /^T\d+$/.test(id) && !sprint.commit.includes(id) && !before.has(id))
  const tasks = (ids: string[]) => ids.map(id => byId.get(id)!)
  const phase = today < sprint.start ? 'upcoming' : today > sprint.end ? 'ended' : 'running'
  return {
    ...sprint,
    phase,
    days: workingDays(sprint.start, sprint.end),
    daysLeft: phase === 'ended' ? 0 : workingDays(today < sprint.start ? sprint.start : today, sprint.end),
    committed: { ids: committed, done: committed.filter(isDone), points: pointsOf(tasks(committed)), donePoints: pointsOf(tasks(committed.filter(isDone))) },
    gone: sprint.commit.filter(id => !byId.has(id)),
    added: { ids: added, done: added.filter(isDone) },
  }
}

/** The band's and the board pane's line: `sprint · 4d left · 5/8 committed · +1`. Pure. */
export function sprintLine(s: SprintNow): string {
  if (s.phase === 'ended') return `sprint ended ${shortDay(s.end)}`
  const bits = ['sprint', s.phase === 'upcoming' ? `starts ${shortDay(s.start)}` : `${s.daysLeft}d left`, `${s.committed.done.length}/${s.committed.ids.length} committed`]
  if (s.added.ids.length) bits.push(`+${s.added.ids.length}`)
  return bits.join(' · ')
}

/** `4½`: points without their unit. */
const num = (n: number) => pointsText(n).replace(/ points?$/, '')

/** A task's mark in the sprint view: done, under way, blocked, or not started. */
function mark(t: Task): string {
  if (t.status === 'done') return '✓'
  if (t.status === 'blocked') return '■'
  return t.state?.status === 'in progress' || t.state?.status === 'in review' ? '◐' : '○'
}

/** What `/progress sprint` and `--sprint` print: dates and days left, committed against done, scope added; without a sprint, how to start one. Pure. */
export function sprintText(s: SprintNow | null, list: TaskList | null, today: string): string {
  if (!list || list.total === 0) return 'No task list yet, so there is no sprint.'
  if (!s) {
    const open = list.tasks.filter(t => t.status !== 'done' && /^T\d+$/.test(t.id)).slice(0, 3).map(t => t.id)
    return `No sprint running. To start one that ends in two weeks: /progress sprint start ${endAfter(today, 10)} ${open.join(' ') || 'T4 T5'}`
  }
  const byId = new Map(list.tasks.map(t => [t.id, t]))
  const when =
    s.phase === 'ended'
      ? `ended ${shortDay(s.end)}`
      : s.phase === 'upcoming'
        ? `starts ${shortDay(s.start)} · ${s.days} working day${s.days === 1 ? '' : 's'}`
        : `${s.daysLeft} of ${s.days} working day${s.days === 1 ? '' : 's'} left`
  const row = (id: string) => {
    const t = byId.get(id)!
    const under = t.status !== 'done' && t.state?.status && t.state.status !== 'todo' && t.state.status !== 'done' ? ` · ${t.state.status}` : ''
    return `  ${mark(t)} ${t.id} ${t.title}${t.size ? ` (${t.size})` : ''}${under}`
  }
  const lines = [
    `Sprint · ${shortDay(s.start)} – ${shortDay(s.end)} · ${when}`,
    `Committed: ${s.committed.done.length} of ${s.committed.ids.length} done · ${num(s.committed.donePoints)} of ${pointsText(s.committed.points)}`,
    ...s.committed.ids.map(row),
  ]
  if (s.added.ids.length) lines.push(`Added since the start: +${s.added.ids.length}, ${s.added.done.length} done`, ...s.added.ids.map(row))
  else lines.push('Added since the start: nothing')
  if (s.gone.length) lines.push(`No longer in tasks/todo.md: ${s.gone.join(', ')}`)
  return lines.join('\n')
}

/** The day `n` working days on from `day` (`day` counted when it is one): the end a sprint of `n` days started then has. Pure. */
export function endAfter(day: string, n: number): string {
  let t = ms(day)
  let left = Math.max(1, n)
  for (;;) {
    const wd = new Date(t).getUTCDay()
    if (wd !== 0 && wd !== 6 && --left === 0) return dayOf(t)
    t += DAY_MS
  }
}

// ---- the sprint plan (T7, C1)

/** How far back the plan's pace looks, in working days. */
export const PACE_DAYS = 10

/** What a sprint plan reads; State v1 has all of it. */
export type PlanParts = { list: TaskList | null; plan: PlanDoc | null; backlog?: Backlog | null; snapshots: Snapshot[]; today: string; sprint?: SprintNow | null }

/**
 * The pace a sprint is planned against, per working day over the last
 * PACE_DAYS: the usual case and the slow case, as the forecast has them.
 * `none` under 2 working days of history, or under MIN_DONE tasks done in that time.
 */
export type SprintPace = { kind: 'pace'; unit: 'points' | 'tasks'; usual: number; slow: number; days: number } | { kind: 'none'; reason: string }

/** The day `n` working days before `day`. Pure. */
export function workingDaysBack(day: string, n: number): string {
  let t = ms(day)
  for (let left = n; left > 0; ) {
    t -= DAY_MS
    const wd = new Date(t).getUTCDay()
    if (wd !== 0 && wd !== 6) left--
  }
  return dayOf(t)
}

/** Working days after `from`, up to and including `to`: the days of work since a snapshot. */
const between = (from: string, to: string) => workingDays(dayOf(ms(from) + DAY_MS), to)

const ON_POINTS = (s: Snapshot) => s.points!
const ON_TASKS = (s: Snapshot) => s.done

/**
 * The pace (C1) over the last PACE_DAYS working days to `today`, from the newest
 * snapshot on or before their start (else the oldest). In points over the newest
 * snapshots that have them when those alone say a pace, else in tasks, as the
 * forecast does (T2). The slow case is the forecast's: the lower of the usual and
 * the last 5 working days, never under 40% of the usual, times 0.7. Pure.
 */
export function sprintPace(snapshots: Snapshot[], today: string): SprintPace {
  const upTo = snapshots.filter(s => s.day <= today)
  if (!upTo.length) return { kind: 'none', reason: 'no history yet' }
  const since = workingDaysBack(today, PACE_DAYS)
  const base = upTo.filter(s => s.day <= since).at(-1) ?? upTo[0]!
  const window = upTo.filter(s => s.day >= base.day)
  const last = window.at(-1)!
  let from = window.length
  while (from > 0 && window[from - 1]!.points !== undefined) from--
  const over = (stretch: Snapshot[], done: (s: Snapshot) => number): SprintPace => {
    const first = stretch[0]!
    const days = between(first.day, today)
    if (days < 2) return { kind: 'none', reason: 'under 2 working days of history' }
    const tasks = Math.max(0, last.done - first.done)
    if (tasks < MIN_DONE) return { kind: 'none', reason: `${tasks} of ${MIN_DONE} tasks done in the last ${PACE_DAYS} working days` }
    const usual = Math.max(0, done(last) - done(first)) / days
    const week = stretch.filter(s => s.day <= workingDaysBack(today, 5)).at(-1)
    const recent = week ? Math.max(0, done(last) - done(week)) / between(week.day, today) : usual
    return { kind: 'pace', unit: done === ON_POINTS ? 'points' : 'tasks', usual, slow: Math.max(Math.min(usual, recent), usual * 0.4) * 0.7, days }
  }
  const inPoints = from < window.length - 1 ? over(window.slice(from), ON_POINTS) : null
  return inPoints?.kind === 'pace' ? inPoints : over(window, ON_TASKS)
}

/** A proposed task: its points, the total so far, and whether it fits the slow case or only the usual one. */
export type PlanRow = { task: Task; points: number; running: number; fit: 'slow' | 'usual' }

export type SprintPlan = {
  days: number
  /** The end `sprint start` is given: `days` working days from today, today counted. */
  end: string
  pace: SprintPace
  /** In points, to the half; null without a pace, when the plan goes by count. */
  capacity: { slow: number; usual: number } | null
  /** Tasks under way first, then the ready ones in dependency order, up to the usual case. */
  proposed: PlanRow[]
  /** Ready, but past the usual case. */
  over: Task[]
  /** Not done and not ready: the blocking reasons, in list order. */
  notReady: { task: Task; reasons: string[] }[]
}

/** Every dependency in `tasks` before the tasks that wait on it; otherwise list order. */
function depOrder(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const out: Task[] = []
  const seen = new Set<string>()
  const visit = (t: Task) => {
    if (seen.has(t.id)) return
    seen.add(t.id)
    for (const d of t.deps) if (byId.has(d)) visit(byId.get(d)!)
    out.push(t)
  }
  tasks.forEach(visit)
  return out
}

/**
 * `/progress sprint plan [days]` (C1): which tasks fit `days` working days from
 * today. Tasks under way come first, then the ready ones (T5) in dependency
 * order, a dependency proposed earlier or committed to a running sprint counting
 * as met. They fill the slow case, then the usual case; the first task past the
 * usual case ends the proposal. Without a pace, every ready task is proposed.
 * Null without a `## Task N:` list. Writes nothing. Pure.
 */
export function sprintPlan(s: PlanParts, days: number): SprintPlan | null {
  const list = s.list
  if (!list || list.kind !== 'tasks') return null
  const pace = sprintPace(s.snapshots, s.today)
  const half = (n: number) => Math.round(n * 2) / 2
  const capacity = pace.kind === 'pace' ? { slow: half(pace.slow * days), usual: half(pace.usual * days) } : null
  const open = list.tasks.filter(t => t.status !== 'done')
  const going = open.filter(t => isUnderWay(t) && t.status !== 'blocked')
  const counted = new Set(s.sprint && s.sprint.phase !== 'ended' ? s.sprint.commit : [])
  const plan: SprintPlan = { days, end: endAfter(s.today, days), pace, capacity, proposed: [], over: [], notReady: [] }
  let running = 0
  for (const task of [...going, ...depOrder(open.filter(t => !going.includes(t)))]) {
    if (!going.includes(task)) {
      const { blocking } = readiness(task, list, s.plan, s.backlog ?? null, counted)
      if (blocking.length) {
        plan.notReady.push({ task, reasons: blocking })
        continue
      }
    }
    counted.add(task.id)
    const points = pointsOf([task])
    running += points
    const fit = !capacity || running <= capacity.slow ? 'slow' : running <= capacity.usual ? 'usual' : null
    if (fit && !plan.over.length) plan.proposed.push({ task, points, running, fit })
    else plan.over.push(task)
  }
  plan.notReady.sort((a, b) => list.tasks.indexOf(a.task) - list.tasks.indexOf(b.task))
  return plan
}

/**
 * What `/progress sprint plan` and `--sprint-plan` print (C1): the capacity and
 * the pace behind it; a row per proposed task with its size, points and the
 * running total; what is ready past capacity; the not-ready tasks and why; and
 * the `sprint start` line to run. Pure.
 */
export function sprintPlanText(plan: SprintPlan | null, list: TaskList | null, sprint?: SprintNow | null): string {
  if (!list || list.kind === 'empty') return 'No task list yet: a sprint plan reads the tasks in tasks/todo.md.'
  if (!plan) return 'No "## Task N:" sections in tasks/todo.md, so there is nothing to plan.'
  if (list.tasks.every(t => t.status === 'done')) return 'Every task is done: there is nothing left to plan.'
  const { pace, capacity: cap } = plan
  const span = `${plan.days} working day${plan.days === 1 ? '' : 's'}`
  const lines = [
    pace.kind === 'pace' && cap
      ? `Sprint plan · ${span} · capacity ≈ ${num(cap.slow)}–${pointsText(cap.usual)} (pace ${pace.usual.toFixed(1)}${pace.unit === 'tasks' ? ' tasks' : ''}/day, slow case ${pace.slow.toFixed(1)})`
      : `Sprint plan · ${span} · no pace yet (${pace.kind === 'none' ? pace.reason : ''}), so by count: every ready task, keep what fits`,
  ]
  if (sprint && sprint.phase !== 'ended') lines.push(`The sprint to ${shortDay(sprint.end)} hasn't ended: starting this one replaces it.`)
  const named = [...plan.proposed.map(r => r.task), ...plan.notReady.map(r => r.task)]
  const w = Math.max(...named.map(t => t.id.length))
  const tw = Math.max(...named.map(t => t.title.length))
  if (plan.proposed.length) {
    const rw = Math.max(...plan.proposed.map(r => num(r.running).length))
    for (const r of plan.proposed) {
      const st = r.task.state?.status
      const notes = [st === 'in progress' || st === 'in review' ? st : isUnderWay(r.task) ? 'under way' : '', r.fit === 'usual' ? 'usual case only' : ''].filter(Boolean)
      lines.push(`  ${r.task.id.padEnd(w)}  ${r.task.title.padEnd(tw)}  ${r.task.size ?? '-'}  ${num(r.points)}  running ${num(r.running).padEnd(rw)}  ${notes.join(' · ')}`.trimEnd())
    }
    if (plan.proposed.some(r => !r.task.size)) lines.push('  - no size: counts as 1 point')
  } else lines.push(cap && plan.over.length ? `Nothing ready fits in ${pointsText(cap.usual)}.` : 'Nothing is ready to propose.')
  if (plan.over.length) lines.push(`Ready, past capacity: ${plan.over.map(t => t.id).join(', ')}`)
  if (plan.notReady.length) {
    lines.push('Not ready:')
    for (const { task, reasons } of plan.notReady) lines.push(`  ✗ ${task.id.padEnd(w)}  ${task.title.padEnd(tw)}  ${waitsOnce(reasons).join(', ')}`)
  }
  if (plan.proposed.length) lines.push(`To start it: /progress sprint start ${plan.end} ${plan.proposed.map(r => r.task.id).join(' ')}`)
  return lines.join('\n')
}
