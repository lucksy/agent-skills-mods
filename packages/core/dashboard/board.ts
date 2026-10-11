// The Board (K2): what is in flight and what is stuck. Five columns (to do,
// waiting on a dependency, in progress, blocked, done), a card per task saying
// what a person needs to know about it, the checkpoint right after the task it
// follows. The script adds filters for phase and state and a switch to lanes per
// phase, all kept in the #board?… hash; without it the plain columns show.
// When the other branches were read (team-view), a switch shows each task at its
// furthest state on any branch instead (#board?branches=all), and a task that
// collides is marked on both. On the live page (T11) this branch's cards get
// buttons for what can happen to them next; the all-branches cards never do. Pure.

import { dayOf, shortDay } from '../forecast'
import type { BranchRow } from '../branches'
import { collisionLine } from '../collisions'
import type { TaskStatusWord } from '../format'
import type { Task } from '../parse'
import type { State } from '../state'
import { esc, inline, plural } from './html'
import { actButton, actForm, actRow, tickButton, type LiveAt } from './live'
import { dueCheckpoint } from '../actions'

type Col = 'todo' | 'waiting' | 'doing' | 'review' | 'blocked' | 'done'
const COLUMNS: { key: Col; label: string }[] = [
  { key: 'todo', label: 'To do' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'doing', label: 'In progress' },
  { key: 'review', label: 'In review' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
]

const DAY = 86_400_000
const daysBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY))

/** A task's column: in progress as the Overview counts it (the current task, or one its Status line says is under way). */
function columnOf(s: State, t: Task): Col {
  if (t.status === 'done') return 'done'
  if (t.status === 'blocked') return 'blocked'
  if (t.state?.status === 'in review') return 'review'
  if (t.id === s.list?.current?.id || t.state?.status === 'in progress') return 'doing'
  return t.status === 'waiting' ? 'waiting' : 'todo'
}

export function boardHtml(s: State, live = false): string {
  const list = s.list
  if (!list || list.total === 0) return '<div class="card empty" role="status"><h3>No task list yet</h3><p>The board fills in once <code>tasks/todo.md</code> exists.</p></div>'

  // Phases in the order they first appear, numbered from 1 for the filter and the hash.
  const phases = [...new Set(list.tasks.map(t => t.phase).filter((p): p is string => !!p))]
  const phaseNo = (t: Task) => (t.phase ? String(phases.indexOf(t.phase) + 1) : '')
  // In review gets its own column only when a task is in review (format-v2).
  const cols = COLUMNS.filter(c => c.key !== 'review' || list.tasks.some(t => columnOf(s, t) === 'review'))
  const rows = s.branches?.rows ?? null
  const local = new Map(list.tasks.map(t => [t.id, t]))
  const acrossCols = rows && COLUMNS.filter(c => c.key !== 'review' || rows.some(r => r.state === 'in review'))
  const owners = [...new Set([...list.tasks.map(t => t.owner), ...(rows ?? []).map(r => r.owner)].filter((o): o is string => !!o))].sort((a, b) => a.localeCompare(b))
  const due = live ? dueCheckpoint(list) : null
  const cards = (col: Col, only?: string) =>
    list.tasks
      .filter(t => columnOf(s, t) === col && (only === undefined || phaseNo(t) === only))
      .map(t => cardHtml(s, t, col, phaseNo(t), phases.length > 0, only === undefined, live ? { at: only === undefined ? 'b' : `l${only}`, due: t === due } : null))
      .join('')
  const column = (c: { key: Col; label: string }, body: string, inLane: boolean, idPrefix = 'col') => {
    const n = (body.match(/ data-task="/g) ?? []).length
    const head = `${c.label} <span class="n">${n}</span>`
    const items = body ? `<ul>${body}</ul>` : '<p class="none">Nothing here</p>'
    return inLane
      ? `<div class="col" data-col="${c.key}"><h4>${head}</h4>${items}</div>`
      : `<section class="col" data-col="${c.key}" aria-labelledby="${idPrefix}-${c.key}"><h3 id="${idPrefix}-${c.key}">${head}</h3>${items}</section>`
  }
  const columns = (only: string | undefined, inLane: boolean) => cols.map(c => column(c, cards(c.key, only), inLane)).join('')

  const option = (value: string, label: string) => `<option value="${esc(value)}">${esc(label)}</option>`
  const tools = `<div class="board-tools js-only">
${rows ? `<label>Branches <select id="board-branches">${option('', 'This branch')}${option('all', 'All branches')}</select></label>` : ''}
<label>Phase <select id="board-phase">${option('', 'All phases')}${phases.map((p, i) => option(String(i + 1), p)).join('')}</select></label>
<label>State <select id="board-state">${option('', 'All states')}${(acrossCols && acrossCols.length > cols.length ? acrossCols : cols).map(c => option(c.key, c.label)).join('')}</select></label>
${owners.length ? `<label>Person <select id="board-owner">${option('', 'Everyone')}${owners.map(o => option(ownerKey(o), o)).join('')}${option('-', 'No owner')}</select></label>` : ''}
${phases.length ? '<label class="check"><input type="checkbox" id="board-group"> Lanes by phase</label>' : ''}
</div>`
  const lanes = phases.length
    ? `<div class="swim js-only">${phases
        .map((p, i) => `<section class="lane" data-phase="${i + 1}"><h3 class="lane-title">${esc(p)}</h3><div class="cols5" style="--cols:${cols.length}">${columns(String(i + 1), true)}</div></section>\n<!-- /lane -->`)
        .join('\n')}</div>`
    : ''
  // Each task at its furthest state on any branch, with the branch it is on (team-view V1).
  const across = rows && acrossCols
    ? `\n<div class="across js-only">
<p class="b-across">${acrossHead(s)}</p>
<div class="cols5" style="--cols:${acrossCols.length}">${acrossCols
        .map(c => column(c, rows.filter(r => acrossColumn(r, local.get(r.id), s) === c.key).map(r => acrossCardHtml(s, r, local.get(r.id), phaseNo)).join(''), false, 'across'))
        .join('')}</div>
</div>
<!-- /across -->`
    : ''
  return `${tools}
<div class="cols5 flat" style="--cols:${cols.length}">${columns(undefined, false)}</div>
${lanes}${across}`
}

const ACROSS_COL: Record<TaskStatusWord, Col> = { done: 'done', 'in review': 'review', 'in progress': 'doing', blocked: 'blocked', todo: 'todo' }

/** A row's column across branches: its furthest state; a task still to do everywhere waits here if it waits on this branch. */
function acrossColumn(r: BranchRow, t: Task | undefined, s: State): Col {
  const col = ACROSS_COL[r.state]
  return col === 'todo' && t && columnOf(s, t) === 'waiting' ? 'waiting' : col
}

/** Above the all-branches columns: how many branches, and how old the remote ones are. */
function acrossHead(s: State): string {
  const b = s.branches!
  const others = b.refs.filter(r => r.hasFile && !r.plan).length
  const at = b.fetchedAt
  const days = at === null ? 0 : daysBetween(dayOf(at), s.today)
  const fetched = at === null ? 'never fetched: remote branches are as of the last fetch' : `last fetched ${shortDay(dayOf(at))} (${days === 0 ? 'today' : `${days} d ago`})`
  return `Each task at its furthest state on ${esc(b.here ?? 'HEAD')} and ${plural(others, 'other branch', 'other branches')} · ${fetched}`
}

/** A task's collision on a card: a mark that says so in words, and the line the band shows. */
function clashHtml(s: State, id: string): { cls: string; flag: string; line: string } {
  const c = s.collisions?.find(x => x.id === id)
  if (!c) return { cls: '', flag: '', line: '' }
  return { cls: ' clash', flag: '<span class="c-flag" role="img" aria-label="Collision">!</span> ', line: `\n<p class="c-clash">${esc(collisionLine(c, s.branches?.here ?? null))}</p>` }
}

function acrossCardHtml(s: State, r: BranchRow, t: Task | undefined, phaseNo: (t: Task) => string): string {
  const col = acrossColumn(r, t, s)
  const phase = t ? phaseNo(t) : ''
  const k = clashHtml(s, r.id)
  const where = r.ref === null ? 'not started on any branch' : `on <code>${esc(r.ref)}</code>`
  const owner = r.owner ? `<span class="c-owner">${esc(r.owner)}</span>` : ''
  return `<li class="card c-${col}${k.cls}" data-task="${esc(r.id)}" data-phase="${phase}" data-state="${col}" data-owner="${esc(ownerKey(r.owner ?? undefined))}">
<p class="c-title">${k.flag}<span class="id">${esc(r.id)}</span> ${inline(r.title)}</p>
<p class="c-meta"><span class="c-ref">${where}</span>${owner}</p>${k.line}
</li>`
}

/** The latest handoff note on a card (format-v2, F6): who passed it on, to whom, and what's left. */
function noteHtml(t: Task): string {
  const h = t.handoffs?.at(-1)
  return h ? `\n<p class="c-note">↪ ${h.from ? `${esc(h.from)} → ` : 'to '}${esc(h.to)}: ${inline(h.note)}</p>` : ''
}

/** An owner as the filter and the hash name them: `@Sara-K` → `sara-k`; '' when there is none. */
const ownerKey = (owner: string | undefined) => (owner ?? '').replace(/^@/, '').toLowerCase()

/**
 * A card's buttons on the live page (T11): what can happen to it next from where
 * it is. Claim only when nobody owns it; a done task has none (its boxes still toggle).
 */
function cardActions(t: Task, col: Col, at: LiveAt): string {
  const id = t.id
  const btn = (act: string, label: string) => actButton(act, { id }, label, `${label} ${id}`, id)
  const block = actForm('block', { id }, { label: 'Block', name: `Block ${id}`, submit: `Block ${id}`, fields: [{ name: 'why', label: `Why is ${id} blocked?`, hint: 'Upstash or self-hosted?' }], subject: id, at })
  const handoff = actForm('handoff', { id }, {
    label: 'Hand off',
    name: `Hand off ${id}`,
    submit: `Hand off ${id}`,
    fields: [{ name: 'to', label: 'To', hint: '@bob' }, { name: 'note', label: 'What the next person needs to know', hint: 'migration done, tests left' }],
    subject: id,
    at,
  })
  const assign = actForm('assign', { id }, { label: 'Assign', name: `Assign ${id}`, submit: `Assign ${id}`, fields: [{ name: 'who', label: `Who takes ${id}?`, hint: '@sara' }], subject: id, at })
  const claim = t.owner ? [] : [btn('claim', 'Claim')]
  if (col === 'done') return ''
  if (col === 'blocked') return actRow([btn('unblock', 'Unblock'), ...claim])
  if (col === 'review') return actRow([btn('done', 'Done'), ...claim, handoff, block])
  if (col === 'doing') return actRow([btn('done', 'Done'), btn('review', 'Review'), ...claim, handoff, block])
  return actRow([btn('start', 'Start'), ...claim, assign, block])
}

/** A card's boxes on the live page, folded: each a toggle that ticks or unticks it. */
function boxesHtml(t: Task): string {
  if (!t.boxes.length) return ''
  const open = t.boxes.filter(b => !b.isDone).length
  return `\n<details class="c-boxes"><summary>Boxes of ${esc(t.id)} · ${open} of ${t.boxes.length} open</summary><ul>${t.boxes
    .map((b, i) => `<li>${tickButton(t.id, i, b.isDone, inline(b.text))}</li>`)
    .join('')}</ul></details>`
}

/** A card; `anchor` gives it the id other tabs link to (`#card-T4`), on this branch's plain columns only. */
function cardHtml(s: State, t: Task, col: Col, phase: string, showPhase: boolean, anchor: boolean, live: { at: LiveAt; due: boolean } | null = null): string {
  const open = t.boxes.filter(b => !b.isDone).length
  const n = t.boxes.length
  const boxes = n === 0 ? 'no boxes' : open === 0 ? (n === 1 ? '1 box done' : `all ${n} done`) : `${open} of ${n} open`
  const st = t.state
  let meta: string
  // format-v2: who owns it; for a task in review, its PR and reviewer.
  const ownerTag = t.owner ? `<span class="c-owner">${esc(t.owner)}</span>` : ''
  if (col === 'review') meta = [t.owner && esc(t.owner), t.pr && `PR ${esc(t.pr)}`, t.reviewer && `reviewer ${esc(t.reviewer)}`].filter(Boolean).join(' · ') || 'in review'
  else if (col === 'doing') meta = [boxes, st?.started ? `started ${shortDay(st.started)} · ${daysBetween(st.started, s.today)} d` : 'next up', st?.step ? `step ${st.step}` : ''].filter(Boolean).join(' · ')
  else if (col === 'waiting') meta = `waits on ${t.deps.join(', ')} · ${boxes}`
  else if (col === 'blocked') meta = `<span class="why">${inline((t.blockedBy ?? 'blocked').replace(/^[^:]+\.md: /, ''))}</span>`
  else if (col === 'done') {
    const d = s.dates[t.id]
    meta = `${boxes}${d && !d.isEstimate ? ` · done ${shortDay(d.day)}` : ''}`
  } else meta = boxes === 'no boxes' ? boxes : plural(n, 'box', 'boxes')
  const phaseTag = showPhase && phase ? `<span class="c-phase">Phase ${phase}</span>` : ''
  const k = clashHtml(s, t.id)
  const card = `<li class="card c-${col}${k.cls}" data-task="${esc(t.id)}" data-phase="${phase}" data-state="${col}" data-owner="${esc(ownerKey(t.owner))}"${anchor ? ` id="card-${esc(t.id)}"` : ''}>
<p class="c-title">${k.flag}<span class="id">${esc(t.id)}</span> ${inline(t.title)}</p>
<p class="c-meta">${meta}${col === 'review' ? '' : ownerTag}${phaseTag}</p>${noteHtml(t)}${k.line}${live ? `${boxesHtml(t)}${cardActions(t, col, live.at)}` : ''}
</li>`
  const cp = t.checkpoint
  if (!cp) return card
  const cpOpen = cp.items.filter(b => !b.isDone).length
  const signoff = live?.due ? actRow([actButton('signoff', {}, 'Sign off', `Sign off checkpoint ${cp.title}`, 'checkpoint')]) : ''
  return `${card}
<li class="cp" data-phase="${phase}" data-state="${col}" data-owner="${esc(ownerKey(t.owner))}"><span aria-hidden="true">◆</span> Checkpoint: ${esc(cp.title)} · ${cpOpen ? `${cpOpen} of ${cp.items.length} open` : '✓ signed off'}${signoff}</li>`
}
