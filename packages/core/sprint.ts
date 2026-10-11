// Sprints (ceremonies, C1, C4, C5): readiness, the sprint plan proposal, the
// sprint now and the sprint review, over the parsed task list, plan and backlog. Pure.

import { tasksNamed, type Backlog, type PlanDoc, type Task, type TaskList } from './parse'

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
