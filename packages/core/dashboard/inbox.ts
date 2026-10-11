// The Inbox tab (ceremonies C7): what waits on a person, grouped by kind, each
// item with who it waits on, what it holds up and how long it has waited. The
// page lists everything; `#inbox?who=sara` (or `all`) shows what names that
// person or nobody, and `#inbox` alone whoever built the page. Without the
// script everything shows. On the live page an item gets the button it has on
// the Overview (Answer, Sign, Sign off) or, for a review, a link to its PR; the
// static page has no buttons. Pure.

import { inboxItems, type InboxItem, type InboxKind } from '../inbox'
import type { State } from '../state'
import { esc, inline, plural } from './html'
import { decisionActions } from './overview'

const GROUPS: { kind: InboxKind; label: string }[] = [
  { kind: 'checkpoint', label: 'Checkpoints to sign off' },
  { kind: 'question', label: 'Questions to answer' },
  { kind: 'approval', label: 'Specs to sign' },
  { kind: 'review', label: 'Reviews' },
  { kind: 'handoff', label: 'Handoffs' },
]

const key = (handle: string | null | undefined) => (handle ?? '').replace(/^@/, '').toLowerCase()
const sep = '<span class="ib-sep" aria-hidden="true"> · </span>'

export function inboxHtml(s: State, live = false): string {
  const items = inboxItems(s)
  if (!items.length) return '<p class="good">✓ Nothing is waiting on anyone.</p>'
  const me = s.team ? (s.me?.handle ?? null) : null
  // The people to pick: the team, else everyone the items name.
  const people = [...new Map([...(s.team?.members.map(m => m.handle) ?? []), ...items.flatMap(i => i.who)].map(h => [key(h), h])).values()].sort((a, b) => key(a).localeCompare(key(b)))
  const options = [`<option value="all">Everyone</option>`, ...people.map(h => `<option value="${esc(key(h))}">${esc(h)}${key(h) === key(me) ? ' (you)' : ''}</option>`)].join('')
  const picker = `<div class="ib-tools js-only"><label>Waiting on <select id="inbox-who" data-me="${me ? esc(key(me)) : 'all'}">${options}</select></label></div>`
  const due = items.find(i => i.kind === 'checkpoint')
  const groups = GROUPS.map(g => {
    const mine = items.filter(i => i.kind === g.kind)
    if (!mine.length) return ''
    return `<div class="card ib-group"><h3>${g.label}</h3><ul class="ib-list">${mine.map(i => itemHtml(s, i, live, i === due)).join('')}</ul></div>`
  }).join('\n')
  return `${picker}
<p class="t-note">${me ? `Opens on you (${esc(me)}). ` : ''}An item shows for the people it names; one that names nobody shows for everyone.</p>
<div class="ib">
${groups}
<p class="good ib-none">✓ Nothing is waiting on them.</p>
</div>`
}

/** A task id that opens its card on the Board, when this branch has one. */
function taskRef(s: State, id: string): string {
  return s.list?.tasks.some(t => t.id === id) ? `<a href="#card-${esc(id)}">${esc(id)}</a>` : `<span class="id">${esc(id)}</span>`
}

function itemHtml(s: State, i: InboxItem, live: boolean, isDue: boolean): string {
  const title = i.id ? `${taskRef(s, i.id)} ${inline(i.text.slice(i.id.length + 1))}` : inline(i.text)
  const meta: string[] = []
  if (i.kind === 'approval' && i.roles?.length) meta.push(`waits on ${i.roles.map(r => (r.who.length ? `${r.who.map(esc).join(' or ')} (${esc(r.role)})` : `${esc(r.role)} (nobody on the team has it)`)).join(', ')}`)
  else if (i.kind === 'review') meta.push(i.who.length === 1 ? `reviewer ${esc(i.who[0]!)}` : 'no reviewer yet')
  else if (i.kind === 'handoff') meta.push(`to ${esc(i.who[0] ?? 'someone')} from ${esc(i.from ?? 'someone')}: ${inline(i.note ?? '')}`)
  else meta.push(i.who.length ? `waits on ${i.who.map(esc).join(', ')}` : i.kind === 'checkpoint' ? 'anyone can sign it off' : 'anyone can answer')
  if (i.kind === 'review') {
    // A PR given as its address shows as its number; the live page links it.
    const url = !!i.pr && /^https?:\/\//.test(i.pr)
    const name = i.pr ? `PR ${esc(url ? i.pr.replace(/^.*\/pull\/(\d+).*$/, '#$1') : i.pr)}` : null
    const pr = name && url && live ? `<a href="${esc(i.pr!)}" target="_blank" rel="noreferrer">${name}</a>` : name
    meta.push(...[pr, i.owner ? `by ${esc(i.owner)}` : null, i.ref ? `on <code>${esc(i.ref)}</code>` : null].filter((x): x is string => !!x))
  }
  if ((i.kind === 'checkpoint' || i.kind === 'question') && i.tasks.length) meta.push(`holds up ${i.tasks.map(id => taskRef(s, id)).join(', ')}`)
  if (i.age !== null) meta.push(`<span title="${esc(AGE[i.kind])}">${plural(i.age, 'day')}</span>`)
  return `<li class="ib-item" data-who="${esc(i.who.map(key).join(' '))}"><span class="g" aria-hidden="true">♦</span><div><p class="ib-text">${title}</p><p class="ib-meta">${meta.join(sep)}</p>${live ? decisionActions(i, isDue, 'i') : ''}</div></li>`
}

/** What an item's age counts from: the files say no more than this. */
const AGE: Record<InboxKind, string> = {
  checkpoint: 'Since the task before it was done',
  question: '',
  approval: 'Since the spec was written',
  review: "Since the task started: the Status line doesn't say when review began",
  handoff: 'Since the handoff',
}

export const INBOX_STYLE = `
.ib-tools{margin-bottom:var(--s3);font-size:13px;color:var(--ink2)}
.ib-tools select{margin-left:var(--s1);font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line2);border-radius:var(--r);padding:2px var(--s2)}
.ib{display:grid;gap:var(--s3)}
.ib-list{list-style:none;margin:0;padding:0}
.ib-item{display:flex;gap:var(--s2);min-width:0}
.ib-item[hidden]{display:none}
/* A rule between the items showing, whichever the picker hid. */
.ib-item:not([hidden])~.ib-item{margin-top:var(--s2);padding-top:var(--s2);border-top:1px solid var(--line)}
.ib-item>div{min-width:0;flex:1}
.ib-item .g{color:var(--needs);font-weight:700}
.ib-text{margin:0;overflow-wrap:anywhere}
.ib-meta{margin:2px 0 0;font-size:12.5px;color:var(--ink2);overflow-wrap:anywhere}
.ib-none{display:none}
/* A person picked: a kind with nothing for them goes, and when every kind has gone, the good news shows. */
.ib-group:not(:has(.ib-item:not([hidden]))){display:none}
.ib:not(:has(.ib-item:not([hidden]))) .ib-none{display:block}
`
