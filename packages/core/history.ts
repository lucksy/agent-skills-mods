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

/** `git cat-file --batch` answers each commit's copy of the file; one call per group that fits under the output limit. */
export const CAT_ARGV = ['git', 'cat-file', '--batch=@@asm %(objecttype)']
/** The size of each copy first, so the copies can be read in groups under the output limit. */
export const CHECK_ARGV = ['git', 'cat-file', '--batch-check=@@asm %(objectsize)']
/**
 * Bytes one read may return: Claude Code keeps 4 MiB of a command's output and
 * drops the rest, so a long task list read in one call lost all but its newest copies.
 */
export const READ_LIMIT = 3_500_000
// `./` makes the path relative to the working directory, not the repository root.
export const catInput = (commits: Commit[], file: string) => commits.map(c => `${c.hash}:./${file}\n`).join('')

export function parseLog(out: string): Commit[] {
  return out
    .split('\n')
    .map(line => /^([0-9a-f]{7,64}) (\d+)$/.exec(line.trim()))
    .filter(m => m !== null)
    .map(m => ({ hash: m[1]!, ms: Number(m[2]) * 1000 }))
}

/** The newest commit of each day: a day's snapshot and its done tasks come from its last copy. */
export function lastPerDay(commits: Commit[]): Commit[] {
  const days = new Set<string>()
  return commits.filter(c => {
    const day = dayOf(c.ms)
    if (days.has(day)) return false
    days.add(day)
    return true
  })
}

/** One size per input line, in order; null where the commit has no such file. */
export function parseSizes(out: string): (number | null)[] {
  return out
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const m = /^@@asm (\d+)$/.exec(line.trim())
      return m ? Number(m[1]) : null
    })
}

/**
 * The commits in groups whose copies fit in one read, newest first. The groups
 * end at the first commit without the file, or with a copy too big for a read
 * of its own: the walk back stops there anyway.
 */
export function readGroups(commits: Commit[], sizes: (number | null)[], limit = READ_LIMIT): Commit[][] {
  const groups: Commit[][] = []
  let group: Commit[] = []
  let bytes = 0
  for (const [i, commit] of commits.entries()) {
    const size = sizes[i]
    if (size === null || size === undefined) break
    // The header line and the newline git adds after each copy.
    const cost = size + 64
    if (cost > limit) break
    if (bytes + cost > limit && group.length > 0) {
      groups.push(group)
      group = []
      bytes = 0
    }
    group.push(commit)
    bytes += cost
  }
  if (group.length > 0) groups.push(group)
  return groups
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

// ------------------------------------------------------------ reading git

/** Runs one command in the project folder: the mod's `$.process.run`, or Node's in the script (E2). */
export type Runner = (
  argv: string[],
  opts?: { stdin?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }>

/** What git gave for a task list: its committed copies, the commit messages naming its tasks, or why nothing. */
export type GitSources = { git: SourceData; messages: SourceData; gitNote: string | null }

/**
 * Each commit's copy of the file, newest first, read in groups under the output
 * limit. Shorter than `commits` where reading stopped: the walk back ends there.
 */
async function readCopies(run: Runner, commits: Commit[], file: string): Promise<(string | null)[]> {
  const check = await run(CHECK_ARGV, { stdin: catInput(commits, file) })
  if (check.exitCode !== 0) return []
  const sizes = parseSizes(check.stdout)
  const texts: (string | null)[] = []
  for (const group of readGroups(commits, sizes)) {
    const cat = await run(CAT_ARGV, { stdin: catInput(group, file) })
    if (cat.exitCode !== 0) break
    const got = splitBatch(cat.stdout)
    // A cut read ends in a partial copy, which would count as a smaller plan.
    if (cat.isStdoutTruncated) got.pop()
    texts.push(...got.slice(0, group.length))
    if (cat.isStdoutTruncated || got.length < group.length) break
  }
  // A commit without the file ends the walk, as it did in a single read.
  if (texts.length < commits.length && sizes[texts.length] === null) texts.push(null)
  return texts
}

/**
 * Git's two sources, once per project: the committed copies of the task list,
 * one a day (their sizes, then as many reads as keep each under the output
 * limit), and the commit messages that name its tasks (one more call).
 */
export async function gitSources(run: Runner, file: string, list: TaskList): Promise<GitSources> {
  const none = (gitNote: string) => ({ git: emptySource(), messages: emptySource(), gitNote })
  try {
    const log = await run(logArgv(file))
    if (log.exitCode !== 0) return none(/does not have any commits/.test(log.stderr) ? 'no commits yet' : 'not a git repository')
    const commits = lastPerDay(parseLog(log.stdout))
    let git = emptySource()
    if (commits.length > 0) {
      const texts = await readCopies(run, commits, file)
      git = { snaps: snapshotsFromGit(commits, texts, list), doneDays: doneDaysFromGit(commits, texts, list) }
    }
    // Messages from before the plan's first commit may name another plan's tasks.
    const planStart = git.snaps[0] ? Date.parse(`${git.snaps[0].day}T00:00:00Z`) : null
    const msgs = await run(messagesArgv)
    const doneDays = msgs.exitCode === 0 ? doneDaysFromMessages(parseMessages(msgs.stdout), list, planStart) : {}
    const messages = { snaps: snapshotsFromDoneDays(doneDays, list), doneDays }
    const gitNote = git.snaps.length || messages.snaps.length ? null : commits.length ? `no commit of ${file} holds this plan` : `${file} has no commits`
    return { git, messages, gitNote }
  } catch {
    return none('git is not available')
  }
}
