// Sprints (ceremonies, C1, C4, C5): readiness, the sprint plan proposal, the
// sprint now and the sprint review. A sprint is optional, and only ever two lines
// in tasks/todo.md's front matter (`sprint:` and `commit:`). Everything else about
// it is worked out from the task list, the plan, the backlog and the committed
// copies of tasks/todo.md that git already has, so nothing new is committed for
// it. Pure: copies are handed in.

import type { Copy } from './history'
import { dayOf, shortDay } from './forecast'
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
  return sprint ? sprintOn(sprint, list, versions, today) : null
}

/** Sprint `sprint` as `list` shows it, on `today`: the work behind sprintNow and sprintReview. Pure. */
function sprintOn(sprint: Sprint, list: TaskList, versions: TodoVersion[], today: string): SprintNow {
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

/**
 * What `/progress sprint` and `--sprint` print: dates and days left, committed
 * against done, scope added. Once it has ended, its review (T8) when given, and
 * how to start the next; without a sprint, how to start one. Pure.
 */
export function sprintText(s: SprintNow | null, list: TaskList | null, today: string, review: SprintReview | null = null): string {
  if (!list || list.total === 0) return 'No task list yet, so there is no sprint.'
  const open = list.tasks.filter(t => t.status !== 'done' && /^T\d+$/.test(t.id)).slice(0, 3).map(t => t.id)
  const next = `/progress sprint start ${endAfter(today, 10)} ${open.join(' ') || 'T4 T5'}`
  if (!s) return `No sprint running. To start one that ends in two weeks: ${next}`
  if (s.phase === 'ended' && review) return `${sprintReviewText(review)}\n\nThe sprint has ended. To start the next, for two weeks: ${next}`
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

// ------------------------------------------------------------ past sprints and the review (T8, C5)

/**
 * Every sprint tasks/todo.md has held, oldest first: each distinct `sprint:` in
 * its committed copies, then the list's own. Rebuilt from history, so nothing
 * is ever committed for a past sprint. Pure.
 */
export function pastSprints(versions: TodoVersion[], current: TaskList | null): Sprint[] {
  const byStart = new Map<string, Sprint>()
  const all = [...versions].sort((a, b) => a.day.localeCompare(b.day)).map(v => v.list.meta?.sprint)
  // The newest copy of a sprint says what it committed to last.
  for (const s of [...all, current?.meta?.sprint]) if (s) byStart.set(s.start, s)
  return [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start))
}

/**
 * `/progress report sprint [day]`: the sprint with `day` in it, else the
 * running one, else the last that ended; null when there is none. Pure.
 */
export function pickSprint(versions: TodoVersion[], current: TaskList | null, day: string | null, today: string): Sprint | null {
  const all = pastSprints(versions, current)
  if (day) return all.find(s => s.start <= day && day <= s.end) ?? null
  return all.find(s => s.start <= today && today <= s.end) ?? all.filter(s => s.end < today).at(-1) ?? null
}

export type SprintReview = SprintNow & {
  /** Committed and not done on its end date; while it runs, still open. */
  carryOver: string[]
  /** The done tasks (committed, then added) with their acceptance boxes. */
  demo: { id: string; title: string; boxes: string[] }[]
  /** Checkpoints signed off between its first and last day. */
  checkpoints: { title: string; day: string }[]
  /** Each task's title and size, by id, for the text. */
  tasks: Record<string, { title: string; size?: Task['size'] }>
}

/**
 * The sprint review (C5): committed against done, scope added, what carries
 * over and the demo checklist, as the plan stood on the sprint's end date (its
 * last committed copy by then); while it runs, as the plan stands now. Pure.
 */
export function sprintReview(sprint: Sprint, current: TaskList, versions: TodoVersion[], today: string): SprintReview {
  const atEnd = today <= sprint.end ? null : [...versions].sort((a, b) => a.day.localeCompare(b.day)).filter(v => v.day <= sprint.end).at(-1)?.list
  const list = atEnd ?? current
  const now = sprintOn(sprint, list, versions, today)
  const byId = new Map(list.tasks.map(t => [t.id, t]))
  const shown = [...now.committed.done, ...now.added.done].map(id => byId.get(id)!)
  return {
    ...now,
    carryOver: now.committed.ids.filter(id => !now.committed.done.includes(id)),
    demo: shown.map(t => ({ id: t.id, title: t.title, boxes: t.boxes.filter((_, i) => (t.kinds?.[i] ?? 'criteria') === 'criteria').map(b => b.text) })),
    checkpoints: list.checkpoints.flatMap(c => (c.signedOff && c.signedOff.day >= sprint.start && c.signedOff.day <= sprint.end ? [{ title: c.title, day: c.signedOff.day }] : [])),
    tasks: Object.fromEntries(list.tasks.map(t => [t.id, { title: t.title, ...(t.size ? { size: t.size } : {}) }])),
  }
}

/** What `/progress report sprint` copies, and `--sprint` adds once the sprint has ended. Pure. */
export function sprintReviewText(r: SprintReview): string {
  const ended = r.phase === 'ended'
  const name = (id: string) => `${id} ${r.tasks[id]?.title ?? ''}${r.tasks[id]?.size ? ` (${r.tasks[id]!.size})` : ''}`.trim()
  const when = ended ? `ended ${shortDay(r.end)}` : `${r.daysLeft} of ${r.days} working day${r.days === 1 ? '' : 's'} left`
  const open = r.carryOver.length
  const lines = [
    `Sprint review${ended ? '' : ' so far'} · ${shortDay(r.start)} – ${shortDay(r.end)} · ${when}`,
    `${r.committed.done.length} of ${r.committed.ids.length} committed done (${num(r.committed.donePoints)} of ${pointsText(r.committed.points)}) · +${r.added.ids.length} added · ${open} ${ended ? (open === 1 ? 'carries over' : 'carry over') : 'still open'}`,
  ]
  const done = [...r.committed.done.map(id => `  ✓ ${name(id)}`), ...r.added.done.map(id => `  ✓ ${name(id)} (added)`)]
  if (done.length) lines.push('Done', ...done)
  if (open) lines.push(ended ? (open === 1 ? 'Carries over' : 'Carry over') : 'Still open', ...r.carryOver.map(id => `  ○ ${name(id)}`))
  const addedOpen = r.added.ids.filter(id => !r.added.done.includes(id))
  if (addedOpen.length) lines.push('Added, not done', ...addedOpen.map(id => `  ○ ${name(id)}`))
  if (r.gone.length) lines.push(`Deferred to the backlog: ${r.gone.join(', ')}`)
  const demo = [...r.demo.flatMap(d => d.boxes.map(b => `  - [ ] ${d.id} ${d.title}: ${b}`)), ...r.checkpoints.map(c => `  - [ ] Checkpoint "${c.title}" (signed off ${shortDay(c.day)})`)]
  if (demo.length) lines.push('Demo checklist', ...demo)
  return lines.join('\n')
}

/**
 * `/progress report sprint [day]` (C5): the review of the sprint with `day` in
 * it, else the running one, else the last that ended; or why there is none. Pure.
 */
export function sprintReportText(versions: TodoVersion[], current: TaskList, day: string | null, today: string): string {
  const s = pickSprint(versions, current, day, today)
  if (s) return sprintReviewText(sprintReview(s, current, versions, today))
  const all = pastSprints(versions, current).map(x => `${shortDay(x.start)} – ${shortDay(x.end)}`)
  if (!all.length) return 'No sprint to review: tasks/todo.md has never had a sprint. /progress sprint start <end> T4 T5 starts one.'
  return `${day ? `No sprint ran on ${day}.` : 'No sprint has started yet.'} Sprints: ${all.join(', ')}.`
}
