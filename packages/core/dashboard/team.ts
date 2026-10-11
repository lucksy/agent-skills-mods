// The Team tab (team-view V6): who is on what. A card per person in
// tasks/team.md (or, without it, per person the task list names), sorted by
// handle, plus one for what nobody owns: their current task and step, their work
// in progress here and on the other branches, the reviews waiting on them, the
// handoffs to them and their collisions. Then the review queue with ages, and
// the decisions waiting on someone. Load and queues only: nobody is ranked, and
// nothing done is counted. Pure.

import { shortDay } from '../forecast'
import { approvalStatus } from '../approvals'
import { branchOf, collisionLine, type Collision } from '../collisions'
import type { TaskStatusWord, TaskStep } from '../format'
import type { Task } from '../parse'
import type { State } from '../state'
import { TEAM_FILE } from '../team'
import { specApproval } from '../view'
import { esc, inline } from './html'

/** A task under way for someone: on this branch (`ref` null) or on another. */
export type TeamTask = { id: string; title: string; state: TaskStatusWord; step: TaskStep | null; ref: string | null }

/** A task in review, with its PR and how many days since the task started (the Status line has no review date). */
export type Review = { id: string; title: string; pr: string | null; owner: string | null; reviewer: string | null; ref: string | null; age: number | null }

export type Person = {
  /** `@sara`; null for the card of what nobody owns. */
  handle: string | null
  roles: string[]
  /** In tasks/team.md; false for someone the task list names who isn't. */
  listed: boolean
  current: TeamTask | null
  wip: TeamTask[]
  /** Reviews this person is the reviewer of (unowned: those with no reviewer). */
  reviews: Review[]
  handoffs: { id: string; title: string; from: string | null; day: string; note: string }[]
  collisions: Collision[]
}

/** A decision waiting on someone: an open question naming them, or a role they hold that a spec still needs. */
export type Waiting = { who: string | null; items: { kind: 'question' | 'approval'; text: string; tasks: string[] }[] }

export type TeamView = { fromTeam: boolean; people: Person[]; queue: Review[]; waiting: Waiting[] }

const DAY = 86_400_000
const daysBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY))
const key = (handle: string | null | undefined) => (handle ?? '').replace(/^@/, '').toLowerCase()
const byHandle = (a: string, b: string) => key(a).localeCompare(key(b))
const UNDER_WAY = new Set<TaskStatusWord>(['in progress', 'in review'])

/** Under way on this branch, as the plan pane counts it: its Status line says so, or its index line is marked `[~]`. */
const underWay = (t: Task) => t.status !== 'done' && (UNDER_WAY.has(t.state?.status ?? 'todo') || (!t.state && t.mark === 'doing'))

/** Handles named in a question: `@pm`, not the `@` of an email address. */
const named = (text: string) => [...text.matchAll(/(?:^|[\s(,])(@[\w-]+(?:\.[\w-]+)*)/g)].map(m => m[1]!)

/** Everything the tab shows, as data: the people in handle order, the review queue, and who decisions wait on. */
export function teamView(s: State): TeamView {
  const tasks = s.list?.tasks ?? []
  const here = s.branches?.here ?? 'HEAD'
  const local = new Map(tasks.map(t => [t.id, t]))

  // Work under way: this branch's tasks, then each other branch's copies of the rest.
  const wip: (TeamTask & { owner: string | null })[] = tasks.filter(underWay).map(t => ({ id: t.id, title: t.title, state: t.state?.status ?? 'in progress', step: t.state?.step ?? null, ref: null, owner: t.owner ?? null }))
  for (const row of s.branches?.rows ?? [])
    for (const r of row.on)
      if (branchOf(r) !== here && UNDER_WAY.has(r.state) && !wip.some(w => w.id === row.id && key(w.owner) === key(r.owner)))
        wip.push({ id: row.id, title: row.title, state: r.state, step: null, ref: r.ref, owner: r.owner })

  // The review queue: this branch's, then those only another branch has in review; oldest first.
  const queue: Review[] = tasks
    .filter(t => t.status !== 'done' && t.state?.status === 'in review')
    .map(t => ({ id: t.id, title: t.title, pr: t.pr ?? null, owner: t.owner ?? null, reviewer: t.reviewer ?? null, ref: null, age: t.state?.started ? daysBetween(t.state.started, s.today) : null }))
  for (const row of s.branches?.rows ?? []) {
    const t = local.get(row.id)
    if (queue.some(q => q.id === row.id) || t?.status === 'done') continue
    const r = row.on.find(x => branchOf(x) !== here && x.state === 'in review')
    if (r) queue.push({ id: row.id, title: row.title, pr: r.pr, owner: r.owner, reviewer: r.reviewer, ref: r.ref, age: r.started ? daysBetween(r.started, s.today) : null })
  }
  queue.sort((a, b) => (b.age ?? -1) - (a.age ?? -1))

  const handoffs = tasks.flatMap(t => {
    const h = t.status === 'done' ? undefined : t.handoffs?.at(-1)
    return h ? [{ id: t.id, title: t.title, from: h.from, day: h.day, note: h.note, to: h.to }] : []
  })
  const clashes = s.collisions ?? []

  // Who gets a card: the team, plus anyone the work names who isn't on it; without a team, everyone the list names.
  const team = s.team ?? null
  const members = new Map((team?.members ?? []).map(m => [key(m.handle), m]))
  const names = new Map<string, string>()
  const add = (h: string | null | undefined) => {
    if (h && !members.has(key(h)) && !names.has(key(h))) names.set(key(h), h)
  }
  if (!team) for (const t of tasks) add(t.owner)
  for (const w of wip) add(w.owner)
  for (const q of queue) add(q.reviewer)
  for (const h of handoffs) add(h.to)
  for (const c of clashes) for (const r of c.on) add(r.owner)

  const card = (handle: string | null, roles: string[], listed: boolean): Person => {
    const mine = (h: string | null | undefined) => (handle === null ? !h : key(h) === key(handle))
    const work = wip.filter(w => mine(w.owner)).map(({ owner: _, ...w }) => w)
    return {
      handle,
      roles,
      listed,
      current: work.find(w => w.ref === null && w.state === 'in progress') ?? work.find(w => w.state === 'in progress') ?? null,
      wip: work,
      reviews: queue.filter(q => mine(q.reviewer)),
      handoffs: handle === null ? [] : handoffs.filter(h => mine(h.to)).map(({ to: _, ...h }) => h),
      collisions: clashes.filter(c => c.on.some(r => mine(r.owner))),
    }
  }
  const people = [
    ...[...(team?.members ?? []).map(m => ({ handle: m.handle, roles: m.roles, listed: true })), ...[...names.values()].map(h => ({ handle: h, roles: [], listed: !team }))]
      .sort((a, b) => byHandle(a.handle, b.handle))
      .map(p => card(p.handle, p.roles, p.listed)),
    card(null, [], true),
  ]
  return { fromTeam: !!team, people, queue, waiting: waitingOn(s) }
}

/** Open questions by the people they name, and each role a spec still needs by the people who hold it. */
function waitingOn(s: State): Waiting[] {
  const by = new Map<string, Waiting>()
  const put = (who: string | null, item: Waiting['items'][number]) => {
    const k = who === null ? '' : key(who)
    if (!by.has(k)) by.set(k, { who, items: [] })
    by.get(k)!.items.push(item)
  }
  const questions = [...(s.plan?.openQuestions ?? []).map(text => ({ file: 'tasks/plan.md', text })), ...(s.spec?.openQuestions ?? []).map(text => ({ file: s.specFile ?? 'SPEC.md', text }))]
  for (const q of questions) {
    // The tasks it holds up, as the board marks them blocked.
    const tasks = (s.list?.tasks ?? []).filter(t => t.blockedBy === `${q.file}: ${q.text}`).map(t => t.id)
    const who = [...new Set(named(q.text).map(h => h.replace(/\.+$/, '')))]
    for (const h of who.length ? who : [null]) put(h === null ? null : (s.team?.members.find(m => key(m.handle) === key(h))?.handle ?? h), { kind: 'question', text: q.text, tasks })
  }
  if (s.team?.approvals.length)
    for (const { file, spec } of s.specs) {
      if (specApproval(spec, !!s.list) !== 'awaiting') continue
      for (const w of approvalStatus(spec.approvals, s.team).waiting) {
        if (!w.who.length) put(null, { kind: 'approval', text: `sign ${file} as ${w.role} (nobody on the team has the role)`, tasks: [] })
        for (const h of w.who) put(h, { kind: 'approval', text: `sign ${file} as ${w.role}`, tasks: [] })
      }
    }
  return [...by.values()].sort((a, b) => (a.who === null ? 1 : b.who === null ? -1 : byHandle(a.who, b.who)))
}

/** A task id that opens its card on the Board, when this branch has one. */
function taskRef(s: State, id: string): string {
  return s.list?.tasks.some(t => t.id === id) ? `<a href="#card-${esc(id)}">${esc(id)}</a>` : `<span class="id">${esc(id)}</span>`
}

const where = (ref: string | null) => (ref ? ` on <code>${esc(ref)}</code>` : '')
const age = (days: number | null) => (days === null ? '' : ` · ${days} d`)

export function teamHtml(s: State): string {
  const v = teamView(s)
  const anyone = v.people.length > 1
  const note = v.fromTeam
    ? ''
    : `<p class="t-note">${anyone ? `No ${TEAM_FILE} yet: these are the people named in the task list.` : `No ${TEAM_FILE} yet, and no task names an owner.`} <code>/progress team init</code> drafts one from the git authors.</p>\n`
  const cards = v.people.map(p => personHtml(s, p)).join('\n')
  return `${note}<ul class="people">
${cards}
</ul>
<div class="cols">
${queueHtml(s, v.queue)}
${waitingHtml(s, v.waiting)}
</div>`
}

function personHtml(s: State, p: Person): string {
  const name = p.handle === null ? 'Unowned' : esc(p.handle)
  const roles = p.handle === null ? 'what nobody has taken' : p.listed ? esc(p.roles.join(', ') || 'no role') : `not in ${TEAM_FILE}`
  const item = (id: string, title: string, rest: string) => `<li>${taskRef(s, id)} ${inline(title)}${rest}</li>`
  const list = (items: string[], none: string) => (items.length ? `<ul>${items.join('')}</ul>` : `<span class="muted">${none}</span>`)
  const cur = p.current
  const now = cur ? `${taskRef(s, cur.id)} ${inline(cur.title)}${where(cur.ref)}${cur.step ? ` · step ${cur.step}` : ''}` : '<span class="muted">nothing in progress</span>'
  const wip = `${p.wip.length}${p.wip.length ? ` · ${p.wip.map(w => `${taskRef(s, w.id)}${w.state === 'in review' ? ' (in review)' : ''}${where(w.ref)}`).join(', ')}` : ''}`
  const reviews = list(p.reviews.map(r => item(r.id, r.title, `${r.pr ? ` · PR ${esc(r.pr)}` : ''}${where(r.ref)}${age(r.age)}`)), 'none')
  const handoffs = list(p.handoffs.map(h => item(h.id, h.title, ` · from ${h.from ? esc(h.from) : 'someone'} ${shortDay(h.day)}: ${inline(h.note)}`)), 'none')
  const here = s.branches?.here ?? null
  const clashes = p.collisions.length
    ? p.collisions.map(c => `<p class="p-clash">${taskRef(s, c.id)} ${esc(collisionLine(c, here, { owner: p.handle }).slice(c.id.length + 1))}</p>`).join('')
    : '<span class="muted">none</span>'
  const row = (label: string, body: string) => `<div><dt>${label}</dt><dd>${body}</dd></div>`
  return `<li class="person${p.handle === null ? ' p-none' : ''}" data-person="${p.handle === null ? '-' : esc(key(p.handle))}">
<h3>${name} <span class="p-roles">${roles}</span></h3>
<dl class="p-facts">${row('Now', now)}${row('Work in progress', wip)}${row('Reviews waiting', reviews)}${row('Handoffs', handoffs)}${row('Collisions', clashes)}</dl>
</li>
<!-- /person -->`
}

function queueHtml(s: State, queue: Review[]): string {
  const items = queue.map(
    r => `<li>${taskRef(s, r.id)} ${inline(r.title)}${r.pr ? ` · PR ${esc(r.pr)}` : ''}${where(r.ref)} · ${r.owner ? esc(r.owner) : 'no owner'}${r.reviewer ? ` → reviewer ${esc(r.reviewer)}` : ' · no reviewer'}${age(r.age)}</li>`,
  )
  const body = items.length
    ? `<ul class="t-list">${items.join('')}</ul>\n<p class="basis">Oldest first. Age counts from the day the task started: the Status line doesn't say when review began.</p>`
    : '<p class="good">Nothing in review.</p>'
  return `<div class="card queue"><h3>Review queue</h3>${body}</div>`
}

function waitingHtml(s: State, waiting: Waiting[]): string {
  const groups = waiting.map(
    w => `<li><h4>${w.who === null ? 'Not addressed to anyone' : esc(w.who)}</h4><ul class="t-list">${w.items
      .map(i => `<li>${inline(i.text)}${i.tasks.length ? ` · holds up ${i.tasks.map(id => taskRef(s, id)).join(', ')}` : ''}</li>`)
      .join('')}</ul></li>`,
  )
  const body = groups.length ? `<ul class="t-groups">${groups.join('')}</ul>` : '<p class="good">No open questions or sign-offs waiting.</p>'
  return `<div class="card waiting"><h3>Waiting on someone</h3>${body}</div>
<!-- /waiting -->`
}

export const TEAM_STYLE = `
.t-note{margin:0 0 var(--s4);color:var(--ink2)}
.people{list-style:none;margin:0 0 var(--s5);padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--s3)}
.person{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:var(--s3) var(--s4);min-width:0}
.person.p-none{border-style:dashed}
.person h3{font-size:15px;font-weight:650;margin:0 0 var(--s2);overflow-wrap:anywhere}
.p-roles{font-size:12.5px;font-weight:500;color:var(--ink2);margin-left:var(--s1)}
.p-facts{margin:0;display:grid;gap:var(--s2)}
.p-facts dt{font-size:12px;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em}
.p-facts dd{margin:2px 0 0;overflow-wrap:anywhere}
.p-facts ul,.t-list{list-style:none;margin:0;padding:0}
.p-facts li,.t-list li{padding:1px 0}
.p-clash{margin:0;color:var(--blocked)}.p-clash a{color:inherit}
.t-groups{list-style:none;margin:0;padding:0}
.t-groups>li+li{margin-top:var(--s3);padding-top:var(--s3);border-top:1px solid var(--line)}
.t-groups h4{font-size:13px;margin:0 0 var(--s1)}
.card:target{outline:2px solid var(--focus);outline-offset:2px}
`
