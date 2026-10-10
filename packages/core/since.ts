// "Since you last looked" (team-view V4): what changed while you were away, as
// news a teammate wants (`T4 done by @bob · Q2 answered by @pm`). A compact
// snapshot of the plan is kept per clone in `<git dir>/agent-skills/seen.json`,
// shared by the plugin and the CLI and never committed; the next look compares
// it with now. Pure: the callers read and write the file.

import { branchOf, type Collision } from './collisions'
import { stateWord } from './branches'
import { dayOf } from './forecast'
import type { PlanDoc, Spec, TaskList } from './parse'
import type { TaskStatusWord } from './format'

/** Where the snapshot lives, relative to the git folder (`git rev-parse --git-dir`). */
export const SEEN_FILE = 'agent-skills/seen.json'

/** The plugin's once-a-session line names this many changes at most, then points at /progress since. */
export const SINCE_MAX = 6

/** What a look remembers: enough to tell what changed, nothing more. */
export type Seen = {
  schema: 1
  /** When it was taken, ms, and that day. */
  at: number
  day: string
  /** By task id: its title (a new plan reuses ids), state, owner, how many handoffs it has and who made the last. */
  tasks: Record<string, { title: string; state: TaskStatusWord; owner: string | null; handoffs: number; from: string | null }>
  /** By spec file: its status and who signed it last. */
  specs: Record<string, { status: Spec['status']; by: string | null }>
  /** Answered questions, by number (`Q2`) or by their text when they have none. */
  answered: Record<string, { by: string | null }>
  /** Each collision, by task and the branches involved, as its news line; null when the branches were not read. */
  collisions: Record<string, string> | null
}

/** One piece of news. `you`: assigned or handed to you. `owner`: assigned to someone, when it can't tell who you are. */
export type SinceChange = { kind: 'you' | 'collision' | 'spec' | 'answered' | 'done' | 'owner'; text: string }

/** A look's result, the shape `--json` prints as `since`: `first` when there was nothing to compare with. */
export type Since = { day: string | null; first: boolean; changes: SinceChange[] }

/** What a snapshot is taken from: the State parts every surface has. */
export type SeenParts = {
  list: TaskList | null
  specs: { file: string; spec: Spec }[]
  plan: PlanDoc | null
  /** Null or absent: the branches were not read, so collisions are not known. */
  collisions?: Collision[] | null
  /** The board across branches, for the branch checked out: news says "also" from its side. */
  branches?: { here: string | null } | null
}

/** A handle as people compare them: `@Sara` and `sara` are one person. */
const handle = (h: string | null | undefined) => (h ? h.replace(/^@/, '').toLowerCase() : null)

const UNDER_WAY = new Set<TaskStatusWord>(['in progress', 'in review'])

/** A collision's news line, from this branch's side: `T2 now also in progress on feat/x by @bob`. */
function collisionNews(c: Collision, here: string | null): string {
  const others = c.on.filter(r => branchOf(r) !== (here ?? 'HEAD'))
  const other = others[0] ?? c.on[0]!
  const more = others.length > 1 ? ` and ${others.length - 1} more` : ''
  if (UNDER_WAY.has(other.state)) return `${c.id} now also ${other.state} on ${other.ref}${other.owner ? ` by ${other.owner}` : ''}${more}`
  return `${c.id} now also assigned to ${other.owner} on ${other.ref}${more}`
}

/** The snapshot of the plan as it stands. */
export function seenOf(p: SeenParts, now: number): Seen {
  const tasks: Seen['tasks'] = {}
  for (const t of p.list?.tasks ?? []) tasks[t.id] = { title: t.title, state: stateWord(t), owner: t.owner ?? null, handoffs: t.handoffs?.length ?? 0, from: t.handoffs?.at(-1)?.from ?? null }
  const specs: Seen['specs'] = {}
  for (const { file, spec } of p.specs) {
    const last = [...(spec.approvals ?? [])].sort((a, b) => a.day.localeCompare(b.day)).at(-1)
    specs[file] = { status: spec.status, by: last?.handle ?? null }
  }
  const answered: Seen['answered'] = {}
  for (const a of p.plan?.answered ?? []) answered[a.q ?? a.question] = { by: a.answer.by }
  const collisions = p.collisions
    ? Object.fromEntries(p.collisions.map(c => [`${c.id} ${[...new Set(c.on.map(branchOf))].sort().join(' ')}`, collisionNews(c, p.branches?.here ?? null)]))
    : null
  return { schema: 1, at: now, day: dayOf(now), tasks, specs, answered, collisions }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** seen.json's snapshot, or null when the file is missing, cut short, or not one: a first look, never a crash. */
export function parseSeen(text: string | null): Seen | null {
  if (text === null) return null
  let x: unknown
  try {
    x = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(x) || x.schema !== 1 || typeof x.at !== 'number' || typeof x.day !== 'string') return null
  if (!isRecord(x.tasks) || !isRecord(x.specs) || !isRecord(x.answered) || !(x.collisions === null || isRecord(x.collisions))) return null
  return x as Seen
}

/** seen.json's text. */
export const seenText = (s: Seen): string => `${JSON.stringify(s, null, 2)}\n`

/** The snapshot to store: now, with the collisions of the last one kept when the branches weren't read this time. */
export const nextSeen = (prev: Seen | null, now: Seen): Seen => (now.collisions === null && prev ? { ...now, collisions: prev.collisions } : now)

/** `SPEC-auth.md` → `SPEC-auth`, `specs/auth.md` → `specs/auth`. */
const specName = (file: string) => file.replace(/\.md$/i, '')

const ORDER: SinceChange['kind'][] = ['you', 'collision', 'spec', 'answered', 'done', 'owner']

/**
 * What changed between two looks, most wanted first: what is now yours, new
 * collisions, specs approved or back to draft, questions answered, tasks done.
 * Each names who did it. What you did yourself is not news, so it is left out
 * when `me` is known. A task id whose title changed is another task (a new
 * plan), so it is not compared.
 */
export function sinceChanges(before: Seen, after: Seen, me: string | null): SinceChange[] {
  const you = handle(me)
  const notMe = (h: string | null) => !you || handle(h) !== you
  const by = (h: string | null) => (h ? ` by ${h}` : '')
  const out: SinceChange[] = []

  for (const [id, t] of Object.entries(after.tasks)) {
    const was = before.tasks[id]
    if (!was || was.title !== t.title) continue
    if (t.state === 'done' && was.state !== 'done' && notMe(t.owner)) out.push({ kind: 'done', text: `${id} done${by(t.owner)}` })
    if (t.owner && handle(t.owner) !== handle(was.owner)) {
      const how = (to: string) => (t.handoffs > was.handoffs ? `${id} handed to ${to}${by(t.from)}` : `${id} assigned to ${to}`)
      // Yours and already under way or done: you took it yourself, so it is not news.
      const yours = !!you && handle(t.owner) === you
      if (yours && (t.state === 'todo' || t.state === 'blocked')) out.push({ kind: 'you', text: how('you') })
      else if (!you) out.push({ kind: 'owner', text: how(t.owner) })
    }
  }
  for (const [key, news] of Object.entries(after.collisions ?? {})) {
    if (before.collisions && !(key in before.collisions)) out.push({ kind: 'collision', text: news })
  }
  for (const [file, s] of Object.entries(after.specs)) {
    const was = before.specs[file]
    if (!was || was.status === s.status) continue
    if (s.status === 'approved' && notMe(s.by)) out.push({ kind: 'spec', text: `${specName(file)} approved${by(s.by)}` })
    if (s.status === 'draft' && was.status === 'approved') out.push({ kind: 'spec', text: `${specName(file)} back to draft` })
  }
  for (const [q, a] of Object.entries(after.answered)) {
    if (q in before.answered || !notMe(a.by)) continue
    const label = /^Q\d+$/.test(q) ? q : `"${q.length > 40 ? `${q.slice(0, 39)}…` : q}"`
    out.push({ kind: 'answered', text: `${label} answered${by(a.by)}` })
  }
  // A stable sort: within a kind, the order the files list them.
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
}

/** A look: what changed since the stored snapshot (null when there is none), and the snapshot to store now. */
export function look(prev: Seen | null, now: Seen, me: string | null): { since: Since; next: Seen } {
  const since: Since = prev ? { day: prev.day, first: false, changes: sinceChanges(prev, now, me) } : { day: null, first: true, changes: [] }
  return { since, next: nextSeen(prev, now) }
}

/**
 * Two looks as one, the earlier first: what the session's first look found,
 * plus what changed since. A change in both is listed once, in its kind's place.
 */
export function mergeSince(a: Since, b: Since): Since {
  if (a.first) return b
  if (b.first) return a
  const texts = new Set(a.changes.map(c => c.text))
  const changes = [...a.changes, ...b.changes.filter(c => !texts.has(c.text))].sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind))
  return { day: a.day, first: false, changes }
}

/**
 * The plugin's once-a-session line: one line, at most `max` changes, then
 * `and N more · /progress since`. Null when nothing changed or on a first look,
 * which only stores the snapshot.
 */
export function sinceLine(s: Since, max = SINCE_MAX): string | null {
  if (s.first || s.changes.length === 0) return null
  const shown = s.changes.slice(0, max).map(c => c.text)
  const rest = s.changes.length - shown.length
  return `Since you last looked (${s.day}): ${shown.join(' · ')}${rest > 0 ? ` · and ${rest} more · /progress since` : ''}`
}

/** The full list, as `/progress since` and `--since` print it. */
export function sinceText(s: Since): string {
  if (s.first) return 'First look here: nothing to compare with yet. What the plan says now is stored, and /progress since lists what changes from here on.'
  if (s.changes.length === 0) return `Nothing changed since you last looked (${s.day}).`
  const n = s.changes.length
  return [`Since you last looked (${s.day}), ${n} change${n === 1 ? '' : 's'}:`, ...s.changes.map(c => `- ${c.text}`)].join('\n')
}
