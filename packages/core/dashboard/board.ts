// The Board (K2): what is in flight and what is stuck. Five columns (to do,
// waiting on a dependency, in progress, blocked, done), a card per task saying
// what a person needs to know about it, the checkpoint right after the task it
// follows. The script adds filters for phase and state and a switch to lanes per
// phase, all kept in the #board?… hash; without it the plain columns show. Pure.

import { shortDay } from '../forecast'
import type { Task } from '../parse'
import type { State } from '../state'
import { esc, inline, plural } from './html'

type Col = 'todo' | 'waiting' | 'doing' | 'blocked' | 'done'
const COLUMNS: { key: Col; label: string }[] = [
  { key: 'todo', label: 'To do' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'doing', label: 'In progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
]

const DAY = 86_400_000
const daysBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY))

/** A task's column: in progress as the Overview counts it (the current task, or one its Status line says is under way). */
function columnOf(s: State, t: Task): Col {
  if (t.status === 'done') return 'done'
  if (t.status === 'blocked') return 'blocked'
  if (t.id === s.list?.current?.id || t.state?.status === 'in progress') return 'doing'
  return t.status === 'waiting' ? 'waiting' : 'todo'
}

export function boardHtml(s: State): string {
  const list = s.list
  if (!list || list.total === 0) return '<div class="card empty" role="status"><h3>No task list yet</h3><p>The board fills in once <code>tasks/todo.md</code> exists.</p></div>'

  // Phases in the order they first appear, numbered from 1 for the filter and the hash.
  const phases = [...new Set(list.tasks.map(t => t.phase).filter((p): p is string => !!p))]
  const phaseNo = (t: Task) => (t.phase ? String(phases.indexOf(t.phase) + 1) : '')
  const cards = (col: Col, only?: string) =>
    list.tasks
      .filter(t => columnOf(s, t) === col && (only === undefined || phaseNo(t) === only))
      .map(t => cardHtml(s, t, col, phaseNo(t), phases.length > 0))
      .join('')
  const columns = (only: string | undefined, inLane: boolean) =>
    COLUMNS.map(c => {
      const body = cards(c.key, only)
      const n = (body.match(/ data-task="/g) ?? []).length
      const head = `${c.label} <span class="n">${n}</span>`
      const items = body ? `<ul>${body}</ul>` : '<p class="none">Nothing here</p>'
      return inLane
        ? `<div class="col" data-col="${c.key}"><h4>${head}</h4>${items}</div>`
        : `<section class="col" data-col="${c.key}" aria-labelledby="col-${c.key}"><h3 id="col-${c.key}">${head}</h3>${items}</section>`
    }).join('')

  const option = (value: string, label: string) => `<option value="${esc(value)}">${esc(label)}</option>`
  const tools = `<div class="board-tools js-only">
<label>Phase <select id="board-phase">${option('', 'All phases')}${phases.map((p, i) => option(String(i + 1), p)).join('')}</select></label>
<label>State <select id="board-state">${option('', 'All states')}${COLUMNS.map(c => option(c.key, c.label)).join('')}</select></label>
${phases.length ? '<label class="check"><input type="checkbox" id="board-group"> Lanes by phase</label>' : ''}
</div>`
  const lanes = phases.length
    ? `<div class="swim js-only">${phases
        .map((p, i) => `<section class="lane" data-phase="${i + 1}"><h3 class="lane-title">${esc(p)}</h3><div class="cols5">${columns(String(i + 1), true)}</div></section>\n<!-- /lane -->`)
        .join('\n')}</div>`
    : ''
  return `${tools}
<div class="cols5 flat">${columns(undefined, false)}</div>
${lanes}`
}

function cardHtml(s: State, t: Task, col: Col, phase: string, showPhase: boolean): string {
  const open = t.boxes.filter(b => !b.isDone).length
  const n = t.boxes.length
  const boxes = n === 0 ? 'no boxes' : open === 0 ? (n === 1 ? '1 box done' : `all ${n} done`) : `${open} of ${n} open`
  const st = t.state
  let meta: string
  if (col === 'doing') meta = [boxes, st?.started ? `started ${shortDay(st.started)} · ${daysBetween(st.started, s.today)} d` : 'next up', st?.step ? `step ${st.step}` : ''].filter(Boolean).join(' · ')
  else if (col === 'waiting') meta = `waits on ${t.deps.join(', ')} · ${boxes}`
  else if (col === 'blocked') meta = `<span class="why">${inline((t.blockedBy ?? 'blocked').replace(/^[^:]+\.md: /, ''))}</span>`
  else if (col === 'done') {
    const d = s.dates[t.id]
    meta = `${boxes}${d && !d.isEstimate ? ` · done ${shortDay(d.day)}` : ''}`
  } else meta = boxes === 'no boxes' ? boxes : plural(n, 'box', 'boxes')
  const phaseTag = showPhase && phase ? `<span class="c-phase">Phase ${phase}</span>` : ''
  const card = `<li class="card c-${col}" data-task="${esc(t.id)}" data-phase="${phase}" data-state="${col}">
<p class="c-title"><span class="id">${esc(t.id)}</span> ${inline(t.title)}</p>
<p class="c-meta">${meta}${phaseTag}</p>
</li>`
  const cp = t.checkpoint
  if (!cp) return card
  const cpOpen = cp.items.filter(b => !b.isDone).length
  return `${card}
<li class="cp" data-phase="${phase}" data-state="${col}"><span aria-hidden="true">◆</span> Checkpoint: ${esc(cp.title)} · ${cpOpen ? `${cpOpen} of ${cp.items.length} open` : '✓ signed off'}</li>`
}
