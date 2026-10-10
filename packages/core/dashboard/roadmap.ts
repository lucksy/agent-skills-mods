// The Roadmap (K3): what is the path to done? The run timeline as the plan pane
// and `agent-skills-progress --timeline` draw it, then the dependency tree with
// the critical path (the longest chain of open tasks, which sets the finish
// date) named and marked. Rows keep their monospace alignment and each
// segment's tone becomes a class, so colour matches the terminal. Pure.

import { criticalPath, graphLines } from '../graph'
import { timeline, type Line } from '../timeline'
import type { State } from '../state'
import { esc } from './html'

/** A row of segments as HTML: text escaped, tone as a class, spaces kept by `white-space: pre`. */
function row(line: Line, cls: string, extra = ''): string {
  return `<div class="${cls}-row${extra}">${line.map(seg => (seg.tone === 'text' ? esc(seg.text) : `<span class="t-${seg.tone}">${esc(seg.text)}</span>`)).join('')}</div>`
}

export function roadmapHtml(s: State): string {
  const list = s.list
  if (!list || list.total === 0) return '<div class="card empty" role="status"><h3>No task list yet</h3><p>The roadmap fills in once <code>tasks/todo.md</code> exists.</p></div>'

  const t = timeline({
    spec: s.spec,
    list,
    plan: s.plan,
    forecast: s.forecast,
    dates: s.dates,
    today: s.today,
    since: s.snapshots[0]?.day,
    facts: s.commits !== undefined ? { commits: s.commits } : undefined,
  })
  const timelineRows = [...t.header, [], ...t.rows, [], ...t.legend].map(l => row(l, 'tl')).join('')

  const path = criticalPath(list)
  const onPath = new Set(path)
  const deps = graphLines(list)
    // A row that only points back to a task drawn above is an edge off the path, not the task.
    .map(l => row(l, 'dep', l.some(seg => seg.tone === 'strong' && onPath.has(seg.text)) && !l.some(seg => seg.text === ' (drawn above)') ? ' crit' : ''))
    .join('')
  const pathLine = path.length
    ? `<p class="crit-line"><b>Critical path</b> <span class="crit-ids">${path.map(esc).join(' → ')}</span> · ${path.length === 1 ? '1 open task sets' : `${path.length} open tasks set`} the finish date</p>`
    : '<p class="crit-line good">✓ Every task is done: nothing left on the critical path.</p>'

  return `<div class="card road">
<h3>Run timeline</h3>
<div class="mono tl" role="group" aria-label="Run timeline: phases, tasks and their build, test and commit steps">${timelineRows}</div>
</div>
<div class="card road">
<h3>Dependencies</h3>
${pathLine}
<div class="mono deps" role="group" aria-label="Dependency tree: each task under the one it waits on">${deps}</div>
</div>`
}

/** This view's CSS, added to the page's stylesheet. Tones as the terminal paints them. */
export const ROADMAP_STYLE = `
.road+.road{margin-top:var(--s4)}
.mono{font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto;padding-bottom:var(--s1)}
.tl-row,.dep-row{white-space:pre;min-height:1.6em}
.t-strong{font-weight:700;color:var(--ink)}.t-muted{color:var(--ink3)}.t-done{color:var(--done)}.t-run{color:var(--doing)}
.t-bad{color:var(--blocked)}.t-needsYou{color:var(--needs)}.t-accent{color:var(--focus)}
.crit-line{margin:0 0 var(--s3);font-size:13px;color:var(--ink2)}
.crit-line b{color:var(--ink);margin-right:var(--s1)}
.crit-ids{font-weight:600;color:var(--doing)}
.dep-row.crit{background:color-mix(in srgb,var(--doing) 12%,transparent);border-radius:3px}
`
