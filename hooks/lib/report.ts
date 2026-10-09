// Progress for people outside the session (G1, G2): a four-line digest to paste
// into Slack, and the headline figures the HTML report shares with it. Pure.

import { daily } from './chart'
import { shortDay, type Forecast, type Snapshot } from './forecast'
import type { PlanDoc, Spec, TaskList } from './parse'
import { forecastText, specApproval } from './view'

export type ProgressInput = {
  spec: Spec | null
  list: TaskList | null
  plan: PlanDoc | null
  forecast: Forecast | null
  snapshots: Snapshot[]
  specFile?: string | null
}

const SPARK = '▁▂▃▄▅▆▇█'

/** One bar per day, scaled between the week's lowest and highest. */
export function sparkline(values: number[]): string {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  return values.map(v => SPARK[hi === lo ? 0 : Math.round(((v - lo) / (hi - lo)) * (SPARK.length - 1))]).join('')
}

/** The last 7 days of the history: done per day, and what changed since the day before them. */
export function week(snapshots: Snapshot[]): { days: Snapshot[]; done: number; added: number } | null {
  const series = daily(snapshots)
  const last = series[series.length - 1]
  if (!last || series.length < 2) return null
  const days = series.slice(-7)
  const before = series[series.length - days.length - 1] ?? days[0]!
  return { days, done: last.done - before.done, added: Math.max(0, last.total - before.total) }
}

/** What is waiting on a person: checkpoints reached, open questions in the plan and in an unapproved spec. */
export function decisions(p: ProgressInput): string[] {
  const out: string[] = []
  for (const t of p.list?.tasks ?? []) {
    const cp = t.checkpoint
    if (cp && t.status === 'done' && !(cp.items.length > 0 && cp.items.every(b => b.isDone))) out.push(`checkpoint ${cp.title}`)
  }
  for (const q of p.plan?.openQuestions ?? []) out.push(q)
  if (p.spec && specApproval(p.spec, !!p.list) !== 'approved') {
    out.push(`approve ${p.specFile ?? 'SPEC.md'}`)
    for (const q of p.spec.openQuestions) out.push(q)
  }
  return out
}

/** `/progress digest` (G2): progress, forecast, this week, and what needs a decision. */
export function digestText(p: ProgressInput): string {
  const list = p.list
  const name = p.spec?.title ?? 'Plan'
  if (!list || list.total === 0) return `${name}: no task list yet.`
  const pct = Math.round((list.done / list.total) * 100)
  const now = list.current ? ` · now ${list.current.id} ${list.current.title}` : ''
  const w = week(p.snapshots)
  const weekLine = w
    ? `This week ${sparkline(w.days.map(d => d.done))} +${w.done} done${w.added ? `, +${w.added} added` : ''} (${shortDay(w.days[0]!.day)}–${shortDay(w.days[w.days.length - 1]!.day)})`
    : 'This week: not enough history yet.'
  const asks = decisions(p)
  return [
    `${name}: ${list.done}/${list.total} tasks done (${pct}%)${now}`,
    p.forecast ? forecastText(p.forecast) : 'ETA: no forecast yet.',
    weekLine,
    asks.length ? `Needs a decision: ${asks.join('; ')}` : 'Nothing needs a decision.',
  ].join('\n')
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const DAY_MS = 86_400_000
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)

export type ReportInput = ProgressInput & {
  /** By task id: the day each was done, or expected (`isEstimate`). */
  dates: Record<string, { day: string; isEstimate: boolean }>
  /** The day the report is written. */
  today: string
  charts: { burnup: { source: string; alt: string } | null; flow: { source: string; alt: string } | null }
  /** Where the history comes from, in a sentence (historyNote). */
  historyLine?: string
}

/**
 * Days each done task took, in the order they were done: from the task done
 * before it, or from the start of the history. Null for a task already done
 * when the history starts: how long it took is not known.
 */
export function daysPerTask(p: ReportInput): { id: string; title: string; day: string; days: number | null }[] {
  const start = p.snapshots[0]?.day
  const done = (p.list?.tasks ?? [])
    .map(t => ({ t, d: p.dates[t.id] }))
    .filter((x): x is { t: (typeof x)['t']; d: { day: string; isEstimate: boolean } } => x.t.status === 'done' && !!x.d && !x.d.isEstimate)
    .sort((a, b) => a.d.day.localeCompare(b.d.day))
  let prev = start ?? done[0]?.d.day ?? p.today
  return done.map(({ t, d }) => {
    const days = start && d.day <= start ? null : Math.max(0, dayDiff(prev, d.day))
    prev = d.day
    return { id: t.id, title: t.title, day: d.day, days }
  })
}

/** `/progress report` (G1): one self-contained page, no external requests, readable offline and in either theme. */
export function reportHtml(p: ReportInput): string {
  const list = p.list
  const name = p.spec?.title ?? 'Plan'
  const total = list?.total ?? 0
  const done = list?.done ?? 0
  const last = p.snapshots[p.snapshots.length - 1]
  const first = p.snapshots[0]
  const doing = last?.doing ?? 0
  const blocked = last?.blocked ?? 0
  const todo = Math.max(0, total - done - doing - blocked)
  const fc = p.forecast
  const span = first && last ? dayDiff(first.day, last.day) : 0
  const pace = first && last && span >= 2 ? ((last.done - first.done) / span) * 7 : null

  const figure = (k: string, v: string, s: string) => `<div class="fig"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span><span class="s">${esc(s)}</span></div>`
  const figures = [
    figure('Done', `${done}/${total}`, total ? `${Math.round((done / total) * 100)}% of tasks` : 'no tasks yet'),
    fc?.kind === 'range'
      ? figure('ETA', shortDay(fc.median), `${shortDay(fc.optimistic)} to ${shortDay(fc.slow)}`)
      : figure('ETA', fc?.kind === 'done' ? 'done' : '—', fc?.kind === 'not-enough' ? fc.reason : fc?.kind === 'done' ? 'every task is done' : 'no forecast'),
    figure('Pace', pace === null ? '—' : `${Math.round(pace * 10) / 10}/wk`, pace === null ? 'needs 2 days of history' : `tasks done per week since ${shortDay(first!.day)}`),
    figure('Scope', first && last ? `+${Math.max(0, last.total - first.total)}` : '—', first ? `tasks added since ${shortDay(first.day)}` : 'no history'),
  ].join('')

  const seg = (n: number, cls: string, label: string) => (n > 0 ? `<span class="${cls}" style="flex:${n}" title="${n} ${label}"></span>` : '')
  const nowBar = total
    ? `<div class="now">${seg(done, 'f-done', 'done')}${seg(doing, 'f-doing', 'in progress')}${seg(blocked, 'f-blocked', 'blocked')}${seg(todo, 'f-todo', 'to do')}</div>
<p class="legend"><span class="sw f-done"></span>done ${done} <span class="sw f-doing"></span>in progress ${doing} <span class="sw f-blocked"></span>blocked ${blocked} <span class="sw f-todo"></span>to do ${todo}</p>`
    : ''

  const per = daysPerTask(p)
  const most = Math.max(1, ...per.map(d => d.days ?? 0))
  const row = (d: (typeof per)[number]) =>
    d.days === null
      ? `<tr><th>${esc(d.id)}</th><td class="t">${esc(d.title)}</td><td class="bar muted">done before tracking</td><td class="n">—</td><td class="d">by ${shortDay(d.day)}</td></tr>`
      : `<tr><th>${esc(d.id)}</th><td class="t">${esc(d.title)}</td><td class="bar"><span style="width:${Math.round((d.days / most) * 100)}%"></span></td><td class="n">${d.days} d</td><td class="d">${shortDay(d.day)}</td></tr>`
  const perRows = per.length ? `<table class="per">${per.map(row).join('')}</table>` : '<p class="muted">No task finished yet.</p>'

  const asks = decisions(p)
  const current = list?.current ? `<p><b>Now:</b> ${esc(list.current.id)} ${esc(list.current.title)}</p>` : ''
  const chart = (title: string, sub: string, c: { source: string; alt: string } | null) =>
    c ? `<section><h2>${esc(title)} <span class="muted">${esc(sub)}</span></h2><figure>${c.source}<figcaption>${esc(c.alt)}</figcaption></figure></section>` : ''

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} progress</title>
<style>
:root{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--line:#e6e5e0;--done:#0ca30c;--doing:#c98a00;--blocked:#d03b3b;--todo:#d9d8d3;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--line:#33332f;--done:#3fbf5a;--doing:#fab219;--blocked:#ff6b5e;--todo:#4a4a46}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.6rem;margin:0}h2{font-size:1.05rem;margin:32px 0 8px}.muted,.s,figcaption{color:var(--ink2)}
.figs{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}.fig{display:grid;gap:2px;min-width:0}
.k{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ink2)}.v{font-size:1.5rem;font-weight:700;font-variant-numeric:tabular-nums}.s{font-size:.8rem}
.now{display:flex;height:14px;border-radius:4px;overflow:hidden;gap:2px}.f-done{background:var(--done)}.f-doing{background:var(--doing)}.f-blocked{background:var(--blocked)}.f-todo{background:var(--todo)}
.legend{font-size:.85rem}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px;vertical-align:-1px}.sw:first-child{margin-left:0}
figure{margin:0}svg{max-width:100%;height:auto}figcaption{font-size:.8rem;margin-top:4px}
.per{border-collapse:collapse;width:100%;font-size:.9rem}.per th,.per td{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left}
.per .t{width:40%}.per .bar{width:30%}.per .bar span{display:block;height:8px;border-radius:2px;background:var(--done);min-width:2px}.per .n,.per .d{white-space:nowrap;color:var(--ink2);font-variant-numeric:tabular-nums}
ul{padding-left:20px}footer{margin-top:40px;font-size:.8rem;color:var(--ink2)}
@media (max-width:560px){.figs{grid-template-columns:1fr 1fr}}
</style></head>
<body><main>
<h1>${esc(name)}</h1>
<p class="muted">Progress report, ${shortDay(p.today)} ${p.today.slice(0, 4)}</p>
<div class="figs">${figures}</div>
${nowBar}
${current}
${
  p.charts.burnup || p.charts.flow
    ? chart('Burn-up', 'scope vs done, dashed = forecast', p.charts.burnup) + chart('Flow', 'tasks by state, per day', p.charts.flow)
    : `<section><h2>Charts</h2><p class="muted">The burn-up and flow charts need two days of history${first ? `; tracking began ${shortDay(first.day)}` : ''}.</p></section>`
}
<section><h2>Days per task</h2>${perRows}</section>
<section><h2>Needs a decision</h2>${asks.length ? `<ul>${asks.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : '<p class="muted">Nothing.</p>'}</section>
<footer>Written by agent-skills-mods from ${esc(p.specFile ?? 'SPEC.md')} and the task list.${p.historyLine ? ` ${esc(p.historyLine)}` : ''}${p.charts.burnup ? " Hover a chart for each day's numbers." : ''}</footer>
</main></body></html>
`
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * `/progress standup`: what was done since the last working day, what is in
 * progress today, what is blocked and what needs a decision.
 */
export function standupText(p: ProgressInput & { dates: Record<string, { day: string; isEstimate: boolean }> }, today: string): string {
  const list = p.list
  const name = list?.meta?.plan ?? p.spec?.title ?? 'Plan'
  const d = new Date(`${today}T00:00:00Z`)
  const head = `Standup · ${name} · ${WEEKDAY[d.getUTCDay()]} ${shortDay(today)}`
  if (!list || list.total === 0) return `${head}\nNo task list yet.`
  // Since the last working day: Friday on a Monday.
  const back = d.getUTCDay() === 1 ? 3 : d.getUTCDay() === 0 ? 2 : 1
  const since = new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10)
  const done = list.tasks.filter(t => t.status === 'done' && p.dates[t.id] && !p.dates[t.id]!.isEstimate && p.dates[t.id]!.day >= since)
  const doing = list.tasks.filter(t => t.status !== 'done' && (t.id === list.current?.id || t.state?.status === 'in progress'))
  const blocked = list.tasks.filter(t => t.status === 'blocked')
  const lines = [head]
  lines.push(done.length ? `Done since ${shortDay(since)}: ${done.map(t => `${t.id} ${t.title}`).join('; ')}` : `Done since ${shortDay(since)}: nothing finished`)
  lines.push(
    doing.length
      ? `Today: ${doing
          .map(t => {
            const left = t.boxes.filter(b => !b.isDone).length
            return `${t.id} ${t.title} (${t.state?.step ? `${t.state.step}, ` : ''}${left} box${left === 1 ? '' : 'es'} left)`
          })
          .join('; ')}`
      : list.done === list.total
        ? 'Today: all tasks done, review and ship'
        : 'Today: nothing under way',
  )
  if (blocked.length) lines.push(`Blocked: ${blocked.map(t => `${t.id} ${t.title}${t.blockedBy ? `, ${t.blockedBy.replace(/^[^:]+\.md: /, '')}` : ''}`).join('; ')}`)
  const needs = decisions(p)
  if (needs.length) lines.push(`Needs a decision: ${needs.join('; ')}`)
  lines.push(`Progress: ${list.done}/${list.total} tasks${p.forecast?.kind === 'range' ? ` · ETA ${shortDay(p.forecast.median)}` : ''}`)
  return lines.join('\n')
}

// ------------------------------------------------------------------ headline figures (desktop mockup)

export type Figure = { label: string; value: string; unit?: string; sub: string }

/** The four figures over the charts: done, forecast, scope change, needs a decision. */
export function headline(p: ProgressInput): Figure[] {
  const list = p.list
  const fc = p.forecast
  const first = p.snapshots[0]
  const added = list && first ? list.total - first.total : 0
  const needs = decisions(p)
  return [
    { label: 'Done', value: String(list?.done ?? 0), unit: `of ${list?.total ?? 0}`, sub: list && list.total ? `${Math.round((list.done / list.total) * 100)}%` : 'no tasks yet' },
    fc?.kind === 'range'
      ? { label: 'Forecast', value: `≈ ${shortDay(fc.median)}`, sub: `range ${shortDay(fc.optimistic)}–${shortDay(fc.slow)}` }
      : { label: 'Forecast', value: fc?.kind === 'done' ? 'done' : '—', sub: fc?.kind === 'not-enough' ? 'needs 3 tasks done' : fc?.kind === 'done' ? 'all tasks done' : 'no history yet' },
    { label: 'Scope change', value: `${added > 0 ? '+' : ''}${added}`, unit: 'tasks', sub: first ? `since ${shortDay(first.day)}` : 'since today' },
    { label: 'Needs a decision', value: String(needs.length), sub: needs[0] ?? 'nothing waiting' },
  ]
}

/** Tasks by state now, for the now-bar: done, in progress, blocked, to do (waiting counts as to do). */
export function nowCounts(list: TaskList): { done: number; doing: number; blocked: number; todo: number } {
  const done = list.tasks.filter(t => t.status === 'done').length
  const doing = list.tasks.filter(t => t.status !== 'done' && t.status !== 'blocked' && (t.id === list.current?.id || t.state?.status === 'in progress')).length
  const blocked = list.tasks.filter(t => t.status === 'blocked').length
  return { done, doing, blocked, todo: list.total - done - doing - blocked }
}

/**
 * Days per task for the bars under the charts: from Status-line dates where
 * the task has them, else from the order tasks were done; the current task
 * with its days so far.
 */
export function taskDays(p: ReportInput): { id: string; title: string; days: number; isRunning: boolean }[] {
  const list = p.list
  if (!list) return []
  const fromOrder = new Map(daysPerTask(p).map(x => [x.id, x.days]))
  const out: { id: string; title: string; days: number; isRunning: boolean }[] = []
  for (const t of list.tasks) {
    const st = t.state
    if (t.status === 'done') {
      const d = st?.started && st.done ? dayDiff(st.started, st.done) : fromOrder.get(t.id)
      if (d !== null && d !== undefined) out.push({ id: t.id, title: t.title, days: Math.max(0, d), isRunning: false })
    } else if (st?.status === 'in progress' && st.started) {
      out.push({ id: t.id, title: t.title, days: Math.max(0, dayDiff(st.started, p.today)), isRunning: true })
    }
  }
  return out
}
