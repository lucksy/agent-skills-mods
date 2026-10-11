// The board across branches (team-view V1): tasks/todo.md as every other local
// branch and every fetched remote-tracking ref has it, read from git objects
// already on the machine. One `git for-each-ref` lists the refs, one
// `git cat-file --batch` reads every copy, the same pattern history.ts uses.
// Nothing here fetches, checks out or stashes. Pure: the runner is handed in.

import { CAT_ARGV, splitBatch, type Runner } from './history'
import { parseTasks, type Task, type TaskList } from './parse'
import type { TaskStatusWord } from './format'

/** Refs read at most (Q2): the newest first, so a long-lived repo stays one quick read. */
export const MAX_REFS = 25
/** Remote-tracking refs older than this are someone's old work, not the team's (Q2). */
export const WINDOW_DAYS = 30

/** Every branch and remote-tracking ref, newest commit first: `<ref>\t<sha>\t<unix seconds>`. */
export const REFS_ARGV = ['git', 'for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', 'refs/heads', 'refs/remotes']
/** The current commit and branch name, one per line (`HEAD` when detached). */
export const HEAD_ARGV = ['git', 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']
/** The git folder, where FETCH_HEAD's age says when this clone last fetched. */
export const GIT_DIR_ARGV = ['git', 'rev-parse', '--git-dir']

export type Ref = {
  /** `refs/heads/feat/x` or `refs/remotes/origin/feat/x`. */
  ref: string
  /** As people write it: `feat/x`, `origin/feat/x`. */
  name: string
  sha: string
  /** Its newest commit's time. */
  ms: number
  remote: boolean
}

export function parseRefs(out: string): Ref[] {
  return out
    .split('\n')
    .map(line => /^(refs\/(heads|remotes)\/(\S+))\t([0-9a-f]{7,64})\t(\d+)$/.exec(line.trim()))
    .filter(m => m !== null)
    .map(m => ({ ref: m[1]!, name: m[3]!, sha: m[4]!, ms: Number(m[5]) * 1000, remote: m[2] === 'remotes' }))
}

/**
 * The refs that count as the team (Q2): local branches, then remote-tracking
 * refs with a commit in the last WINDOW_DAYS days, up to MAX_REFS. A ref at the
 * current commit, a remote's HEAD and a second ref at a commit already chosen
 * add nothing, so they are skipped.
 */
export function pickRefs(refs: Ref[], headSha: string | null, now: number): Ref[] {
  const since = now - WINDOW_DAYS * 86_400_000
  const shas = new Set(headSha ? [headSha] : [])
  const out: Ref[] = []
  const ordered = [...refs.filter(r => !r.remote), ...refs.filter(r => r.remote && r.ms >= since)]
  for (const r of ordered) {
    if (out.length >= MAX_REFS) break
    if (r.remote && /\/HEAD$/.test(r.name)) continue
    if (shas.has(r.sha)) continue
    shas.add(r.sha)
    out.push(r)
  }
  return out
}

/** Each state's rank: the board shows the furthest one a task reached on any ref. */
const RANK: Record<TaskStatusWord, number> = { done: 4, 'in review': 3, 'in progress': 2, blocked: 1, todo: 0 }

/** What a task's Status line says, or done when all its boxes are ticked. */
export const stateWord = (t: Task): TaskStatusWord => t.state?.status ?? (t.status === 'done' ? 'done' : 'todo')

/**
 * A task as one ref has it: its state and owner, the days its Status line says
 * it started and was done (ceremonies C3: the team standup), and the ref's
 * newest commit time (null for the working tree).
 */
export type RefState = { ref: string; remote: boolean; state: TaskStatusWord; owner: string | null; started: string | null; done?: string | null; at: number | null; pr: string | null; reviewer: string | null }

/** One task across the refs: its furthest state and where, plus every ref's own (for collisions, T4). */
export type BranchRow = {
  id: string
  title: string
  state: TaskStatusWord
  /** The ref with the furthest state; null while it is todo everywhere. */
  ref: string | null
  remote: boolean
  owner: string | null
  on: RefState[]
}

/** The board across branches, the shape `--json` prints as `branches`. */
export type BranchBoard = {
  /** The branch checked out, read from the working tree; null outside a branch. */
  here: string | null
  /** Each ref read, whether it had the task list, and the plan it names when that isn't this one (its tasks are left out). */
  refs: { name: string; remote: boolean; sha: string; hasFile: boolean; plan?: string }[]
  /** When this clone last fetched (FETCH_HEAD's time), ms; null when it never has. */
  fetchedAt: number | null
  rows: BranchRow[]
}

/**
 * The rows: one per task id, in the order the lists first name them (this
 * branch's first). The furthest state wins; on a tie, the ref read first.
 */
export function branchRows(
  here: { name: string | null; list: TaskList | null },
  copies: { ref: Ref; text: string | null }[],
  fetchedAt: number | null,
): BranchBoard {
  const lists: { name: string; remote: boolean; at: number | null; list: TaskList }[] = []
  if (here.list) lists.push({ name: here.name ?? 'HEAD', remote: false, at: null, list: here.list })
  // A branch whose list names another plan is other work under the same task ids: left out, and named.
  const ours = here.list?.meta?.plan
  const otherPlan = new Map<string, string>()
  for (const c of copies) {
    if (c.text === null) continue
    const list = parseTasks(c.text)
    const theirs = list.meta?.plan
    if (ours && theirs && theirs !== ours) otherPlan.set(c.ref.name, theirs)
    else lists.push({ name: c.ref.name, remote: c.ref.remote, at: c.ref.ms, list })
  }
  // Without plan names to go by, a task counts only under the title this branch gives it.
  const titles = new Map((here.list?.tasks ?? []).map(t => [t.id, t.title]))
  const rows = new Map<string, BranchRow>()
  for (const { name, remote, at, list } of lists) {
    for (const t of list.tasks) {
      if (!/^T\d+$/.test(t.id)) continue
      if (!(ours && list.meta?.plan) && titles.has(t.id) && titles.get(t.id) !== t.title) continue
      const on: RefState = { ref: name, remote, state: stateWord(t), owner: t.owner ?? null, started: t.state?.started ?? null, done: t.state?.done ?? null, at, pr: t.pr ?? null, reviewer: t.reviewer ?? null }
      const row = rows.get(t.id)
      if (!row) {
        const started = on.state !== 'todo'
        rows.set(t.id, { id: t.id, title: t.title, state: on.state, ref: started ? name : null, remote: started && remote, owner: on.owner, on: [on] })
        continue
      }
      row.on.push(on)
      if (RANK[on.state] > RANK[row.state]) Object.assign(row, { state: on.state, ref: name, remote, owner: on.owner ?? row.owner })
    }
  }
  return {
    here: here.name,
    refs: copies.map(c => {
      const plan = otherPlan.get(c.ref.name)
      return { name: c.ref.name, remote: c.ref.remote, sha: c.ref.sha, hasFile: c.text !== null, ...(plan ? { plan } : {}) }
    }),
    fetchedAt,
    rows: [...rows.values()],
  }
}

/** `today`, `2d ago`, `5h ago`: how old a fetch is. */
export function fetchAge(fetchedAt: number | null, now: number): string {
  if (fetchedAt === null) return 'never fetched'
  const mins = Math.max(0, Math.floor((now - fetchedAt) / 60_000))
  if (mins < 60) return `fetched ${mins}m ago`
  if (mins < 60 * 24) return `fetched ${Math.floor(mins / 60)}h ago`
  return `fetched ${Math.floor(mins / 1440)}d ago`
}

const GLYPH: Record<TaskStatusWord, string> = { done: '✓', 'in review': '◐', 'in progress': '●', blocked: '■', todo: '○' }

/** What `/progress branches` and `--branches` print. */
export function branchesText(b: BranchBoard, now: number, file = 'tasks/todo.md'): string {
  const read = b.refs.filter(r => r.hasFile && !r.plan)
  const age = fetchAge(b.fetchedAt, now)
  const head = `Board across branches · ${b.here ?? 'HEAD'} + ${read.length} ref${read.length === 1 ? '' : 's'} · ${age}`
  if (b.rows.length === 0) return `${head}\nNo tasks in ${file} on any branch.`
  const out = [head]
  for (const r of b.rows) {
    const where = r.ref === null ? '' : ` on ${r.ref}${r.owner ? ` ${r.owner}` : ''}${r.remote ? ` (${age})` : ''}`
    out.push(`${GLYPH[r.state]} ${r.id} ${r.title} · ${r.state}${where}`)
  }
  const without = b.refs.filter(r => !r.hasFile).map(r => r.name)
  if (without.length) out.push(`No ${file} on: ${without.join(', ')}.`)
  const other = b.refs.filter(r => r.plan).map(r => `${r.name} (${r.plan})`)
  if (other.length) out.push(`Another plan on: ${other.join(', ')}.`)
  return out.join('\n')
}

/**
 * The board across branches, read through `run`: the refs (one call), the
 * current commit (one call) and every copy not in `cache` (one cat-file). Only
 * `for-each-ref`, `rev-parse` and `cat-file` run, so nothing touches the network.
 * `cache` maps a commit to its copy: an unchanged ref is not read twice. Null
 * outside a git repository.
 */
export async function readBranches(
  run: Runner,
  opts: { file: string; now: number; here: TaskList | null; fetchedAt: number | null; cache?: Map<string, string | null> },
): Promise<BranchBoard | null> {
  const listed = await run(REFS_ARGV).catch(() => null)
  if (!listed || listed.exitCode !== 0) return null
  const head = await run(HEAD_ARGV).catch(() => null)
  const [sha = null, branch = null] = head && head.exitCode === 0 ? head.stdout.trim().split('\n').map(s => s.trim()) : []
  const refs = pickRefs(parseRefs(listed.stdout), sha, opts.now)
  const cache = opts.cache ?? new Map<string, string | null>()
  const wanted = refs.filter(r => !cache.has(r.sha))
  if (wanted.length) {
    const cat = await run(CAT_ARGV, { stdin: wanted.map(r => `${r.sha}:./${opts.file}\n`).join('') }).catch(() => null)
    if (cat && cat.exitCode === 0) {
      const texts = splitBatch(cat.stdout)
      // A cut read ends in a partial copy; the refs after it are read next time.
      if (cat.isStdoutTruncated) texts.pop()
      texts.slice(0, wanted.length).forEach((t, i) => cache.set(wanted[i]!.sha, t))
    }
  }
  const copies = refs.filter(r => cache.has(r.sha)).map(ref => ({ ref, text: cache.get(ref.sha) ?? null }))
  return branchRows({ name: branch && branch !== 'HEAD' ? branch : null, list: opts.here }, copies, opts.fetchedAt)
}
