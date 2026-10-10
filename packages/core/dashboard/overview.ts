// The Overview (K1): is it on track, when will it land, what needs me. Four
// figures (the same ones the charts tab shows), tasks by state as a bar named in
// words, then what is waiting on a person beside what is under way now. Pure.

import { shortDay } from '../forecast'
import { headline, nowCounts } from '../report'
import type { State } from '../state'
import { esc, inline, plainInline, plural } from './html'

export function overviewHtml(s: State): string {
  const list = s.list
  if (!list || list.total === 0) return emptyHtml(s)

  const figs = headline({ spec: s.spec, list, plan: s.plan, forecast: s.forecast, snapshots: s.snapshots, specFile: s.specFile })
  const keys = ['done', 'forecast', 'scope', 'needs']
  const figures = figs
    .map(
      (f, i) => `<div class="fig f-${keys[i]}${keys[i] === 'needs' && f.value === '0' ? ' zero' : ''}" data-figure="${keys[i]}">
<dt>${esc(f.label)}</dt>
<dd><span class="v">${esc(f.value)}${f.unit ? `<span class="u">${esc(f.unit)}</span>` : ''}</span><span class="s" title="${esc(plainInline(f.sub))}">${esc(plainInline(f.sub))}</span></dd>
</div>`,
    )
    .join('')

  const fc = s.forecast
  const basis =
    fc?.kind === 'range'
      ? `Forecast ${fc.basis}: fast ${shortDay(fc.optimistic)}, likely ${shortDay(fc.median)}, slow ${shortDay(fc.slow)}.`
      : fc?.kind === 'not-enough'
        ? `No forecast yet: ${fc.reason}.`
        : ''

  return `<dl class="figs">${figures}</dl>
${basis ? `<p class="basis">${esc(basis)}</p>` : ''}
${statesHtml(s)}
<div class="cols">
<div class="card"><h3>Needs you</h3>${needsHtml(s)}</div>
<div class="card"><h3>Now</h3>${nowHtml(s)}</div>
</div>`
}

/** Tasks by state: a bar for the eye, a legend with glyphs and counts for everyone. */
function statesHtml(s: State): string {
  const c = nowCounts(s.list!)
  const parts = [
    { n: c.done, k: 'done', g: '✓', label: 'done' },
    { n: c.doing, k: 'doing', g: '●', label: 'in progress' },
    { n: c.blocked, k: 'blocked', g: '■', label: 'blocked' },
    { n: c.todo, k: 'todo', g: '○', label: 'to do' },
  ]
  const words = parts.map(p => `${p.n} ${p.label}`).join(', ')
  return `<div class="states">
<div class="bar" role="img" aria-label="${words}">${parts.map(p => (p.n ? `<span class="b-${p.k}" style="flex:${p.n}"></span>` : '')).join('')}</div>
<ul class="legend" aria-hidden="true">${parts.map(p => `<li><span class="g g-${p.k}">${p.g}</span> ${p.n} ${p.label}</li>`).join('')}</ul>
</div>`
}

function needsHtml(s: State): string {
  if (!s.needsYou.length) return '<p class="good">✓ Nothing is waiting on you.</p>'
  return `<ul class="needs">${s.needsYou.map(n => `<li><span class="g" aria-hidden="true">♦</span><span>${inline(n)}</span></li>`).join('')}</ul>`
}

function nowHtml(s: State): string {
  const list = s.list!
  const t = list.current
  if (!t) {
    return list.done === list.total
      ? '<p class="good">✓ Every task is done. Next stage: review.</p>'
      : '<p class="muted">Nothing can start: every open task waits on a dependency or a decision.</p>'
  }
  const st = t.state
  const meta = [
    t.phase,
    st?.status === 'in progress' && st.started ? `started ${shortDay(st.started)}${st.step ? ` · step ${st.step}` : ''}` : 'next up',
    `${plural(t.boxes.filter(b => !b.isDone).length, 'box', 'boxes')} open`,
  ].filter(Boolean)
  const boxes = t.boxes
    .map(b => `<li class="${b.isDone ? 'done' : ''}"><span class="g" aria-hidden="true">${b.isDone ? '✓' : '☐'}</span><span>${b.isDone ? '<span class="vh">Done: </span>' : ''}${inline(b.text)}</span></li>`)
    .join('')
  const after = t.checkpoint ? `<p class="after">◆ Checkpoint after this task: ${esc(t.checkpoint.title)}</p>` : ''
  return `<p class="now-title"><span class="id">${esc(t.id)}</span>${inline(t.title)}</p>
<p class="now-meta">${meta.map(m => esc(m!)).join(' · ')}</p>
<ul class="boxes">${boxes}</ul>${after}`
}

/** No task list: say what the page will show and how to get there. */
function emptyHtml(s: State): string {
  const spec = s.spec ? `<p><code>${esc(s.specFile ?? 'SPEC.md')}</code> is here; planning turns it into tasks.</p>` : ''
  return `<div class="card empty" role="status">
<h3>No task list yet</h3>
<p>agent-skills writes <code>tasks/todo.md</code> when you plan the work (its <code>/plan</code> step). Once that file exists, this page shows progress, the forecast and what needs you.</p>
${spec}
</div>`
}
