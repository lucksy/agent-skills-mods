// The Modules tab (format-v2 T12, F7): every module of the capability map at a
// glance, for whoever asks "where are we across the project?". One row each:
// its state as a glyph and a word, what it is for, what it needs, its spec,
// its progress and its dates. The module under way links to its Overview.
// Shown only when SPEC.md has a capability map. Pure.

import { shortDay } from '../forecast'
import type { ModuleRow, ModuleState } from '../modules'
import type { State } from '../state'
import { esc, inline } from './html'

const LOOK: Record<ModuleState, { glyph: string; tone: string }> = {
  done: { glyph: '✓', tone: 'done' },
  building: { glyph: '●', tone: 'doing' },
  planned: { glyph: '◐', tone: 'doing' },
  'ready to plan': { glyph: '◇', tone: 'todo' },
  speccing: { glyph: '♦', tone: 'needs' },
  'not started': { glyph: '○', tone: 'todo' },
}

function rowHtml(r: ModuleRow): string {
  const look = LOOK[r.state]
  const spec = r.spec ? `spec ${r.spec.status === 'approved' ? `approved${r.spec.approvedOn ? ` ${shortDay(r.spec.approvedOn)}` : ''}` : 'draft'}` : r.state === 'not started' ? '' : 'no spec file'
  const finished = r.plans.map(p => p.finished).filter((d): d is string => !!d).sort().at(-1)
  const started = r.plans.at(-1)?.started
  const when = r.state === 'done' && finished ? `finished ${shortDay(finished)}` : started && r.total ? `started ${shortDay(started)}` : ''
  const active = r.plans.some(p => p.where === 'active') && r.state !== 'done'
  const pct = r.total ? Math.round((r.done / r.total) * 100) : 0
  const bar = r.total
    ? `<div class="mod-bar" role="img" aria-label="${r.done} of ${r.total} tasks done"><span class="b-${look.tone === 'done' ? 'done' : 'doing'}" style="width:${pct}%"></span></div><span class="mod-n">${r.done}/${r.total}</span>`
    : ''
  const facts = [r.dependsOn.length ? `needs ${r.dependsOn.map(esc).join(', ')}` : '', spec, when].filter(Boolean)
  return `<li class="mod m-${look.tone}" data-module="${esc(r.id)}">
<p class="mod-h"><span class="g" aria-hidden="true">${look.glyph}</span> <b>${esc(r.id)}</b> <span class="mod-s">${r.state}</span></p>
<p class="mod-r">${inline(r.responsibility)}</p>
<div class="mod-p">${bar}</div>
<p class="mod-f">${facts.join(' · ')}${active ? ' · <a href="#overview">its Overview</a>' : ''}</p>
</li>`
}

export function modulesHtml(s: State): string {
  const rows = s.modules ?? []
  if (!rows.length) return '<div class="card empty" role="status"><h3>No capability map</h3><p>A table under a "# Capability Map" heading in <code>SPEC.md</code>, with a Module id column, lists the modules.</p></div>'
  const done = rows.filter(r => r.state === 'done').length
  return `<p class="flow-lead">${done} of ${rows.length} modules done, from the capability map in <code>SPEC.md</code>. Finished modules count their archived plans.</p>
<ul class="mods">${rows.map(rowHtml).join('\n')}</ul>`
}

/** This view's CSS, added to the page's stylesheet. */
export const MODULES_STYLE = `
.mods{list-style:none;margin:0;padding:0;display:grid;gap:var(--s2)}
.mod{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,1fr);gap:var(--s1) var(--s4);align-items:center;background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--line2);border-radius:var(--r);padding:var(--s3) var(--s4)}
.mod p{margin:0}.mod-h{white-space:nowrap}.mod-s{color:var(--ink2);font-size:12.5px;margin-left:var(--s1)}
.m-done{border-left-color:var(--done)}.m-done .g{color:var(--done)}.m-doing{border-left-color:var(--doing)}.m-doing .g{color:var(--doing)}.m-needs .g{color:var(--needs)}.m-todo .g{color:var(--ink3)}
.mod-r{color:var(--ink2);font-size:13px}
.mod-p{display:flex;align-items:center;gap:var(--s2)}.mod-bar{flex:1;height:8px;border-radius:3px;background:var(--line);overflow:hidden}.mod-bar span{display:block;height:100%}
.mod-n{font-size:12.5px;color:var(--ink2);font-variant-numeric:tabular-nums}
.mod-f{grid-column:1/-1;font-size:12.5px;color:var(--ink3)}
@media (max-width:760px){.mod{grid-template-columns:1fr}}
`
