// The dashboard page (K6): one self-contained HTML file built from State v1.
// Views are rendered here, in TypeScript; the inline script only turns them into
// tabs with a #view hash. Without it every view shows, stacked, under its heading.
// No external requests (a CSP forbids them), light and dark, deterministic. Pure.

import { shortDay } from '../forecast'
import { stateJson, type State } from '../state'
import { specApproval } from '../view'
import { boardHtml } from './board'
import { FLOW_STYLE, flowHtml } from './flow'
import { overviewHtml } from './overview'
import { ROADMAP_STYLE, roadmapHtml } from './roadmap'
import { SPEC_STYLE, specHtml } from './spec'
import { CHARTS_JS } from './charts-bundle'
import { chartMount, esc, type ChartSpec } from './html'

export { chartMount, type ChartSpec }

export type ViewId = 'overview' | 'board' | 'roadmap' | 'flow' | 'spec'

/** The views in tab order. A view joins this list when it is built. */
const VIEWS: { id: ViewId; label: string; render: (s: State) => string }[] = [
  { id: 'overview', label: 'Overview', render: overviewHtml },
  { id: 'board', label: 'Board', render: boardHtml },
  { id: 'roadmap', label: 'Roadmap', render: roadmapHtml },
  { id: 'flow', label: 'Flow', render: flowHtml },
  { id: 'spec', label: 'Spec', render: specHtml },
]

/** The views a page can open on, in tab order. */
export const VIEW_IDS: readonly ViewId[] = VIEWS.map(v => v.id)

const CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:`

/** The project's name: the spec's title, else the plan's, else a plain word. */
export function projectName(s: State): string {
  return s.spec?.title ?? s.list?.meta?.plan ?? 'Project'
}

/** The five workflow stages with where this project stands in each, as the status line shows them. */
export function stages(s: State): { label: string; glyph: string; tone: 'done' | 'now' | 'needs' | 'todo' }[] {
  const approval = specApproval(s.spec, !!s.list)
  const list = s.list
  const allDone = !!list && list.total > 0 && list.done === list.total
  return [
    approval === 'approved' ? { label: 'spec', glyph: '✓', tone: 'done' } : approval === 'awaiting' ? { label: 'spec', glyph: '♦', tone: 'needs' } : { label: 'spec', glyph: '○', tone: 'todo' },
    list ? { label: 'plan', glyph: '✓', tone: 'done' } : { label: 'plan', glyph: '○', tone: 'todo' },
    list && list.total > 0 ? (allDone ? { label: 'build', glyph: '✓', tone: 'done' } : { label: `build ${list.done}/${list.total}`, glyph: '●', tone: 'now' }) : { label: 'build', glyph: '○', tone: 'todo' },
    allDone ? { label: 'review', glyph: '●', tone: 'now' } : { label: 'review', glyph: '○', tone: 'todo' },
    { label: 'ship', glyph: '○', tone: 'todo' },
  ]
}

/** A note as one sentence: a capital first, one full stop last (the CLI's notes have neither, the plugin's both). */
const sentence = (note: string) => `${note.charAt(0).toUpperCase()}${note.slice(1).replace(/\.+$/, '')}.`


/** The chart bundle, only for a page that has a chart: a page without one stays small. */
export function chartsScript(body: string): string {
  return body.includes('data-chart="') ? `<script>${CHARTS_JS}</script>` : ''
}

/** JSON safe inside a script block: no `<`, so it cannot close the block or open a comment. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

/** The page for `state`, opening on `view` unless the address names another. */
export function dashboardHtml(s: State, opts: { view?: ViewId } = {}): string {
  const view = VIEWS.some(v => v.id === opts.view) ? opts.view! : 'overview'
  const name = projectName(s)
  const sources = [s.specFile, s.listFile].filter((f): f is string => !!f)
  const asOf = `${shortDay(s.today)} ${s.today.slice(0, 4)}`
  const stageItems = stages(s)
    .map(st => `<li class="stage t-${st.tone}"><span aria-hidden="true">${st.glyph}</span> ${esc(st.label)}${st.tone === 'needs' ? '<span class="vh"> (awaiting approval)</span>' : ''}</li>`)
    .join('')
  const tabs = VIEWS.map(v => `<a role="tab" id="tab-${v.id}" href="#${v.id}" aria-controls="view-${v.id}">${v.label}</a>`).join('')
  const panels = VIEWS.map(
    v => `<section id="view-${v.id}" role="tabpanel" aria-labelledby="tab-${v.id}" tabindex="-1">
<h2 class="view-title">${v.label}</h2>
${v.render(s)}
</section>
<!-- /view-${v.id} -->`,
  ).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(name)} · dashboard</title>
<style>${STYLE}</style>
</head>
<body data-view="${view}">
<a class="skip" href="#main">Skip to the dashboard</a>
<header class="top">
<div class="wrap head">
<div class="id">
<h1>${esc(name)}</h1>
<p class="sub">Dashboard · as of ${asOf}${sources.length ? ` · from ${sources.map(f => `<code>${esc(f)}</code>`).join(' and ')}` : ''}</p>
</div>
<ol class="stages" aria-label="Workflow stage">${stageItems}</ol>
</div>
<nav class="tabs" aria-label="Views"><div class="wrap" role="tablist">${tabs}</div></nav>
</header>
<main id="main" class="wrap">
${panels}
</main>
<footer class="wrap foot">Built by agent-skills-mods from the project's markdown.${s.history ? ` ${esc(sentence(s.history))}` : ''} The data behind this page is embedded as JSON (State v1).</footer>
<script type="application/json" id="asm-state">${scriptJson(stateJson(s))}</script>
<script>${DASHBOARD_SCRIPT}</script>
${chartsScript(panels)}
</body>
</html>
`
}

/**
 * Tabs over the views: the hash names the view (`#overview`; later `#board?phase=2`),
 * so a link opens it and Back returns; arrow keys, Home and End move between tabs.
 */
export const DASHBOARD_SCRIPT = `(() => {
  const d = document, b = d.body, $ = id => d.getElementById(id)
  const tabs = [...d.querySelectorAll('[role=tab]')]
  const ids = tabs.map(t => t.getAttribute('href').slice(1))
  const parse = h => { const [v, q = ''] = h.slice(1).split('?'); return [v, new URLSearchParams(q)] }
  b.classList.add('js')
  // The Board's filters and lanes, read from and written to #board?phase=&state=&group=phase.
  const ph = $('board-phase'), st = $('board-state'), gr = $('board-group'), ow = $('board-owner')
  const board = q => {
    if (!ph) return
    ph.value = q.get('phase') || ''
    st.value = q.get('state') || ''
    if (ow) ow.value = q.get('owner') || ''
    if (gr) gr.checked = q.get('group') === 'phase'
    b.classList.toggle('grouped', !!gr && gr.checked)
    for (const el of $('view-board').querySelectorAll('[data-state]'))
      el.hidden = (!!ph.value && el.dataset.phase !== ph.value) || (!!st.value && el.dataset.state !== st.value) || (!!ow && !!ow.value && el.dataset.owner !== (ow.value === '-' ? '' : ow.value))
    for (const c of $('view-board').querySelectorAll('.col'))
      c.querySelector('.n').textContent = c.querySelectorAll('[data-task]:not([hidden])').length
  }
  const write = () => {
    const q = new URLSearchParams()
    if (ph.value) q.set('phase', ph.value)
    if (st.value) q.set('state', st.value)
    if (ow && ow.value) q.set('owner', ow.value)
    if (gr && gr.checked) q.set('group', 'phase')
    location.hash = 'board' + (String(q) ? '?' + q : '')
  }
  for (const c of [ph, st, gr, ow]) if (c) c.addEventListener('change', write)
  const show = h => {
    let [id, q] = parse(h)
    // #spec-<file> is a spec in the Spec view's picker: open that view, mark the spec chosen.
    const pick = id.startsWith('spec-') ? id : ''
    if (pick) id = 'spec'
    for (const a of d.querySelectorAll('.spec-pick a[href^="#spec-"]'))
      a.getAttribute('href') === '#' + pick ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')
    if (!ids.includes(id)) id = ids.includes(b.dataset.view) ? b.dataset.view : ids[0]
    for (const t of tabs) {
      const on = t.getAttribute('href') === '#' + id
      t.setAttribute('aria-selected', String(on))
      t.tabIndex = on ? 0 : -1
    }
    for (const v of ids) $('view-' + v).hidden = v !== id
    b.dataset.view = id
    board(id === 'board' ? q : new URLSearchParams())
  }
  addEventListener('hashchange', () => show(location.hash))
  tabs.forEach((t, i) => t.addEventListener('keydown', e => {
    const n = tabs.length
    const j = { ArrowRight: i + 1, ArrowLeft: i - 1 + n, Home: 0, End: n - 1 }[e.key]
    if (j === undefined) return
    e.preventDefault()
    location.hash = ids[j % n]
    tabs[j % n].focus()
  }))
  show(location.hash)
})()`

/**
 * Tokens first, light then dark; the palette is the report's, so the two pages
 * read as one product. Spacing on a 4px scale, one radius, borders not shadows.
 */
const STYLE = `
:root{color-scheme:light dark;
--bg:#fcfcfb;--surface:#ffffff;--ink:#0b0b0b;--ink2:#52514e;--ink3:#76756f;--line:#e6e5e0;--line2:#d4d3cd;
--done:#0b8f0b;--doing:#a86f00;--blocked:#c53030;--todo:#c9c8c2;--needs:#a3266f;--focus:#1f5fbf;
--r:6px;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px}
@media (prefers-color-scheme: dark){:root{
--bg:#161615;--surface:#1e1e1c;--ink:#f5f5f2;--ink2:#c3c2b7;--ink3:#97968d;--line:#2e2e2b;--line2:#3d3d39;
--done:#4cc76a;--doing:#f2b233;--blocked:#ff7b6e;--todo:#4a4a46;--needs:#f08cc8;--focus:#7fb0ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:0 var(--s4)}
h1,h2,h3{margin:0;line-height:1.25}
code{font:12.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:2px}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-9999px}.skip:focus{left:var(--s4);top:var(--s2);background:var(--surface);padding:var(--s2) var(--s3);z-index:2}
.muted{color:var(--ink2)}
.top{background:var(--surface);border-bottom:1px solid var(--line)}
.head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:var(--s3) var(--s5);padding-top:var(--s5);padding-bottom:var(--s4)}
h1{font-size:22px;font-weight:650;letter-spacing:-.01em}
.sub{margin:var(--s1) 0 0;color:var(--ink2);font-size:13px}
.stages{display:flex;flex-wrap:wrap;gap:var(--s1);list-style:none;margin:0;padding:0}
.stage{padding:2px var(--s2);border:1px solid var(--line2);border-radius:999px;font-size:12.5px;color:var(--ink3);white-space:nowrap}
.stage.t-done{color:var(--done)}.stage.t-now{color:var(--ink);border-color:var(--doing);font-weight:600}.stage.t-needs{color:var(--needs);border-color:var(--needs)}
.tabs .wrap{display:flex;gap:var(--s1);overflow-x:auto}
.tabs a{display:block;padding:var(--s2) var(--s3);text-decoration:none;color:var(--ink2);border-bottom:2px solid transparent;font-weight:500;white-space:nowrap}
.tabs a:hover{color:var(--ink)}
.tabs a[aria-selected=true]{color:var(--ink);border-bottom-color:var(--ink)}
body:not(.js) .tabs{display:none}
main.wrap{padding-top:var(--s5);padding-bottom:var(--s5)}
main>section+section{margin-top:var(--s6)}
.js main>section+section{margin-top:0}
.view-title{font-size:17px;margin-bottom:var(--s4)}
.js .view-title{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
section:focus{outline:none}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:var(--s4)}
.card h3{font-size:13px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:var(--s3)}
.foot{color:var(--ink3);font-size:12px;padding-top:var(--s2);padding-bottom:var(--s6)}
${OVERVIEW_STYLE()}
${BOARD_STYLE()}
${ROADMAP_STYLE}
${FLOW_STYLE}
${SPEC_STYLE}
`

function OVERVIEW_STYLE(): string {
  return `
.figs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--s3);margin:0}
.fig{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:var(--s3) var(--s4);min-width:0}
.fig dd{margin:0}
.fig dt{font-size:12px;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em}
.fig .v{display:block;font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:var(--s1)}
.fig .u{font-size:14px;font-weight:500;color:var(--ink2);margin-left:var(--s1)}
.fig .s{display:block;color:var(--ink2);font-size:12.5px}
.fig.f-needs .s{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fig.f-needs .v{color:var(--needs)}.fig.f-needs.zero .v{color:var(--done)}
.basis{margin:var(--s2) 0 0;color:var(--ink3);font-size:12.5px}
.health{border:1px solid var(--line);border-left:3px solid;border-radius:var(--r);background:var(--surface);padding:var(--s3) var(--s4);margin-bottom:var(--s4)}
.health p{margin:0}.h-ok{border-left-color:var(--done)}.h-risk{border-left-color:var(--doing)}
.h-head{font-weight:650;font-size:15px}.h-ok .g{color:var(--done)}.h-risk .g{color:var(--doing)}
.h-n{font-weight:400;color:var(--ink2);font-size:13px}
.h-why{margin:var(--s1) 0 0;color:var(--ink2);font-size:13px}
ul.h-why{padding-left:var(--s5)}ul.h-why li{padding:1px 0}
.drift{display:block;font-size:12.5px;margin-top:2px;font-variant-numeric:tabular-nums}
.d-later{color:var(--doing)}.d-sooner{color:var(--done)}.d-same{color:var(--ink3)}
.states{margin-top:var(--s5)}
.bar{display:flex;gap:2px;height:12px;border-radius:3px;overflow:hidden;background:var(--line)}
.bar span{display:block}.b-done{background:var(--done)}.b-doing{background:var(--doing)}.b-blocked{background:var(--blocked)}.b-todo{background:var(--todo)}
.legend{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);list-style:none;margin:var(--s2) 0 0;padding:0;font-size:13px;color:var(--ink2)}
.legend .g{font-weight:700;margin-right:2px}.g-done{color:var(--done)}.g-doing{color:var(--doing)}.g-blocked{color:var(--blocked)}.g-todo{color:var(--ink3)}
.cols{display:grid;grid-template-columns:3fr 2fr;gap:var(--s4);margin-top:var(--s5);align-items:start}
.needs{list-style:none;margin:0;padding:0}
.needs li{display:flex;gap:var(--s2);padding:var(--s2) 0;border-top:1px solid var(--line)}
.needs li:first-child{border-top:0;padding-top:0}
.needs .g{color:var(--needs);font-weight:700}
.good{color:var(--done);margin:0}
.now-title{font-size:16px;font-weight:600;margin:0}
.now-title .id{color:var(--doing);margin-right:var(--s1)}
.now-meta{margin:2px 0 var(--s3);color:var(--ink2);font-size:13px}
.boxes{list-style:none;margin:0;padding:0}
.boxes li{display:flex;gap:var(--s2);padding:2px 0}
.boxes .g{color:var(--ink3)}.boxes .done{color:var(--ink3);text-decoration:line-through}.boxes .done .g{color:var(--done);text-decoration:none}
.after{margin:var(--s3) 0 0;padding-top:var(--s3);border-top:1px solid var(--line);font-size:13px;color:var(--ink2)}
.empty{max-width:560px}
.empty h3{text-transform:none;letter-spacing:0;color:var(--ink);font-size:16px}
.empty p{margin:var(--s2) 0 0;color:var(--ink2)}
@media (max-width:860px){.cols{grid-template-columns:1fr}}
@media (max-width:640px){.figs{grid-template-columns:repeat(2,minmax(0,1fr))}.fig .v{font-size:22px}h1{font-size:19px}}
`
}

function BOARD_STYLE(): string {
  return `
.js-only{display:none}.js .js-only{display:block}
/* Laid out only once the script runs: without it the controls do nothing, so they stay hidden. */
.board-tools{flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s4);margin-bottom:var(--s4);font-size:13px;color:var(--ink2)}
.js .board-tools{display:flex}
.board-tools select{margin-left:var(--s1);font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line2);border-radius:var(--r);padding:2px var(--s2)}
.board-tools .check{display:flex;align-items:center;gap:var(--s1);cursor:pointer}
.cols5{display:grid;grid-template-columns:repeat(var(--cols,5),minmax(0,1fr));gap:var(--s3);align-items:start}
/* The lanes show only when grouped; the plain columns otherwise. */
.js .swim.js-only{display:none}.js.grouped .swim.js-only{display:block}.js.grouped .flat{display:none}
.col{background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:var(--s2);min-width:0}
.col h3,.col h4{font-size:12px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em;margin:var(--s1) var(--s1) var(--s2)}
.col .n{color:var(--ink3);font-weight:500;margin-left:2px}
.col ul{list-style:none;margin:0;padding:0;display:grid;gap:var(--s2)}
.none{margin:var(--s1);color:var(--ink3);font-size:13px}
.card.c-todo,.card.c-waiting,.card.c-doing,.card.c-review,.card.c-blocked,.card.c-done{padding:var(--s2) var(--s3);border-left:3px solid var(--line2)}
.c-doing{border-left-color:var(--doing)!important}.c-blocked{border-left-color:var(--blocked)!important}.c-done{border-left-color:var(--done)!important}.c-waiting{border-left-style:dashed!important}
.c-title{margin:0;font-weight:550;line-height:1.35}.c-title .id{color:var(--ink2);font-weight:600;font-variant-numeric:tabular-nums}
.c-done .c-title{color:var(--ink2)}
.c-meta{margin:var(--s1) 0 0;font-size:12.5px;color:var(--ink2);display:flex;flex-wrap:wrap;gap:2px var(--s2);justify-content:space-between}
.c-meta .why{color:var(--blocked)}
.c-phase{color:var(--ink3);white-space:nowrap}.c-owner{color:var(--ink);font-weight:550;white-space:nowrap}
.c-review{border-left-color:var(--focus)!important}.lane .c-phase{display:none}
.cp{font-size:12.5px;color:var(--ink2);padding:var(--s1) var(--s2);border:1px dashed var(--line2);border-radius:var(--r)}
.cp span{color:var(--needs)}
.lane+.lane{margin-top:var(--s5)}
.lane-title{font-size:14px;margin:0 0 var(--s2)}
@media (max-width:980px){.cols5{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.cols5{grid-template-columns:1fr}}
`
}
