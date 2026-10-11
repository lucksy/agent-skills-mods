// The team standup (ceremonies C3): one line per person in tasks/team.md, plus
// what nobody owns. Each line has what was done since the last working day, on
// this branch or any other the board across branches reads, what is under way
// today and what is blocked. Commits count too: a subject that starts with a
// plan task id (`T4: …`, `T4 …`), by an email tasks/team.md knows. People show
// only as owners of tasks: no counts, rates or totals per person. Pure: the
// runner is handed in.

import type { BranchBoard } from './branches'
import { branchOf } from './collisions'
import { dayOf, shortDay } from './forecast'
import type { TaskStatusWord } from './format'
import type { Runner } from './history'
import type { Task } from './parse'
import type { State } from './state'
import { whoIs } from './team'

/** A commit as the standup reads it: its author's email, its day (UTC) and its subject. */
export type Commit = { email: string; day: string; subject: string }

/** A task in a line, with what is worth saying about it: `test, 2 boxes left`, `on feat/keys`. */
export type StandupItem = { id: string; note: string | null }

/** A person's line (`who` null: what nobody owns). `listed`: in tasks/team.md, or named by the task list when there is none. */
export type StandupPerson = { who: string | null; listed: boolean; done: StandupItem[]; today: StandupItem[]; blocked: StandupItem[] }

export type TeamStandup = { name: string; today: string; since: string; people: StandupPerson[] }

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_MS = 86_400_000
const key = (handle: string | null | undefined) => (handle ?? '').replace(/^@/, '').toLowerCase()
const num = (id: string) => Number(id.slice(1))

/** The last working day before `today`: Friday on a Monday (and on a weekend), else the day before. */
export function lastWorkingDay(today: string): string {
  const d = new Date(`${today}T00:00:00Z`)
  const back = d.getUTCDay() === 1 ? 3 : d.getUTCDay() === 0 ? 2 : 1
  return dayOf(d.getTime() - back * DAY_MS)
}

/** One `git log` over this branch and every ref the board read, since `since`: `<email>\t<unix seconds>\t<subject>`. */
export function standupLogArgv(board: BranchBoard | null, since: string): string[] {
  const refs = (board?.refs ?? []).filter(r => r.hasFile && !r.plan).map(r => `refs/${r.remote ? 'remotes' : 'heads'}/${r.name}`)
  return ['git', 'log', `--since=${since}T00:00:00Z`, '--no-merges', '--format=%ae%x09%at%x09%s', 'HEAD', ...refs]
}

export function parseCommits(out: string): Commit[] {
  return out
    .split('\n')
    .map(line => /^([^\t]*)\t(\d+)\t(.*)$/.exec(line))
    .filter(m => m !== null)
    .map(m => ({ email: m[1]!.trim().toLowerCase(), day: dayOf(Number(m[2]) * 1000), subject: m[3]! }))
}

/** The plan task a subject starts with, followed by `:` or a space; null for `IT4 fix`, or `T44` when the plan has no T44. */
export function taskOfSubject(subject: string, ids: ReadonlySet<string>): string | null {
  const id = /^(T\d+)[: ]/.exec(subject)?.[1]
  return id && ids.has(id) ? id : null
}

/** The commits since `since` on the refs the board read; empty outside a repository or when git fails. */
export async function readCommits(run: Runner, board: BranchBoard | null, since: string): Promise<Commit[]> {
  const r = await run(standupLogArgv(board, since)).catch(() => null)
  return r && r.exitCode === 0 ? parseCommits(r.stdout) : []
}

const UNDER_WAY = new Set<TaskStatusWord>(['in progress', 'in review'])
/** Under way on this branch, as the Team tab counts it: its Status line says so, or its index line is marked `[~]`. */
const underWay = (t: Task) => t.status !== 'done' && (UNDER_WAY.has(t.state?.status ?? 'todo') || (!t.state && t.mark === 'doing'))
const boxesLeft = (t: Task) => {
  const n = t.boxes.filter(b => !b.isDone).length
  return `${n} box${n === 1 ? '' : 'es'} left`
}
/** Why a task is blocked, in a few words: the open question it waits on (`plan.md: Q2 (T4): …`), else nothing more to say. */
const blockReason = (t: Task) => {
  const text = /^[^:]+\.md: (.*)$/.exec(t.blockedBy ?? '')?.[1]
  if (!text) return null
  const q = /^Q\d+\b/.exec(text)?.[0]
  return q ? `waits on ${q}` : text
}

/**
 * `/progress standup team` (C3): a line per person in tasks/team.md (without
 * it, per owner the task lists name, as written), in handle order, then what
 * nobody owns. Done since the last working day on any branch the board read,
 * plus the tasks their commits name; today, their tasks in progress or in
 * review; blocked, with the reason. A task done on any branch is not under way.
 */
export function standupTeam(
  s: Pick<State, 'list' | 'team' | 'dates' | 'spec'>,
  branches: BranchBoard | null,
  commits: Commit[],
  today: string,
): TeamStandup {
  const since = lastWorkingDay(today)
  const tasks = s.list?.tasks.filter(t => /^T\d+$/.test(t.id)) ?? []
  const here = branches?.here ?? 'HEAD'
  const rows = branches?.rows ?? []
  const doneAnywhere = new Set([...tasks.filter(t => t.status === 'done').map(t => t.id), ...rows.filter(r => r.state === 'done').map(r => r.id)])
  const items: { owner: string | null; part: 'done' | 'today' | 'blocked'; item: StandupItem }[] = []
  const put = (owner: string | null | undefined, part: 'done' | 'today' | 'blocked', id: string, note: string | null = null) => {
    if (!items.some(i => i.part === part && i.item.id === id && key(i.owner) === key(owner))) items.push({ owner: owner ?? null, part, item: { id, note } })
  }

  // Done since the last working day: here (its Status line's day, else history's), then on the other branches.
  for (const t of tasks) {
    const d = t.state?.done ?? (s.dates[t.id] && !s.dates[t.id]!.isEstimate ? s.dates[t.id]!.day : null)
    if (t.status === 'done' && d && d >= since) put(t.owner, 'done', t.id)
  }
  for (const row of rows)
    for (const r of row.on)
      if (r.state === 'done' && r.done && r.done >= since && !items.some(i => i.part === 'done' && i.item.id === row.id)) put(r.owner ?? row.owner, 'done', row.id)

  // Under way and blocked, here and then on each other branch.
  for (const t of tasks) {
    if (doneAnywhere.has(t.id)) continue
    if (t.status === 'blocked') put(t.owner, 'blocked', t.id, blockReason(t))
    else if (underWay(t)) put(t.owner, 'today', t.id, t.state?.status === 'in review' ? 'in review' : [t.state?.step, boxesLeft(t)].filter(Boolean).join(', '))
  }
  for (const row of rows) {
    if (doneAnywhere.has(row.id)) continue
    for (const r of row.on) {
      // This branch's copy, or a task this person already has here: said once.
      if (branchOf(r) === here || items.some(i => i.part !== 'done' && i.item.id === row.id && key(i.owner) === key(r.owner))) continue
      if (UNDER_WAY.has(r.state)) put(r.owner, 'today', row.id, `${r.state === 'in review' ? 'in review ' : ''}on ${r.ref}`)
      else if (r.state === 'blocked') put(r.owner, 'blocked', row.id, `on ${r.ref}`)
    }
  }

  // Commits naming a plan task, by someone tasks/team.md knows by email.
  const ids = new Set([...tasks.map(t => t.id), ...rows.map(r => r.id)])
  for (const c of commits) {
    const id = c.day >= since ? taskOfSubject(c.subject, ids) : null
    const who = id ? whoIs(s.team ?? null, c.email) : null
    if (id && who && !items.some(i => i.part === 'done' && i.item.id === id && key(i.owner) === key(who.handle))) put(who.handle, 'done', id, 'commits')
  }

  // Who gets a line: the team, then anyone the work names who isn't on it; without a team, everyone the list names.
  const team = s.team ?? null
  const handles = new Map<string, { who: string; listed: boolean }>()
  for (const m of team?.members ?? []) handles.set(key(m.handle), { who: m.handle, listed: true })
  if (!team) for (const t of tasks) if (t.owner && !handles.has(key(t.owner))) handles.set(key(t.owner), { who: t.owner, listed: true })
  for (const i of items) if (i.owner && !handles.has(key(i.owner))) handles.set(key(i.owner), { who: i.owner, listed: !team })

  const line = (who: string | null, listed: boolean): StandupPerson => {
    const mine = items.filter(i => (who === null ? !i.owner : key(i.owner) === key(who)))
    const part = (p: 'done' | 'today' | 'blocked') => mine.filter(i => i.part === p).map(i => i.item).sort((a, b) => num(a.id) - num(b.id))
    return { who, listed, done: part('done'), today: part('today'), blocked: part('blocked') }
  }
  const people = [...[...handles.values()].sort((a, b) => key(a.who).localeCompare(key(b.who))).map(h => line(h.who, h.listed)), line(null, true)]
  return { name: s.list?.meta?.plan ?? s.spec?.title ?? 'Plan', today, since, people }
}

/** What `/progress standup team` and `--standup-team` print: a heading, then a line per person and one for unowned work. */
export function standupTeamText(st: TeamStandup, hasList = true): string {
  const d = new Date(`${st.today}T00:00:00Z`)
  const s = new Date(`${st.since}T00:00:00Z`)
  const head = `Team standup · ${st.name} · ${WEEKDAY[d.getUTCDay()]} ${shortDay(st.today)} · done since ${WEEKDAY[s.getUTCDay()]} ${shortDay(st.since)}`
  if (!hasList) return `${head}\nNo task list yet.`
  const items = (xs: StandupItem[]) => (xs.length ? xs.map(x => (x.note ? `${x.id} (${x.note})` : x.id)).join(', ') : '—')
  const lines = st.people.map(p => {
    const who = p.who ?? 'Unowned'
    if (!p.done.length && !p.today.length && !p.blocked.length) return `${who}: nothing under way`
    return `${who}: done ${items(p.done)} · today ${items(p.today)} · blocked ${items(p.blocked)}`
  })
  return [head, ...lines].join('\n')
}
