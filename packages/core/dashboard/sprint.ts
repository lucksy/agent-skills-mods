// The Sprint tab (ceremonies C5, T12): is the sprint on track? It leads with the
// dates and days left, then four figures (committed against done, added, what
// carries over), a burn-down in points against the ideal line, the committed and
// added tasks, and the demo checklist. Once the sprint has ended, its retro
// (T9). Last, the backlog with sizes; on the live page each item has Pull.
// With no sprint (Kanban, the default) the tab says so, shows `/progress sprint
// plan`'s proposal (T7) as words, and the backlog. Everything is worked out from
// State; the bundle only draws the chart. Bottlenecks in the work only: tasks
// show no owner and nothing is counted per person. Pure.

import { shortDay } from '../forecast'
import type { Task } from '../parse'
import { MIN_OF_SIZE, type Retro } from '../retro'
import { sprintPlan, sprintReview, type SprintReview } from '../sprint'
import { pointsOf, pointsText, weightOf } from '../size'
import type { State } from '../state'
import type { FlowSpec } from './flow'
import { chartMount, esc, inline, plural } from './html'
import { actButton } from './live'

const DAY = 86_400_000
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`)
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)

/** Mon–Fri days from `from` to `to`, both included, as the sprint counts them (no holidays). */
function workdays(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = ms(from); t <= ms(to); t += DAY) {
    const wd = new Date(t).getUTCDay()
    if (wd !== 0 && wd !== 6) out.push(dayOf(t))
  }
  return out
}

/** `4½`: points without their unit. */
const num = (n: number) => pointsText(Math.max(0, n)).replace(/ points?$/, '')

export type Burndown = {
  /** What the bundle draws; null before the sprint has a day to show. */
  spec: FlowSpec | null
  /** One line: points left against the ideal line, which is all a page without JS shows. */
  summary: string
  legend: { glyph: string; token: string; label: string }[]
}

/**
 * Points left of the sprint's tasks (committed, plus added ones from the day
 * they appear) on each working day so far, from tasks/todo.md's committed copies
 * and, for today, the file as it is; against the ideal line from the committed
 * points on the first day to none on the last. Weights are today's sizes, so a
 * task sized during the sprint weighs the same on every day. Pure.
 */
export function burndownChart(s: State, r: SprintReview): Burndown {
  const legend = [
    { glyph: '━', token: '--doing', label: 'points left' },
    { glyph: '┅', token: '--ink3', label: 'ideal' },
  ]
  const list = s.list!
  const days = workdays(r.start, r.end)
  const total = r.committed.points
  const addedPoints = pointsOf(r.added.ids.map(id => list.tasks.find(t => t.id === id) ?? {}))
  if (r.phase === 'upcoming') return { spec: null, legend, summary: `The burn-down starts on ${shortDay(r.start)}: ${pointsText(total)} committed over ${plural(days.length, 'working day')}.` }

  const sizes = new Map(list.tasks.map(t => [t.id, t]))
  const weigh = (t: Task) => weightOf(sizes.get(t.id) ?? t)
  const scope = new Set([...r.committed.ids, ...r.added.ids])
  // The file as it is counts as today's copy; on a day with both, it wins (it comes last).
  const copies = [...(s.sprintCopies ?? []), { day: s.today, list }].sort((a, b) => a.day.localeCompare(b.day))
  const until = s.today < r.end ? s.today : r.end
  const left = days
    .filter(d => d <= until)
    .flatMap(d => {
      const v = copies.filter(c => c.day <= d).at(-1)
      if (!v) return []
      const n = v.list.tasks.filter(t => scope.has(t.id) && t.status !== 'done').reduce((a, t) => a + weigh(t), 0)
      return [{ x: d, y: n, tip: `${shortDay(d)} · ${pointsText(n)} left` }]
    })
  const n = days.length
  const ideal = (i: number) => (n > 1 ? (total * (n - 1 - i)) / (n - 1) : 0)
  const idealData = n > 1 ? days.map((d, i) => ({ x: d, y: ideal(i), tip: `${shortDay(d)} · ideal ${pointsText(Math.round(ideal(i) * 2) / 2)}` })) : [{ x: r.start, y: total, tip: `ideal ${pointsText(total)}` }]
  const last = left.at(-1)
  if (!last) return { spec: null, legend, summary: `No copy of tasks/todo.md from the sprint yet: the burn-down fills in from its first day, ${shortDay(r.start)}.` }

  const at = days.indexOf(last.x)
  // To the half point, as sizes come.
  const gap = Math.round((last.y - ideal(at)) * 2) / 2
  const versus = gap === 0 ? 'on the ideal line' : gap > 0 ? `${num(gap)} behind the ideal line` : `${num(-gap)} ahead of the ideal line`
  const of = `${num(total)} committed${addedPoints ? ` and ${num(addedPoints)} added` : ''}`
  const summary = `${pointsText(last.y)} left of ${of} on ${shortDay(last.x)}: ${versus}.`
  const spec: FlowSpec = {
    kind: 'line',
    data: [
      { id: 'ideal', data: idealData },
      { id: 'points left', data: left },
    ],
    colors: ['--ink3', '--doing'],
    format: { x: 'day' },
    dashed: ['ideal'],
    props: {
      margin: { top: 12, right: 28, bottom: 32, left: 40 },
      xScale: { type: 'time', format: '%Y-%m-%d', precision: 'day', useUTC: true, min: r.start, max: r.end },
      yScale: { type: 'linear', min: 0, max: 'auto' },
      axisBottom: { tickValues: 4, tickSize: 4, tickPadding: 6 },
      axisLeft: { tickValues: 4, tickSize: 4, tickPadding: 6 },
      enablePoints: true,
      pointSize: 6,
      useMesh: true,
      enableGridX: false,
      lineWidth: 2,
    },
  }
  return { spec, summary, legend }
}

/** A task id that opens its card on the Board, when the plan still has it (a deferred one doesn't). */
function taskRef(s: State, id: string): string {
  return s.list?.tasks.some(t => t.id === id) ? `<a href="#card-${esc(id)}">${esc(id)}</a>` : `<span class="id">${esc(id)}</span>`
}

/** A size as a badge; a screen reader hears `size M`, not a bare letter. */
const sizeTag = (size: string | undefined) => (size ? `<span class="sp-size" title="Size ${size}"><span class="vh">size </span>${size}</span>` : '')

/** Where a sprint task stands, as a glyph and words: words carry the meaning, the colour only repeats it. */
function standing(s: State, r: SprintReview, id: string): { glyph: string; cls: string; words: string } {
  const done = r.committed.done.includes(id) || r.added.done.includes(id)
  if (done) return { glyph: '✓', cls: 'g-done', words: 'done' }
  if (r.phase === 'ended') return { glyph: '○', cls: 'g-todo', words: r.committed.ids.includes(id) ? 'carries over' : 'not done' }
  const t = s.list?.tasks.find(x => x.id === id)
  if (t?.status === 'blocked' || t?.state?.status === 'blocked') return { glyph: '■', cls: 'g-blocked', words: 'blocked' }
  const st = t?.state?.status
  if (st === 'in progress' || st === 'in review' || t?.id === s.list?.current?.id) return { glyph: '●', cls: 'g-doing', words: st === 'in review' ? 'in review' : 'in progress' }
  return { glyph: '○', cls: 'g-todo', words: 'not started' }
}

function rows(s: State, r: SprintReview, ids: string[]): string {
  return `<ul class="sp-list">${ids
    .map(id => {
      const k = standing(s, r, id)
      return `<li><span class="g ${k.cls}" aria-hidden="true">${k.glyph}</span><span class="sp-t">${taskRef(s, id)} ${inline(r.tasks[id]?.title ?? '')}${sizeTag(r.tasks[id]?.size)}</span><span class="sp-st">${k.words}</span></li>`
    })
    .join('')}</ul>`
}

/** The four figures, in the Overview's shape. */
function figuresHtml(r: SprintReview): string {
  const ended = r.phase === 'ended'
  const open = r.carryOver.length
  const fig = (key: string, label: string, value: string, unit: string, sub: string) =>
    `<div class="fig f-${key}" data-figure="${key}"><dt>${label}</dt><dd><span class="v">${esc(value)}${unit ? `<span class="u">${esc(unit)}</span>` : ''}</span><span class="s">${sub}</span></dd></div>`
  const addedDone = r.added.done.length
  return `<dl class="figs">${[
    ended
      ? fig('days', 'Days left', '0', `of ${r.days}`, `ended ${shortDay(r.end)}`)
      : fig('days', 'Days left', String(r.phase === 'upcoming' ? r.days : r.daysLeft), `of ${r.days}`, r.phase === 'upcoming' ? `starts ${shortDay(r.start)}` : `ends ${shortDay(r.end)}`),
    fig('committed', 'Committed done', String(r.committed.done.length), `of ${r.committed.ids.length}`, `${num(r.committed.donePoints)} of ${esc(pointsText(r.committed.points))}`),
    fig('added', 'Added', `+${r.added.ids.length}`, '', r.added.ids.length ? `${addedDone} done` : 'nothing since the start'),
    fig('carry', ended ? 'Carry over' : 'Still open', String(open), '', open ? esc(r.carryOver.join(', ')) : '✓ all committed done'),
  ].join('')}</dl>`
}

function demoHtml(s: State, r: SprintReview): string {
  const items = [
    ...r.demo.flatMap(d => d.boxes.map(b => `<li><span class="g" aria-hidden="true">☐</span><span>${taskRef(s, d.id)} ${inline(d.title)}: ${inline(b)}</span></li>`)),
    ...r.checkpoints.map(c => `<li><span class="g" aria-hidden="true">◆</span><span>Checkpoint: ${inline(c.title)} <span class="muted">· signed off ${shortDay(c.day)}</span></span></li>`),
  ]
  return `<section class="card" aria-labelledby="sp-demo"><h3 id="sp-demo">Demo checklist</h3>${
    items.length
      ? `<p class="sp-note">The done tasks' acceptance boxes and the checkpoints signed off in the sprint: what to show.</p><ul class="sp-demo">${items.join('')}</ul>`
      : '<p class="sp-note">Nothing to show yet: the checklist fills in as the sprint\'s tasks are done.</p>'
  }</section>`
}

const half = (n: number) => num(Math.round(n * 2) / 2)
const sizeName = (size: string) => (size === 'none' ? 'unsized' : size)

/** The retro (T9) once the sprint has ended: bottlenecks in the work, never people. */
function retroHtml(r: Retro | null | undefined): string {
  if (!r) return ''
  const li = (body: string) => `<li>${body}</li>`
  const slow = r.slow.map(x => li(`<span class="id">${esc(x.id)}</span> ${inline(x.title)} (${sizeName(x.size)}) took ${x.days} d; the usual ${sizeName(x.size)} is ${half(x.usual)} d`))
  const cant = r.cantCompare.map(c => `Not compared: ${sizeName(c.size)}, ${c.done} done (${MIN_OF_SIZE} needed).`)
  const blocks = r.blocks.map(b => li(`<span class="id">${esc(b.id)}</span> ${inline(b.title)} blocked ${b.days} d (${shortDay(b.from)} – ${shortDay(b.to)})`))
  const scope = r.added.length ? `+${r.added.length} added after the start: ${r.added.map(a => `${esc(a.id)} ${inline(a.title)}`).join(', ')}.` : 'Nothing added after the start.'
  const eta = !r.drift
    ? 'Not enough history for a forecast to drift.'
    : r.drift.days === 0
      ? `Held over the sprint (${shortDay(r.drift.to)}).`
      : `${r.drift.days > 0 ? 'Slipped' : 'Moved earlier by'} ${Math.abs(r.drift.days)} d over the sprint (${shortDay(r.drift.from)} → ${shortDay(r.drift.to)}).`
  return `<section class="card sp-retro" aria-labelledby="sp-retro"><h3 id="sp-retro">Retro</h3>
<p class="sp-note">Where the time went, in the work: tasks and sizes, never people.</p>
<h4>Slow against their size</h4>${slow.length ? `<ul class="sp-plain">${slow.join('')}</ul>` : '<p class="sp-p">None over twice the usual for its size.</p>'}${cant.length ? `<p class="sp-note">${cant.join(' ')}</p>` : ''}
<h4>Longest blocks</h4>${blocks.length ? `<ul class="sp-plain">${blocks.join('')}</ul>` : '<p class="sp-p">None.</p>'}
<h4>Scope</h4><p class="sp-p">${scope}</p>
<h4>ETA</h4><p class="sp-p">${eta}</p>
</section>`
}

/** The backlog with sizes; on the live page, Pull on each item. */
function backlogHtml(s: State, live: boolean): string {
  const b = s.backlog
  const head = '<h3 id="sp-backlog">Backlog</h3>'
  if (!b || !b.items.length) {
    return `<section class="card" aria-labelledby="sp-backlog">${head}<p class="sp-note">${b ? '<code>tasks/backlog.md</code> has no items.' : 'No backlog yet.'} <code>/progress backlog add "title" S</code> adds an item; <code>/progress defer T9</code> moves a task not yet started there.</p></section>`
  }
  const items = b.items
    .map(i => {
      const was = i.was ? `<span class="muted"> · was ${esc(i.was.id)}</span>` : ''
      const pull = live ? actButton('pull', { id: i.id }, 'Pull', `Pull ${i.id} into the plan`, i.id) : ''
      return `<li><span class="sp-t"><span class="id">${esc(i.id)}</span> ${inline(i.title)}${sizeTag(i.size)}${i.size ? '' : '<span class="muted"> · no size</span>'}${was}</span>${pull}</li>`
    })
    .join('')
  return `<section class="card" aria-labelledby="sp-backlog">${head}<p class="sp-note">${plural(b.items.length, 'item')} in <code>tasks/backlog.md</code>, ${esc(pointsText(pointsOf(b.items)))}${live ? '. Pull moves an item into the plan as the next task.' : ''}</p><ul class="sp-list sp-bl">${items}</ul></section>`
}

/** The sprint length the tab proposes for: two weeks, as `/progress sprint plan` does by default. */
const PLAN_DAYS = 10

/**
 * With no sprint: that the plan runs as Kanban, then `/progress sprint plan`'s
 * proposal (T7) for two weeks: the capacity and the pace behind it, the proposed
 * tasks with sizes and the running total, what is past capacity, what isn't
 * ready and why, and the `sprint start` line to run. Words only: it writes nothing.
 * The caller puts the backlog beside the plan.
 */
function noSprintHtml(s: State): { intro: string; plan: string } {
  const list = s.list!
  const plan = sprintPlan(s, PLAN_DAYS)
  const intro = `<div class="card sp-none" role="status"><h3>No sprint running</h3><p class="sp-p">The plan runs as Kanban, the default. A sprint is optional: below is what <code>/progress sprint plan</code> proposes for ${PLAN_DAYS} working days against the team's pace, and the line that starts it.</p></div>`
  if (!plan || list.tasks.every(t => t.status === 'done')) return { intro, plan: '' }
  const item = (t: Task, tail: string) => `<li><span class="sp-t">${taskRef(s, t.id)} ${inline(t.title)}${sizeTag(t.size)}</span>${tail ? `<span class="sp-st">${tail}</span>` : ''}</li>`
  const { pace, capacity: cap } = plan
  const basis =
    pace.kind === 'pace' && cap
      ? `Capacity ≈ ${num(cap.slow)}–${esc(pointsText(cap.usual))}: pace ${pace.usual.toFixed(1)}${pace.unit === 'tasks' ? ' tasks' : ''} a day, ${pace.slow.toFixed(1)} in the slow case.`
      : `No pace yet${pace.kind === 'none' ? ` (${esc(pace.reason)})` : ''}, so by count: every ready task; keep what fits.`
  const proposed = plan.proposed.length
    ? `<ul class="sp-list">${plan.proposed.map(r => item(r.task, `${esc(pointsText(r.points))} · total ${num(r.running)}${r.fit === 'usual' ? ' · usual case only' : ''}`)).join('')}</ul>`
    : `<p class="sp-p">${cap && plan.over.length ? `Nothing ready fits in ${esc(pointsText(cap.usual))}.` : 'Nothing is ready to propose.'}</p>`
  const over = plan.over.length ? `<p class="sp-note">Ready, past capacity: ${plan.over.map(t => taskRef(s, t.id)).join(', ')}</p>` : ''
  const not = plan.notReady.length ? `<h4>Not ready <span class="n">${plan.notReady.length}</span></h4><ul class="sp-list">${plan.notReady.map(x => item(x.task, esc(x.reasons.join(', ')))).join('')}</ul>` : ''
  const start = plan.proposed.length ? `<p class="sp-start">To start it: <code>/progress sprint start ${esc(plan.end)} ${plan.proposed.map(r => esc(r.task.id)).join(' ')}</code></p>` : ''
  return {
    intro,
    plan: `<section class="card" aria-labelledby="sp-plan"><h3 id="sp-plan">Sprint plan · ${PLAN_DAYS} working days</h3><p class="sp-note">${basis}</p><h4>Proposed <span class="n">${plan.proposed.length}</span></h4>${proposed}${over}${not}${start}</section>\n`,
  }
}

export function sprintHtml(s: State, live = false): string {
  const list = s.list
  if (!list || list.total === 0) return '<div class="card empty" role="status"><h3>No task list yet</h3><p>The Sprint tab reads <code>tasks/todo.md</code>: a sprint\'s dates and committed tasks, or, without one, what is ready to plan.</p></div>'
  if (!s.sprint) {
    // The intro full width, then the plan and the backlog side by side.
    const { intro, plan } = noSprintHtml(s)
    return `${intro}\n<div class="sp-cols">\n${plan}${backlogHtml(s, live)}\n</div>`
  }
  const r = sprintReview(s.sprint, list, s.sprintCopies ?? [], s.today)
  const when = r.phase === 'ended' ? `ended ${shortDay(r.end)}` : r.phase === 'upcoming' ? `starts ${shortDay(r.start)} · ${plural(r.days, 'working day')}` : `${r.daysLeft} of ${plural(r.days, 'working day')} left`
  const chart = burndownChart(s, r)
  const chartBody = chart.spec
    ? `${chartMount(chart.spec, chart.summary)}
<ul class="flow-legend" aria-hidden="true">${chart.legend.map(l => `<li><span class="g k${l.token.slice(1)}">${l.glyph}</span> ${esc(l.label)}</li>`).join('')}</ul>`
    : `<p class="flow-needs">${esc(chart.summary)}</p>`
  const added = r.added.ids.length ? `<h4>Added since the start <span class="n">${r.added.ids.length}</span></h4>${rows(s, r, r.added.ids)}` : ''
  const gone = r.gone.length ? `<p class="sp-note">Deferred to the backlog since the start: ${r.gone.map(esc).join(', ')}.</p>` : ''
  return `<p class="sp-lead">Sprint <strong>${shortDay(r.start)} – ${shortDay(r.end)}</strong> · ${when}</p>
${figuresHtml(r)}
<div class="sp-cols">
<section class="card flow-chart" aria-labelledby="sp-burn"><h3 id="sp-burn">Burn-down</h3>
${chartBody}</section>
<section class="card" aria-labelledby="sp-scope"><h3 id="sp-scope">Scope</h3><h4>Committed <span class="n">${r.committed.ids.length}</span></h4>${r.committed.ids.length ? rows(s, r, r.committed.ids) : '<p class="sp-p">Nothing committed.</p>'}${added}${gone}</section>
${demoHtml(s, r)}
${retroHtml(r.phase === 'ended' ? s.retro : null)}${backlogHtml(s, live)}
</div>`
}

/** This view's CSS, added to the page's stylesheet: the page's tokens, light and dark, one column at 860 px. */
export const SPRINT_STYLE = `
.sp-lead{margin:0 0 var(--s4);font-size:15px}
#view-sprint .figs{margin-bottom:var(--s4)}
.sp-cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s4);align-items:start}
.sp-cols>.card{min-width:0}
#view-sprint h4{font-size:12px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em;margin:var(--s4) 0 var(--s2)}
#view-sprint h3+h4,#view-sprint h3+.sp-note+h4{margin-top:0}
#view-sprint h4 .n{color:var(--ink3);font-weight:500}
.sp-list,.sp-demo,.sp-plain{list-style:none;margin:0;padding:0}
.sp-list li,.sp-demo li{display:flex;align-items:baseline;gap:var(--s2);padding:var(--s1) 0;border-top:1px solid var(--line);min-width:0}
.sp-list li:first-child,.sp-demo li:first-child{border-top:0}
.sp-list .g,.sp-demo .g{font-weight:700;flex:none}.sp-demo .g{color:var(--ink3)}
.sp-t{flex:1;min-width:0;overflow-wrap:anywhere}.sp-t .id,.sp-t a{font-weight:600;color:var(--ink2);font-variant-numeric:tabular-nums}
.sp-st{flex:none;font-size:12.5px;color:var(--ink2);text-align:right;max-width:50%}
.sp-size{display:inline-block;margin-left:var(--s2);padding:0 6px;border:1px solid var(--line2);border-radius:999px;font-size:11.5px;color:var(--ink2);line-height:1.5}
.sp-plain li{padding:2px 0;overflow-wrap:anywhere}.sp-plain .id{font-weight:600;color:var(--ink2)}
.sp-note{margin:0 0 var(--s2);color:var(--ink2);font-size:13px}
.sp-p{margin:0;overflow-wrap:anywhere}
.sp-bl li{align-items:center}
.sp-none{margin-bottom:var(--s4)}
.sp-start{margin:var(--s3) 0 0;padding-top:var(--s3);border-top:1px solid var(--line);font-size:13px;color:var(--ink2);overflow-wrap:anywhere}
@media (max-width:860px){.sp-cols{grid-template-columns:1fr}}
`
