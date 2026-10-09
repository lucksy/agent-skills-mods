// History from git (F5): the task list as it was committed, one snapshot per
// day, so a mod installed mid-project has a pace to forecast from on day one.

import { dayOf, snapshotOf, type Snapshot } from './forecast'
import { parseTasks, taskKey, type TaskList } from './parse'

/** Newest commits read; a long project keeps its recent pace, which is what the forecast weighs. */
export const MAX_COMMITS = 200

/** Where the history came from, stored once per project and shown under the forecast. */
export type Backfill =
  | { source: 'git'; days: number; since: string }
  | { source: 'none'; reason: string; since: string }

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
