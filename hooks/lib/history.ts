// History for a plan the mod did not watch from the start (F5): the task list
// as it was committed, the commit messages that name its tasks, and (when the
// person allows it) Claude Code's session logs. A mod installed mid-project
// has a pace to forecast from on day one.

import { dayOf, snapshotOf, type Snapshot } from './forecast'
import { parseTasks, taskKey, type TaskList } from './parse'

/** Newest commits read; a long project keeps its recent pace, which is what the forecast weighs. */
export const MAX_COMMITS = 200

/** Each source's days, kept apart so a source can be turned off again. */
export type SourceData = { snaps: Snapshot[]; doneDays: Record<string, string> }

/**
 * Session logs: the question is waiting, allowed, declined, nothing in them to
 * read, or not asked because git gave enough history.
 */
export type LogsChoice = 'ask' | 'yes' | 'no' | 'empty' | 'unasked'

/** Where the history came from, worked out once per project and shown under the forecast. */
export type Backfill = {
  /** The first day of the combined history. */
  since: string
  /** Days each source added that no better source had. */
  days: { git: number; messages: number; logs: number; seen: number }
  logs: LogsChoice
  /** Why git gave nothing, when it did not. */
  gitNote: string | null
}

export const emptySource = (): SourceData => ({ snaps: [], doneDays: {} })

export type Commit = { hash: string; ms: number }

/** Commits that touched `file`, newest first, as `<hash> <unix seconds>`. */
export const logArgv = (file: string) => ['git', 'log', `--max-count=${MAX_COMMITS}`, '--format=%H %ct', '--', file]

/** One `git cat-file --batch` call answers every commit's copy of the file. */
export const CAT_ARGV = ['git', 'cat-file', '--batch=@@asm %(objecttype)']
// `./` makes the path relative to the working directory, not the repository root.
export const catInput = (commits: Commit[], file: string) => commits.map(c => `${c.hash}:./${file}\n`).join('')

export function parseLog(out: string): Commit[] {
  return out
    .split('\n')
    .map(line => /^([0-9a-f]{7,64}) (\d+)$/.exec(line.trim()))
    .filter(m => m !== null)
    .map(m => ({ hash: m[1]!, ms: Number(m[2]) * 1000 }))
}

/** One text per input line, in order; null where the commit has no such file. */
export function splitBatch(out: string): (string | null)[] {
  const texts: (string | null)[] = []
  let open = false
  // Git ends each blob with one newline of its own.
  for (const line of out.replace(/\n$/, '').split('\n')) {
    if (line === '@@asm blob') {
      texts.push('')
      open = true
    } else if (/^\S+ missing$/.test(line) || /^@@asm \w+$/.test(line)) {
      texts.push(null)
      open = false
    } else if (open) {
      texts[texts.length - 1] += `${line}\n`
    }
  }
  return texts.map(t => (t === null ? t : t.replace(/\n$/, '')))
}

/**
 * The committed copies of the current plan, newest first, each with its day.
 * Walking back stops where the file did not exist or held another plan: most
 * of its tasks missing from the current list.
 */
function samePlan(commits: Commit[], texts: (string | null)[], current: TaskList): { day: string; list: TaskList }[] {
  const known = new Set(current.tasks.map(taskKey))
  const out: { day: string; list: TaskList }[] = []
  for (const [i, commit] of commits.entries()) {
    const text = texts[i]
    if (text === null || text === undefined) break
    const list = parseTasks(text)
    if (list.total === 0) break
    const shared = list.tasks.filter(t => known.has(taskKey(t))).length
    if (shared * 2 < list.tasks.length) break
    out.push({ day: dayOf(commit.ms), list })
  }
  return out
}

/** A daily snapshot from each day's last commit, oldest first. */
export function snapshotsFromGit(commits: Commit[], texts: (string | null)[], current: TaskList): Snapshot[] {
  const byDay = new Map<string, Snapshot>()
  for (const { day, list } of samePlan(commits, texts, current)) if (!byDay.has(day)) byDay.set(day, snapshotOf(day, list))
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/** The day each task was first committed as done (F1's date column), by task key. */
export function doneDaysFromGit(commits: Commit[], texts: (string | null)[], current: TaskList): Record<string, string> {
  const days: Record<string, string> = {}
  // Newest first, so the oldest commit that shows a task done writes last.
  for (const { day, list } of samePlan(commits, texts, current)) {
    for (const t of list.tasks) if (t.status === 'done') days[taskKey(t)] = day
  }
  return days
}

/** What the mod saw itself wins over git: it includes edits never committed. */
export function mergeHistory(stored: Snapshot[], fromGit: Snapshot[]): Snapshot[] {
  const seen = new Set(stored.map(s => s.day))
  return [...stored, ...fromGit.filter(s => !seen.has(s.day))].sort((a, b) => a.day.localeCompare(b.day)).slice(-365)
}

// ------------------------------------------------------------ commit messages

/** Every commit's time and message, newest first, records split by \x1e and fields by \x1f. */
export const messagesArgv = ['git', 'log', '--max-count=1000', '--format=%x1e%ct%x1f%B']

/** `T3`, `Task 3`, `task #3` in a commit message. */
const TASK_REF = /\b(?:T(\d+)|[Tt]ask\s*#?(\d+))\b/g

export function parseMessages(out: string): { ms: number; ids: string[] }[] {
  return out
    .split('\x1e')
    .map(rec => {
      const [time, body = ''] = rec.split('\x1f')
      const ms = Number(time?.trim()) * 1000
      const ids = [...body.matchAll(TASK_REF)].map(m => `T${m[1] ?? m[2]}`)
      return { ms, ids: [...new Set(ids)] }
    })
    .filter(c => Number.isFinite(c.ms) && c.ms > 0 && c.ids.length > 0)
}

/**
 * The day each done task was first named in a commit message: agent-skills
 * commits once a task's checks pass, so the first mention marks it done.
 * Commits older than `notBefore` (the plan's first commit) belong to an
 * earlier plan that may have reused the same numbers.
 */
export function doneDaysFromMessages(
  commits: { ms: number; ids: string[] }[],
  current: TaskList,
  notBefore: number | null,
): Record<string, string> {
  const done = new Map(current.tasks.filter(t => t.status === 'done').map(t => [t.id, taskKey(t)]))
  const days: Record<string, string> = {}
  for (const c of commits) {
    if (notBefore !== null && c.ms < notBefore) continue
    for (const id of c.ids) {
      const key = done.get(id)
      const day = dayOf(c.ms)
      if (key && (!days[key] || day < days[key]!)) days[key] = day
    }
  }
  return days
}

/** Snapshots implied by done days alone: done grows on each day, scope is today's. */
export function snapshotsFromDoneDays(doneDays: Record<string, string>, current: TaskList): Snapshot[] {
  const days = [...new Set(Object.values(doneDays))].sort()
  return days.map(day => ({ day, done: Object.values(doneDays).filter(d => d <= day).length, total: current.total }))
}

// ------------------------------------------------------------ combining

/**
 * One history from the sources, best first. A source that saw the file
 * (the mod itself, committed copies, session logs) adds the days the ones
 * before it lack. Days implied by commit messages fill the gaps last, held
 * between the days around them that saw the file: they know nothing of scope
 * or of work under way, so they take scope from the day before.
 */
export function combine(seen: Snapshot[], files: SourceData[], messages: SourceData) {
  const byDay = new Map<string, Snapshot>()
  const added = [seen, ...files.map(f => f.snaps)].map(snaps => {
    let n = 0
    for (const s of snaps) if (!byDay.has(s.day)) byDay.set(s.day, s), n++
    return n
  })
  const real = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
  let fromMessages = 0
  for (const s of messages.snaps) {
    if (byDay.has(s.day)) continue
    const before = real.filter(r => r.day < s.day).at(-1)
    const after = real.find(r => r.day > s.day)
    const done = Math.min(Math.max(s.done, before?.done ?? 0), after?.done ?? Infinity)
    byDay.set(s.day, { day: s.day, done, total: before?.total ?? after?.total ?? s.total })
    fromMessages++
  }
  const snaps = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-365)
  return { snaps, added: { seen: added[0]!, files: added.slice(1), messages: fromMessages } }
}

/** Each task's done day: the earliest any source saw it done. */
export function earliestDays(...sources: Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const days of sources) for (const [k, d] of Object.entries(days)) if (!out[k] || d < out[k]!) out[k] = d
  return out
}
