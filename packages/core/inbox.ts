// The decisions inbox (ceremonies C7): everything waiting on a person, by their
// handle and roles. Checkpoints due to sign off, open questions, specs to sign
// across SPEC*.md, reviews they are the reviewer of, and handoffs to them. The
// Overview's "needs you" and the Team tab's "waiting on someone" read it too, so
// the three can't disagree. Pure.

import { approvalStatus } from './approvals'
import { branchOf } from './collisions'
import type { Task } from './parse'
import type { State } from './state'
import { TEAM_FILE } from './team'
import { shortItem } from './timeline'
import { specApproval } from './view'

export type InboxKind = 'checkpoint' | 'question' | 'approval' | 'review' | 'handoff'

export type InboxItem = {
  kind: InboxKind
  /** As the Overview and the digest word it: `checkpoint 1, after T2: …`, the question, `approve SPEC.md`, the task's id and title. */
  text: string
  /** The handles it waits on; empty when anyone can take it (a question naming nobody, a checkpoint, a spec with no roles to sign). */
  who: string[]
  /** The tasks it holds up. */
  tasks: string[]
  /** Days it has waited, when the files say: since the checkpoint's task was done, the spec was written, the task started, the handoff. */
  age: number | null
  /** A question's number (`Q2`) and file; a spec's file and the roles still to sign it, with who holds each. */
  q?: string | null
  file?: string
  roles?: { role: string; who: string[] }[]
  /** A review's or handoff's task, its PR, the branch it is on (null: this one), its owner, and who handed it over with the note. */
  id?: string
  pr?: string | null
  ref?: string | null
  owner?: string | null
  from?: string | null
  note?: string
}

const DAY = 86_400_000
const daysSince = (day: string | null | undefined, today: string) => (day ? Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY)) : null)
const key = (handle: string | null | undefined) => (handle ?? '').replace(/^@/, '').toLowerCase()

/** Handles named in a text: `@pm`, not the `@` of an email address. */
const named = (text: string) => [...new Set([...text.matchAll(/(?:^|[\s(,])(@[\w-]+(?:\.[\w-]+)*)/g)].map(m => m[1]!.replace(/\.+$/, '')))]

/**
 * Everything waiting on someone, in the Overview's order: checkpoints due, the
 * plan's open questions, specs awaiting approval, the spec's open questions,
 * then reviews and handoffs. Each item names who it waits on.
 */
export function inboxItems(s: State): InboxItem[] {
  const tasks = s.list?.tasks ?? []
  const team = s.team ?? null
  const asTeam = (h: string) => team?.members.find(m => key(m.handle) === key(h))?.handle ?? h
  const out: InboxItem[] = []

  // Checkpoints reached and not signed off: anyone may sign one off.
  for (const [i, t] of tasks.entries()) {
    const cp = t.checkpoint
    if (!cp || t.status !== 'done' || cp.signedOff || (cp.items.length > 0 && cp.items.every(b => b.isDone))) continue
    // Numbered as on the timeline, with what is open in a few words: its heading is often "After Tasks 1-3".
    const n = tasks.slice(0, i + 1).filter(x => x.checkpoint).length
    const open = cp.items.filter(b => !b.isDone).map(b => shortItem(b.text)).filter((x): x is string => !!x)
    const next = tasks.slice(i + 1)
    const until = next.findIndex(x => x.checkpoint)
    const held = (until < 0 ? next : next.slice(0, until + 1)).filter(x => x.status !== 'done').map(x => x.id)
    out.push({ kind: 'checkpoint', text: `checkpoint ${n}, after ${t.id}${open.length ? `: ${open.join(' · ')}` : ''}`, who: [], tasks: held, age: daysSince(t.state?.done, s.today) })
  }

  const question = (file: string, text: string): InboxItem => ({
    kind: 'question',
    text,
    who: named(text).map(asTeam),
    // The tasks it holds up, as the board marks them blocked.
    tasks: tasks.filter(t => t.blockedBy === `${file}: ${text}`).map(t => t.id),
    age: null,
    q: /^Q\d+\b/.exec(text)?.[0] ?? null,
    file,
  })
  for (const text of s.plan?.openQuestions ?? []) out.push(question('tasks/plan.md', text))

  // Each spec awaiting approval, the spec in focus first: the roles still to sign it, or anyone when no roles are set.
  const specs = [...s.specs].sort((a, b) => (a.file === s.specFile ? -1 : b.file === s.specFile ? 1 : 0))
  for (const { file, spec } of specs) {
    if (specApproval(spec, !!s.list) !== 'awaiting') continue
    const roles = team?.approvals.length ? approvalStatus(spec.approvals, team).waiting : []
    out.push({ kind: 'approval', text: `approve ${file}`, who: [...new Set(roles.flatMap(r => r.who))], tasks: [], age: daysSince(spec.created, s.today), file, roles })
  }
  // The spec in focus: its questions are open while it waits on approval.
  if (s.spec && specApproval(s.spec, !!s.list) !== 'approved') for (const text of s.spec.openQuestions) out.push(question(s.specFile ?? 'SPEC.md', text))

  // Reviews: this branch's, then those only another branch has in review. With no reviewer, anyone but its owner.
  const here = s.branches?.here ?? 'HEAD'
  const local = new Map(tasks.map(t => [t.id, t]))
  const reviews: { t: Pick<Task, 'id' | 'title'>; owner: string | null; reviewer: string | null; pr: string | null; ref: string | null; started: string | null }[] = tasks
    .filter(t => t.status !== 'done' && t.state?.status === 'in review')
    .map(t => ({ t, owner: t.owner ?? null, reviewer: t.reviewer ?? null, pr: t.pr ?? null, ref: null, started: t.state?.started ?? null }))
  for (const row of s.branches?.rows ?? []) {
    if (reviews.some(r => r.t.id === row.id) || local.get(row.id)?.status === 'done') continue
    const r = row.on.find(x => branchOf(x) !== here && x.state === 'in review')
    if (r) reviews.push({ t: row, owner: r.owner, reviewer: r.reviewer, pr: r.pr, ref: r.ref, started: r.started })
  }
  for (const r of reviews) {
    const who = r.reviewer ? [asTeam(r.reviewer)] : (team?.members ?? []).map(m => m.handle).filter(h => key(h) !== key(r.owner))
    out.push({ kind: 'review', text: `${r.t.id} ${r.t.title}`, who, tasks: [r.t.id], age: daysSince(r.started, s.today), id: r.t.id, pr: r.pr, ref: r.ref, owner: r.owner })
  }

  // Handoffs: the last one on each open task.
  for (const t of tasks) {
    const h = t.status === 'done' ? undefined : t.handoffs?.at(-1)
    if (h) out.push({ kind: 'handoff', text: `${t.id} ${t.title}`, who: [asTeam(h.to)], tasks: [t.id], age: daysSince(h.day, s.today), id: t.id, from: h.from, note: h.note })
  }
  return out
}

/**
 * `who` is `all`, `me` or a handle. An item waits on a person when it names
 * them, or names nobody. `me` is the person tasks/team.md knows by the git
 * email; with no team.md, or an email it doesn't list, `me` sees everything.
 */
export function inbox(s: State, who: string = 'me'): InboxItem[] {
  const items = inboxItems(s)
  const handle = who === 'me' ? (s.team ? (s.me?.handle ?? null) : null) : who === 'all' ? null : who
  if (handle === null) return items
  return items.filter(i => !i.who.length || i.who.some(h => key(h) === key(handle)))
}

const GROUPS: { kind: InboxKind; label: string }[] = [
  { kind: 'checkpoint', label: 'Checkpoints to sign off' },
  { kind: 'question', label: 'Questions to answer' },
  { kind: 'approval', label: 'Specs to sign' },
  { kind: 'review', label: 'Reviews' },
  { kind: 'handoff', label: 'Handoffs' },
]

/** An item as one line: its text, then for whom (a spec's roles), what it holds up and how long it has waited. */
export function inboxLine(i: InboxItem, handle: string | null): string {
  const parts = [i.text]
  if (i.kind === 'approval' && i.roles?.length) {
    const mine = handle ? i.roles.filter(r => r.who.some(h => key(h) === key(handle))) : []
    parts.push(mine.length ? `as ${mine.map(r => r.role).join(', ')}` : `waiting on ${i.roles.map(r => (r.who.length ? `${r.who.join(' or ')} (${r.role})` : `${r.role} (nobody on the team has it)`)).join(', ')}`)
  }
  if (i.kind === 'review') parts.push([i.pr ? `PR ${i.pr}` : null, i.ref ? `on ${i.ref}` : null, i.owner ? `by ${i.owner}` : null].filter(Boolean).join(' ') || 'no PR yet')
  if (i.kind === 'handoff') parts.push(`from ${i.from ?? 'someone'}: ${i.note ?? ''}`.trim())
  if (i.kind !== 'review' && i.kind !== 'handoff' && i.tasks.length) parts.push(`holds up ${i.tasks.join(', ')}`)
  if (i.age !== null) parts.push(`${i.age} d`)
  return parts.join(' · ')
}

/** `/progress inbox [@handle|all]` and `--inbox`: what waits on you, someone or anyone, grouped by kind. */
export function inboxText(s: State, who: string = 'me'): string {
  const items = inbox(s, who)
  const handle = who === 'me' ? (s.team ? (s.me?.handle ?? null) : null) : who === 'all' ? null : who
  const forWhom = who === 'all' ? 'anyone' : who === 'me' ? (handle ? 'you' : null) : handle!
  const head =
    forWhom === null
      ? `Inbox · everything waiting (${s.team ? `your git email is not in ${TEAM_FILE}` : `no ${TEAM_FILE}`}, so nothing is filtered)`
      : `Inbox · ${who === 'me' ? `you (${handle})` : forWhom}`
  if (!items.length) return `✓ Nothing is waiting on ${forWhom ?? 'you'}.`
  const lines = [`${head} · ${items.length} waiting`]
  for (const g of GROUPS) {
    const mine = items.filter(i => i.kind === g.kind)
    if (!mine.length) continue
    lines.push(g.label)
    for (const i of mine) lines.push(`  ♦ ${inboxLine(i, handle)}`)
  }
  return lines.join('\n')
}
