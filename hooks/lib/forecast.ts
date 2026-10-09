// Forecast from daily snapshots of the task list: a date range with its basis,
// never a single date, and nothing at all until there is enough history.

import type { TaskList } from './parse'

/** One day of a task list. `doing` and `blocked` are absent in snapshots stored before 0.5.0. */
export type Snapshot = { day: string; done: number; total: number; doing?: number; blocked?: number }

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

/** A list's counts on `day`: in progress is a task with some boxes ticked, not all. */
export function snapshotOf(day: string, list: TaskList): Snapshot {
  const open = list.tasks.filter(t => t.status !== 'done')
  return {
    day,
    done: list.done,
    total: list.total,
    doing: open.filter(t => t.boxes.some(b => b.isDone)).length,
    blocked: open.filter(t => t.status === 'blocked' && !t.boxes.some(b => b.isDone)).length,
  }
}

/** Adds today's numbers, replacing an earlier snapshot of the same day. */
export function record(history: Snapshot[], snap: Snapshot): Snapshot[] {
  const rest = history.filter(s => s.day !== snap.day)
  return [...rest, snap].sort((a, b) => a.day.localeCompare(b.day)).slice(-365)
}

export function forecast(history: Snapshot[], now: number): Forecast {
  const last = history[history.length - 1]
  if (!last) return { kind: 'not-enough', reason: 'no history yet' }
  if (last.total > 0 && last.done >= last.total) return { kind: 'done' }
  const first = history[0] ?? last
  // Only tasks finished inside the history window say anything about pace.
  const doneSince = Math.max(0, last.done - first.done)
  const days = Math.max(0, Math.round((parseDay(last.day) - parseDay(first.day)) / DAY))
  if (doneSince < MIN_DONE) {
    return { kind: 'not-enough', reason: `not enough history (${doneSince} of ${MIN_DONE} tasks done since tracking began)` }
  }
  if (days < 2) return { kind: 'not-enough', reason: 'not enough history (under 2 days)' }

  const overall = doneSince / days
  // The last 7 days, when the history reaches back that far.
  const weekAgo = [...history].reverse().find(s => parseDay(last.day) - parseDay(s.day) >= 7 * DAY)
  const recent = weekAgo ? (last.done - weekAgo.done) / ((parseDay(last.day) - parseDay(weekAgo.day)) / DAY) : overall

  const remaining = last.total - last.done
  const fast = Math.max(overall, recent) * 1.25
  // A stalled week pulls the slow case down, but never below 40% of the overall pace.
  const slow = Math.max(Math.min(overall, recent), overall * 0.4) * 0.7
  const at = (rate: number) => dayOf(now + Math.ceil(remaining / rate) * DAY)

  return {
    kind: 'range',
    optimistic: at(fast),
    median: at(overall),
    slow: at(slow),
    basis: `from ${doneSince} task${doneSince === 1 ? '' : 's'} in ${days} days`,
    added: Math.max(0, last.total - first.total),
  }
}

/** `23 Oct` for a `YYYY-MM-DD` day. */
export function shortDay(day: string): string {
  const d = new Date(parseDay(day))
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`
}
