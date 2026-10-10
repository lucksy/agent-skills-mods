// The Spec view (K5): is the spec ready? One section per spec file (SPEC.md,
// then SPEC-*.md, then specs/*.md, as State orders them), each with its approval,
// the six core areas as the spec pane shows them, boundaries in three columns,
// open questions and success criteria. With more than one file, a picker of
// in-page links switches between them: CSS (:target) shows the chosen one alone,
// so it needs no script; without a choice every spec shows, stacked. Pure.

import { shortDay } from '../forecast'
import type { Spec } from '../parse'
import type { State } from '../state'
import { approvalStatus } from '../approvals'
import type { Team } from '../team'
import { areaSummary, specApproval } from '../view'
import { esc, inline, plural } from './html'

/** The most specs the picker marks as chosen; past this they still switch, unmarked. */
const MARKED = 12

export function specHtml(s: State): string {
  if (!s.specs.length) return emptyHtml()
  const hasPlan = !!s.list
  const ids = anchors(s.specs.map(x => x.file))
  const picker =
    s.specs.length > 1
      ? `<nav class="spec-pick" aria-label="Spec files"><ul>${s.specs
          .map(({ file, spec }, i) => {
            const a = approvalOf(spec, hasPlan, s.team)
            return `<li><a href="#${ids[i]}"><code>${esc(file)}</code>${spec.title ? ` <span class="pk-t">${inline(spec.title)}</span>` : ''} <span class="pk-a a-${a.key}"><span aria-hidden="true">${a.glyph}</span> ${a.short}</span></a></li>`
          })
          .join('')}</ul><a class="pk-all" href="#spec">Show every spec</a></nav>`
      : ''
  return `<div class="specs">
${picker}
${s.specs.map(({ file, spec }, i) => articleHtml(file, spec, ids[i]!, hasPlan, s.team)).join('\n')}
</div>`
}

/** An id per file for the picker's links: never a view's name, unique even when two files slug alike. */
function anchors(files: string[]): string[] {
  const seen = new Set<string>()
  return files.map(f => {
    const base = `spec-${f.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
    let id = base
    for (let n = 2; seen.has(id); n++) id = `${base}-${n}`
    seen.add(id)
    return id
  })
}

const longDay = (d: string) => `${shortDay(d)} ${d.slice(0, 4)}`

/** Approval as the spec pane reads it: front matter first, else a plan existing means approved. */
function approvalOf(spec: Spec, hasPlan: boolean, team: Team | null = null): { key: 'approved' | 'awaiting'; glyph: string; short: string; long: string } {
  if (specApproval(spec, hasPlan) !== 'approved') {
    // format-v2 (F5): signed by role, the count and who it waits on.
    if (team?.approvals.length) {
      const st = approvalStatus(spec.approvals ?? [], team)
      return { key: 'awaiting', glyph: '♦', short: `${st.signed.length}/${team.approvals.length}`, long: st.text }
    }
    return { key: 'awaiting', glyph: '♦', short: 'awaiting', long: 'Awaiting approval' }
  }
  const when = spec.approvedOn ? ` ${longDay(spec.approvedOn)}` : spec.status === 'approved' ? '' : ' · a plan exists'
  return { key: 'approved', glyph: '✓', short: 'approved', long: `Approved${when}` }
}

const AREA_GLYPH = { ok: '✓', weak: '!', empty: '○', missing: '×' } as const

function articleHtml(file: string, spec: Spec, id: string, hasPlan: boolean, team: Team | null = null): string {
  const a = approvalOf(spec, hasPlan, team)
  const meta = [
    `<span class="appr a-${a.key}"><span aria-hidden="true">${a.glyph}</span> ${esc(a.long)}</span>`,
    spec.created ? `<span>Written ${esc(longDay(spec.created))}</span>` : '',
  ].filter(Boolean)

  const areas = spec.areas
    .map((area, i) => {
      const sum = areaSummary(area, spec.successCriteria)
      const tone = area.state !== 'present' ? (area.state as 'empty' | 'missing') : area.hint ? 'weak' : 'ok'
      const word = sum.text ? esc(sum.text) : tone === 'ok' ? '<span class="vh">written</span>' : ''
      return `<li class="area ar-${tone}" data-area="${esc(area.key)}"><span class="g" aria-hidden="true">${AREA_GLYPH[tone]}</span><span class="al"><span class="an">${i + 1}</span> ${esc(area.label)}</span><span class="as">${word}</span>${area.hint ? `<p class="ah">${inline(area.hint)}</p>` : ''}</li>`
    })
    .join('')
  const weak = spec.areas.filter(x => x.state !== 'present' || x.hint).length

  const column = (key: 'always' | 'ask' | 'never', head: string, glyph: string) => {
    const items = spec.boundaries[key]
    return `<div class="bnd b-${key}"><h4><span class="g" aria-hidden="true">${glyph}</span> ${head}</h4>${
      items.length ? `<ul>${items.map(x => `<li>${inline(x)}</li>`).join('')}</ul>` : '<p class="none">None written.</p>'
    }</div>`
  }

  const questions = spec.openQuestions.length
    ? `<ul class="needs">${spec.openQuestions.map(q => `<li><span class="g" aria-hidden="true">♦</span><span>${inline(q)}</span></li>`).join('')}</ul>`
    : '<p class="good">✓ No open questions.</p>'
  const criteria = spec.successCriteria.length
    ? `<ul class="crit">${spec.successCriteria.map(c => `<li>${inline(c)}</li>`).join('')}</ul>`
    : '<p class="muted">No success criteria written yet.</p>'

  return `<article class="spec" id="${id}" data-file="${esc(file)}" aria-labelledby="${id}-h">
<header class="spec-head">
<h3 id="${id}-h"><code>${esc(file)}</code>${spec.title ? ` <span class="spec-t">${inline(spec.title)}</span>` : ''}</h3>
<p class="spec-meta">${meta.join('<span aria-hidden="true"> · </span>')}</p>
</header>
${approvalsCard(spec, team)}<div class="card spec-areas"><h4>Core areas <span class="n">${weak ? plural(weak, 'gap') : 'all six written'}</span></h4><ol class="areas">${areas}</ol></div>
<div class="bnds">${column('always', 'Always', '✓')}${column('ask', 'Ask first', '?')}${column('never', 'Never', '×')}</div>
<div class="spec-cols">
<div class="card"><h4>Open questions <span class="n">${spec.openQuestions.length}</span></h4>${questions}</div>
<div class="card"><h4>Success criteria <span class="n">${spec.successCriteria.length}</span></h4>${criteria}</div>
</div>
</article>`
}

/** Each required role (format-v2, F5): who signed it and when, or who it waits on. */
function approvalsCard(spec: Spec, team: Team | null): string {
  if (!team?.approvals.length) return ''
  const st = approvalStatus(spec.approvals ?? [], team)
  const rows = team.approvals.map(role => {
    const sig = st.signed.find(x => x.role === role)
    if (sig) return `<li class="ap-ok"><span class="g" aria-hidden="true">✓</span> <b>${esc(role)}</b> ${esc(sig.handle)} <span class="muted">${esc(longDay(sig.day))}</span></li>`
    const who = st.waiting.find(w => w.role === role)?.who ?? []
    return `<li class="ap-wait"><span class="g" aria-hidden="true">○</span> <b>${esc(role)}</b> <span class="muted">${who.length ? `waiting on ${esc(who.join(' or '))}` : 'nobody on the team has this role'}</span></li>`
  })
  return `<div class="card spec-appr"><h4>Approvals <span class="n">${st.signed.length}/${team.approvals.length}</span></h4><ul class="appr-list">${rows.join('')}</ul></div>
`
}

/** No spec: say where one would go and what writes it. */
function emptyHtml(): string {
  return `<div class="card empty" role="status">
<h3>No spec yet</h3>
<p>A spec would go in <code>SPEC.md</code> at the project root (or <code>SPEC-&lt;module&gt;.md</code> beside it, or <code>specs/&lt;module&gt;.md</code>). agent-skills' spec step (<code>/spec</code>) writes it: the objective, commands, project structure, code style, testing and boundaries.</p>
<p>Once it exists, this view shows whether it is approved, which of its six areas have gaps, its boundaries and its open questions.</p>
</div>`
}

/** The chosen spec's picker link, marked: one rule per position, as CSS cannot count. */
const marks = Array.from(
  { length: MARKED },
  (_, i) => `.specs:has(>article:nth-of-type(${i + 1}):target) .spec-pick li:nth-child(${i + 1}) a`,
).join(',\n')

/** This view's CSS, added to the page's stylesheet. */
export const SPEC_STYLE = `
.spec-appr{margin-bottom:var(--s4)}.appr-list{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:var(--s2) var(--s5)}
.appr-list .ap-ok .g{color:var(--done)}.appr-list .ap-wait .g{color:var(--needs)}
.spec-pick{margin-bottom:var(--s5)}
.spec-pick ul{display:flex;flex-wrap:wrap;gap:var(--s2);list-style:none;margin:0;padding:0}
.spec-pick a{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px var(--s2);padding:var(--s2) var(--s3);border:1px solid var(--line2);border-radius:var(--r);background:var(--surface);text-decoration:none;color:var(--ink2);min-width:0}
.spec-pick a:hover{color:var(--ink);border-color:var(--ink3)}
.spec-pick code{color:var(--ink);font-weight:600}
.pk-t{font-size:13px}
.pk-a{font-size:12px}
.a-approved{color:var(--done)}.a-awaiting{color:var(--needs)}
.pk-all{display:none;margin-top:var(--s2);font-size:13px;color:var(--ink2)}
/* A picked spec shows alone; with none picked, all of them do. */
.specs:has(>article:target)>article:not(:target){display:none}
.specs:has(>article:target) .pk-all{display:inline-block}
${marks}{border-color:var(--ink);color:var(--ink);background:var(--bg);text-decoration:underline;text-underline-offset:3px}
.spec{display:grid;gap:var(--s4);scroll-margin-top:var(--s4)}
.spec+.spec{margin-top:var(--s6);padding-top:var(--s5);border-top:1px solid var(--line)}
.spec-head h3{font-size:17px;font-weight:650;display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s1) var(--s2)}
.spec-head h3 code{font-size:14px;color:var(--ink2)}
.spec-meta{margin:var(--s1) 0 0;color:var(--ink2);font-size:13px}
.appr{font-weight:600}
.spec h4{font-size:12px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em;margin:0 0 var(--s2)}
.spec h4 .n{color:var(--ink3);font-weight:500;text-transform:none;letter-spacing:0;margin-left:var(--s1)}
.areas{list-style:none;margin:0;padding:0}
.area{display:grid;grid-template-columns:1.25em minmax(0,1fr) auto;gap:0 var(--s2);align-items:baseline;padding:var(--s2) 0;border-top:1px solid var(--line)}
.area:first-child{border-top:0;padding-top:0}
.area .g{font-weight:700;text-align:center}
.area .an{color:var(--ink3);font-variant-numeric:tabular-nums;margin-right:2px}
.area .as{color:var(--ink3);font-size:13px;text-align:right}
.ar-ok .g{color:var(--done)}
.ar-weak .g,.ar-weak .as,.ar-empty .g,.ar-empty .as{color:var(--doing)}
.ar-missing .g,.ar-missing .as{color:var(--blocked)}
.ah{grid-column:2/4;margin:2px 0 0;color:var(--ink2);font-size:12.5px}
.bnds{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s3)}
.bnd{background:var(--surface);border:1px solid var(--line);border-top:3px solid;border-radius:var(--r);padding:var(--s3);min-width:0}
.bnd h4 .g{font-weight:700;margin-right:2px}
.b-always{border-top-color:var(--done)}.b-always .g{color:var(--done)}
.b-ask{border-top-color:var(--doing)}.b-ask .g{color:var(--doing)}
.b-never{border-top-color:var(--blocked)}.b-never .g{color:var(--blocked)}
.bnd ul,.crit{margin:0;padding-left:var(--s4)}
.bnd li,.crit li{padding:2px 0}
.bnd .none{margin:0}
.spec-cols{display:grid;grid-template-columns:1fr 1fr;gap:var(--s4);align-items:start}
.spec .card h4{margin-bottom:var(--s3)}
@media (max-width:860px){.spec-cols{grid-template-columns:1fr}}
@media (max-width:640px){.bnds{grid-template-columns:1fr}.area{grid-template-columns:1.25em minmax(0,1fr)}.area .as{grid-column:2;text-align:left}.ah{grid-column:2}}
`
