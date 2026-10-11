// The retro (ceremonies C6): where the time went, as bottlenecks in the work.
// Tasks slow against their size, the longest blocks, scope added and how the
// ETA drifted, over a sprint or, without one, the whole plan. Rows are keyed by
// task: no owner, and no count, rate or speed per person, anywhere. Pure:
// copies of tasks/todo.md, archived plans and snapshots are handed in.

import { etaDrift, forecastHistory, shortDay, type Snapshot } from './forecast'
import type { Sprint, TaskSize } from './format'
import { readCopiesSince, type Runner } from './history'
import { parseTasks, type Task, type TaskList } from './parse'
import { pickSprint, sprintBase, versionsOf, type TodoVersion } from './sprint'

/** Done tasks of a size needed before one is called slow against them. */
export const MIN_OF_SIZE = 3

export type RetroInput = {
  list: TaskList
  /** tasks/todo.md's committed copies (since the sprint began, or all). */
  versions: TodoVersion[]
  /** Archived plans' task lists (tasks/archive/<plan>/todo.md): more done tasks to know a size's usual time by. */
  archived: TaskList[]
  snapshots: Snapshot[]
  /** The sprint looked back on; null for the whole plan. */
  sprint: Sprint | null
  today: string
}

/** A size's group: S, M or L, or `none` for a task without a Size line. */
type SizeKey = TaskSize | 'none'

export type Retro = {
  sprint: Sprint | null
  /** Done in the window and over twice the median days for their size, slowest first against it. */
  slow: { id: string; title: string; size: SizeKey; days: number; usual: number }[]
  /** Sizes done in the window with too few done tasks to know their usual time. */
  cantCompare: { size: SizeKey; done: number }[]
  /** Blocks of a day or more in the window, longest first. */
  blocks: { id: string; title: string; days: number; from: string; to: string }[]
  /** With a sprint: tasks added after it began. */
  added: { id: string; title: string }[]
  /** Without one: how far the plan grew since its first day. */
  grew: { tasks: number; since: string } | null
  /** The median ETA's move across the window (later is positive); null without two forecasts. */
  drift: { days: number; from: string; to: string } | null
}

const DAY_MS = 86_400_000
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)
const sizeOf = (t: Task): SizeKey => t.size ?? 'none'
/** Days from started to done, a day at least; null without both dates. */
const took = (t: Task) => (t.status === 'done' && t.state?.started && t.state.done ? Math.max(1, daysBetween(t.state.started, t.state.done)) : null)

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** `/progress retro` (C6): the retro of `sprint`, or of the whole plan without one. Pure. */
export function retro(input: RetroInput): Retro {
  const { list, sprint, today } = input
  const from = sprint?.start ?? '0000-00-00'
  const to = sprint ? (sprint.end < today ? sprint.end : today) : today
  const inWindow = (day: string) => day >= from && day <= to

  // Slow against size: the usual days for each size, over this plan and the archived ones.
  const pool = new Map<SizeKey, number[]>()
  for (const t of [...list.tasks, ...input.archived.flatMap(l => l.tasks)]) {
    const d = took(t)
    if (d !== null) pool.set(sizeOf(t), [...(pool.get(sizeOf(t)) ?? []), d])
  }
  const doneHere = list.tasks.filter(t => took(t) !== null && inWindow(t.state!.done!))
  const slow: Retro['slow'] = []
  const cantCompare = new Map<SizeKey, number>()
  for (const t of doneHere) {
    const days = pool.get(sizeOf(t)) ?? []
    if (days.length < MIN_OF_SIZE) {
      cantCompare.set(sizeOf(t), days.length)
      continue
    }
    const usual = median(days)
    if (took(t)! > 2 * usual) slow.push({ id: t.id, title: t.title, size: sizeOf(t), days: took(t)!, usual })
  }
  slow.sort((a, b) => b.days / b.usual - a.days / a.usual)

  // Blocks: the first and last copy in the window showing each task blocked; the plan now counts as today's copy.
  const copies = [...input.versions, { day: today, list }].filter(v => inWindow(v.day)).sort((a, b) => a.day.localeCompare(b.day))
  const spans = new Map<string, { from: string; to: string }>()
  for (const v of copies)
    for (const t of v.list.tasks)
      if (t.state?.status === 'blocked') spans.set(t.id, { from: spans.get(t.id)?.from ?? v.day, to: v.day })
  const title = (id: string) => list.tasks.find(t => t.id === id)?.title ?? ''
  const blocks = [...spans]
    .map(([id, s]) => ({ id, title: title(id), days: daysBetween(s.from, s.to), ...s }))
    .filter(b => b.days >= 1)
    .sort((a, b) => b.days - a.days)

  // Scope: tasks added after the sprint began, or the plan's growth since its first day.
  let added: Retro['added'] = []
  let grew: Retro['grew'] = null
  if (sprint) {
    const base = sprintBase(input.versions, sprint)
    const before = new Set((base?.list ?? list).tasks.map(t => t.id))
    added = list.tasks.filter(t => /^T\d+$/.test(t.id) && !sprint.commit.includes(t.id) && !before.has(t.id)).map(t => ({ id: t.id, title: t.title }))
  } else if (input.snapshots.length) {
    const first = input.snapshots[0]!
    grew = { tasks: Math.max(0, input.snapshots.at(-1)!.total - first.total), since: first.day }
  }

  // ETA drift: the median ETA of the first forecast in the window against the last's.
  const ranges = forecastHistory(input.snapshots.filter(s => s.day <= to)).filter(p => inWindow(p.day) && p.forecast.kind === 'range')
  const ends = ranges.length >= 2 ? [ranges[0]!, ranges.at(-1)!] : []
  const moved = etaDrift(ends)
  const etaOf = (p: (typeof ranges)[number]) => (p.forecast.kind === 'range' ? p.forecast.median : '')
  const drift = moved ? { days: moved.days, from: etaOf(ends[0]!), to: etaOf(ends[1]!) } : null

  return { sprint, slow, cantCompare: [...cantCompare].map(([size, done]) => ({ size, done })), blocks, added, grew, drift }
}

/** `1½`: days to the half. */
const half = (n: number) => {
  const whole = Math.floor(n)
  return n - whole >= 0.5 ? `${whole || ''}½` : `${whole}`
}
const sizeName = (s: SizeKey) => (s === 'none' ? 'unsized' : s)

/** What `/progress retro` and `--retro` print. Pure. */
export function retroText(r: Retro): string {
  const lines = [`Retro · ${r.sprint ? `sprint ${shortDay(r.sprint.start)} – ${shortDay(r.sprint.end)}` : 'the whole plan (no sprint)'}`]
  const slow = [
    ...r.slow.map(s => `  ${s.id} ${s.title} (${sizeName(s.size)}) took ${s.days}d, the usual ${sizeName(s.size)} is ${half(s.usual)}d`),
    ...r.cantCompare.map(c => `  Not compared: ${sizeName(c.size)} (${c.done} done; ${MIN_OF_SIZE} needed)`),
  ]
  lines.push(slow.length ? 'Slow against their size' : 'Slow against their size: none over twice the usual', ...slow)
  if (r.blocks.length) lines.push('Longest blocks', ...r.blocks.map(b => `  ${b.id} ${b.title} blocked ${b.days}d (${shortDay(b.from)} – ${shortDay(b.to)})`))
  else lines.push('Longest blocks: none')
  if (r.sprint) lines.push(r.added.length ? `Scope: +${r.added.length} added after the start: ${r.added.map(a => `${a.id} ${a.title}`).join(', ')}` : 'Scope: nothing added after the start')
  else lines.push(r.grew?.tasks ? `Scope: +${r.grew.tasks} task${r.grew.tasks === 1 ? '' : 's'} since ${shortDay(r.grew.since)}` : 'Scope: the plan has not grown')
  const over = r.sprint ? 'over the sprint' : 'over the plan'
  if (!r.drift) lines.push('ETA: not enough history for a forecast to drift')
  else if (r.drift.days === 0) lines.push(`ETA: held ${over} (${shortDay(r.drift.to)})`)
  else lines.push(`ETA: ${r.drift.days > 0 ? 'slipped' : 'moved earlier by'} ${Math.abs(r.drift.days)}d ${over} (${shortDay(r.drift.from)} → ${shortDay(r.drift.to)})`)
  return lines.join('\n')
}

/**
 * What `/progress retro` and `--retro` read, through the caller's I/O: every
 * committed copy of tasks/todo.md (`cache` keeps those read before), the
 * running or last ended sprint among them, and the archived plans. Reads only.
 */
export async function gatherRetro(
  io: { read: (rel: string) => Promise<string | null>; dirs?: (rel: string) => Promise<string[]>; run?: Runner },
  list: TaskList,
  snapshots: Snapshot[],
  today: string,
  cache?: Map<string, string | null>,
): Promise<RetroInput> {
  const versions = io.run ? versionsOf(await readCopiesSince(io.run, 'tasks/todo.md', { cache })) : []
  const archived: TaskList[] = []
  for (const dir of ((await io.dirs?.('tasks/archive')) ?? []).sort()) {
    const text = await io.read(`tasks/archive/${dir}/todo.md`)
    if (text !== null) archived.push(parseTasks(text))
  }
  return { list, versions, archived, snapshots, sprint: pickSprint(versions, list, null, today), today }
}
