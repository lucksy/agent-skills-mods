// Forecast from daily snapshots of the task list: a date range with its basis,
// never a single date, and nothing at all until there is enough history.

import type { TaskSize } from './format'
import type { TaskList } from './parse'
import { listPoints, pointsText, sizesOf } from './size'

/**
 * One day of a task list. `doing` and `blocked` are absent in snapshots stored
 * before 0.5.0; before 0.7.1 `blocked` also counted tasks waiting on another.
 * `points` and `totalPoints` (ceremonies, C1): done and in total by size,
 * recorded only once a task has a size, so a plan without sizes stores what it did.
 */
export type Snapshot = { day: string; done: number; total: number; doing?: number; blocked?: number; points?: number; totalPoints?: number }

export type Forecast =
  | { kind: 'done' }
  | { kind: 'not-enough'; reason: string }
  | {
      kind: 'range'
      optimistic: string
      median: string
      slow: string
      /** e.g. "from 4 tasks in 12 days" */
      basis: string
      /** Tasks added since the first snapshot. */
      added: number
    }

const DAY = 86_400_000
export const MIN_DONE = 3

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const parseDay = (day: string) => Date.parse(`${day}T00:00:00Z`)

/**
 * A list's counts on `day`: in progress is a task with some boxes ticked, not all.
 * With sizes (its own, or `sizes` by task id for an older copy), its points too.
 */
export function snapshotOf(day: string, list: TaskList, sizes: ReadonlyMap<string, TaskSize> = sizesOf(list)): Snapshot {
  const open = list.tasks.filter(t => t.status !== 'done')
  const snap: Snapshot = {
    day,
    done: list.done,
    total: list.total,
    doing: open.filter(t => t.status !== 'blocked' && (t.boxes.some(b => b.isDone) || t.state?.status === 'in progress')).length,
    blocked: open.filter(t => t.status === 'blocked').length,
  }
  if (sizes.size === 0) return snap
  const p = listPoints(list, sizes)
  return { ...snap, points: p.done, totalPoints: p.total }
}

/** Adds today's numbers, replacing an earlier snapshot of the same day. */
export function record(history: Snapshot[], snap: Snapshot): Snapshot[] {
  const rest = history.filter(s => s.day !== snap.day)
  return [...rest, snap].sort((a, b) => a.day.localeCompare(b.day)).slice(-365)
}

/** What the pace is counted in: tasks, or points once tasks have sizes (ceremonies, C1). */
type Unit = { done: (s: Snapshot) => number; total: (s: Snapshot) => number; basis: (n: number) => string }
const TASKS: Unit = { done: s => s.done, total: s => s.total, basis: n => `${n} task${n === 1 ? '' : 's'}` }
const POINTS: Unit = { done: s => s.points!, total: s => s.totalPoints!, basis: pointsText }

/**
 * The ETA range. In points over the newest days whose snapshots have them, when
 * those days alone say a pace; otherwise in tasks over the whole history, as
 * before sizes. Without Size lines no snapshot has points, so nothing changes.
 */
export function forecast(history: Snapshot[], now: number): Forecast {
  const last = history[history.length - 1]
  if (!last) return { kind: 'not-enough', reason: 'no history yet' }
  if (last.total > 0 && last.done >= last.total) return { kind: 'done' }
  const added = Math.max(0, last.total - (history[0] ?? last).total)
  let from = history.length
  while (from > 0 && history[from - 1]!.points !== undefined && history[from - 1]!.totalPoints !== undefined) from--
  const inPoints = from < history.length ? range(history.slice(from), now, POINTS) : null
  const r = inPoints?.kind === 'range' ? inPoints : range(history, now, TASKS)
  return r.kind === 'range' ? { ...r, added } : r
}

/** The range from one stretch of history in one unit; `added` is the caller's. */
function range(history: Snapshot[], now: number, unit: Unit): Extract<Forecast, { kind: 'not-enough' }> | Omit<Extract<Forecast, { kind: 'range' }>, 'added'> {
  const last = history[history.length - 1]!
  const first = history[0]!
  // Only tasks finished inside the history window say anything about pace.
  const tasksSince = Math.max(0, last.done - first.done)
  const doneSince = Math.max(0, unit.done(last) - unit.done(first))
  const days = Math.max(0, Math.round((parseDay(last.day) - parseDay(first.day)) / DAY))
  if (tasksSince < MIN_DONE) {
    return { kind: 'not-enough', reason: `not enough history (${tasksSince} of ${MIN_DONE} tasks done since tracking began)` }
  }
  if (days < 2) return { kind: 'not-enough', reason: 'not enough history (under 2 days)' }

  const overall = doneSince / days
  // The last 7 days, when the history reaches back that far.
  const weekAgo = [...history].reverse().find(s => parseDay(last.day) - parseDay(s.day) >= 7 * DAY)
  const recent = weekAgo ? (unit.done(last) - unit.done(weekAgo)) / ((parseDay(last.day) - parseDay(weekAgo.day)) / DAY) : overall

  const remaining = unit.total(last) - unit.done(last)
  const fast = Math.max(overall, recent) * 1.25
  // A stalled week pulls the slow case down, but never below 40% of the overall pace.
  const slow = Math.max(Math.min(overall, recent), overall * 0.4) * 0.7
  const at = (rate: number) => dayOf(now + Math.ceil(remaining / rate) * DAY)

  return {
    kind: 'range',
    optimistic: at(fast),
    median: at(overall),
    slow: at(slow),
    basis: `from ${unit.basis(doneSince)} in ${days} days`,
  }
}

/** `23 Oct` for a `YYYY-MM-DD` day. */
export function shortDay(day: string): string {
  const d = new Date(parseDay(day))
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`
}

/**
 * The forecast as it stood on each day of the history (ETA drift): each day's
 * forecast from the snapshots up to it, made as of that day. The last entry is
 * today's forecast.
 */
export function forecastHistory(history: Snapshot[]): { day: string; forecast: Forecast }[] {
  return history.map((s, i) => ({ day: s.day, forecast: forecast(history.slice(0, i + 1), parseDay(s.day)) }))
}

/**
 * How many days the median ETA moved: against the newest forecast at least a
 * week old, else the first one this week. Null without two range forecasts, or
 * when today's is not a range.
 */
export function etaDrift(past: { day: string; forecast: Forecast }[]): { days: number; since: string } | null {
  const ranges = past.filter((p): p is { day: string; forecast: Extract<Forecast, { kind: 'range' }> } => p.forecast.kind === 'range')
  const last = past.at(-1)
  if (!last || last.forecast.kind !== 'range' || ranges.length < 2) return null
  const weekAgo = parseDay(last.day) - 7 * DAY
  const before = ranges.filter(p => p !== ranges.at(-1))
  const base = [...before].reverse().find(p => parseDay(p.day) <= weekAgo) ?? before.find(p => parseDay(p.day) > weekAgo)!
  return { days: Math.round((parseDay(last.forecast.median) - parseDay(base.forecast.median)) / DAY), since: base.day }
}
