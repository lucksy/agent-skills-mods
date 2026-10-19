// The plan pane's Overview and Team tabs (the dashboard's, drawn for the
// terminal): pure, from State v1 and the elements the hook resolved, so the
// hooks module does every read and these only draw. The Sprint and Inbox tabs
// draw their command's reply instead, so the pane and /progress agree.
//
// Elements are called as functions, `Text({ children })`: JSX compiles to the
// engine's `h`, which the hooks module has and the files it imports don't.

import { COLOR, hex } from '../packages/core/chart'
import { teamView } from '../packages/core/dashboard/team'
import { shortDay } from '../packages/core/forecast'
import { health } from '../packages/core/health'
import { inbox, inboxLine } from '../packages/core/inbox'
import { headline, nowCounts } from '../packages/core/report'
import type { State } from '../packages/core/state'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The elements a tab draws with, as `$.ui.resolve(e)` handed them to the hook. */
export type Els = { Box: any; Text: any }

type Kid = unknown

/** How many waiting items the Overview lists before pointing at the Inbox tab. */
const NEEDS_SHOWN = 5

/** `Text` and `Box` with their children after the props, as JSX would write them; false and null children are left out. */
function draw({ Box, Text }: Els) {
  const kids = (c: Kid[]) => c.filter(x => x !== false && x !== null && x !== undefined && x !== '')
  return {
    text: (props: Record<string, unknown>, ...c: Kid[]) => Text({ ...props, children: kids(c) }),
    box: (props: Record<string, unknown>, ...c: Kid[]) => Box({ ...props, children: kids(c) }),
  }
}

/** The four figures (done, forecast, scope change, needs a decision), as the dashboard's Overview opens. */
function figuresRow(els: Els, s: State, body: number) {
  const { text, box } = draw(els)
  const figures = headline({ spec: s.spec, list: s.list, plan: s.plan, forecast: s.forecast, snapshots: s.snapshots, specFile: s.specFile })
  const width = Math.max(16, Math.floor((body - 6) / 4))
  return box(
    { flexDirection: 'row', gap: 2, flexWrap: 'wrap' },
    ...figures.map(f =>
      box(
        { key: f.label, flexDirection: 'column', width },
        text({ dimColor: true }, f.label.toUpperCase()),
        text({}, text({ bold: true }, f.value), f.unit && text({ dimColor: true }, ` ${f.unit}`)),
        text({ dimColor: true, wrap: 'truncate-end' }, f.sub),
      ),
    ),
  )
}

/** Tasks by state as one bar, named in words under it. */
function nowBar(els: Els, s: State, body: number) {
  const { text, box } = draw(els)
  const list = s.list
  if (!list || list.total === 0) return null
  const counts = nowCounts(list)
  const width = Math.max(10, Math.min(60, body - 2))
  const seg = (n: number) => Math.round((n / list.total) * width)
  const rest = Math.max(0, width - seg(counts.done) - seg(counts.doing) - seg(counts.blocked))
  return box(
    { flexDirection: 'column' },
    text({ bold: true }, 'Now'),
    text(
      {},
      text({ color: hex(COLOR.done) }, '█'.repeat(seg(counts.done))),
      text({ color: hex(COLOR.doing) }, '█'.repeat(seg(counts.doing))),
      text({ color: hex(COLOR.blocked) }, '█'.repeat(seg(counts.blocked))),
      text({ color: hex(COLOR.todo) }, '█'.repeat(rest)),
    ),
    text({ dimColor: true }, `done ${counts.done} · in progress ${counts.doing} · blocked ${counts.blocked} · to do ${counts.todo}`),
  )
}

/**
 * Overview: on track or at risk with each reason, the four figures, tasks by
 * state, what waits on you, and the task under way.
 */
export function overviewTab(els: Els, s: State, body: number) {
  const { text, box } = draw(els)
  const list = s.list
  if (!list || list.total === 0) return text({ dimColor: true }, 'No task list yet: the Overview fills in once tasks/todo.md exists.')
  const h = health(s)
  const fc = s.forecast
  const basis =
    fc?.kind === 'range'
      ? `Forecast ${fc.basis}: fast ${shortDay(fc.optimistic)}, likely ${shortDay(fc.median)}, slow ${shortDay(fc.slow)}.`
      : fc?.kind === 'not-enough'
        ? `No forecast yet: ${fc.reason}.`
        : null
  const handle = s.team ? (s.me?.handle ?? null) : null
  const waiting = inbox(s, 'me')
  const t = list.current
  const stuck = list.tasks.filter(x => x.status === 'blocked' || x.status === 'waiting')
  const healthRow =
    h.status === 'on track'
      ? text({}, text({ color: 'success', bold: true }, '✓ On track'), text({ dimColor: true }, ' · nothing is late, blocked or waiting on a sign-off'))
      : box(
          { flexDirection: 'column' },
          text({ color: 'warning', bold: true }, `! At risk · ${h.reasons.length} reason${h.reasons.length === 1 ? '' : 's'}`),
          ...h.reasons.slice(0, NEEDS_SHOWN).map((r, i) => text({ key: `r${i}`, wrap: 'wrap' }, `  · ${r}`)),
        )
  const needs = box(
    { flexDirection: 'column' },
    text({ bold: true }, 'Needs you'),
    ...(waiting.length === 0
      ? [text({ color: 'success' }, '✓ Nothing is waiting on you.')]
      : waiting.slice(0, NEEDS_SHOWN).map((i, n) => text({ key: `n${n}`, wrap: 'truncate-end' }, text({ color: 'permission' }, '♦'), ` ${inboxLine(i, handle)}`))),
    waiting.length > NEEDS_SHOWN && text({ dimColor: true }, `… ${waiting.length - NEEDS_SHOWN} more on the Inbox tab (7)`),
  )
  const now = t
    ? text({ wrap: 'truncate-end' }, text({ color: 'claude' }, `▸ ${t.id}`), ` ${t.title}`, t.owner && text({ dimColor: true }, ` · ${t.owner}`), t.state?.step && text({ dimColor: true }, ` · ${t.state.step}`))
    : list.done === list.total
      ? text({ color: 'success' }, '✓ Every task is done. Next stage: review.')
      : text({ color: 'error', wrap: 'wrap' }, `■ Nothing can start: ${stuck.map(x => (x.status === 'blocked' ? `${x.id} blocked by ${x.blockedBy}` : `${x.id} waits on ${x.deps.join(', ')}`)).join('; ')}`)
  return box(
    { flexDirection: 'column', gap: 1 },
    healthRow,
    box({ flexDirection: 'column' }, figuresRow(els, s, body), basis && text({ dimColor: true, wrap: 'wrap' }, basis)),
    nowBar(els, s, body),
    needs,
    box({ flexDirection: 'column' }, text({ bold: true }, 'Under way'), now),
  )
}

/** A task as one line on the Team tab: `T4 Rate limit · test`, with its branch when it is not this one. */
const work = (w: { id: string; title: string; step: string | null; state: string; ref: string | null }) =>
  `${w.id} ${w.title}${w.step ? ` · ${w.step}` : w.state !== 'in progress' ? ` · ${w.state}` : ''}${w.ref ? ` · on ${w.ref}` : ''}`

/**
 * Team: one line per person (their current task and step, other work under
 * way, reviews waiting on them, handoffs to them), then the review queue and
 * the decisions waiting on someone. Load and queues only: nobody is ranked.
 */
export function teamTab(els: Els, s: State) {
  const { text, box } = draw(els)
  const v = teamView(s)
  const people = v.people.filter(p => p.handle !== null || p.wip.length || p.reviews.length)
  if (!v.fromTeam && people.every(p => p.handle === null)) {
    return text({ dimColor: true, wrap: 'wrap' }, 'No tasks/team.md, and no task names an owner. /progress team init writes the team from your git authors.')
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const person = (p: (typeof people)[number]) => {
    const other = p.wip.filter(w => w !== p.current)
    const extra = [
      other.length ? `+${other.length} under way` : '',
      p.reviews.length ? `${plural(p.reviews.length, 'review', 'reviews')} waiting` : '',
      p.handoffs.length ? `${p.handoffs.length} handed to them` : '',
      p.collisions.length ? `! ${plural(p.collisions.length, 'collision', 'collisions')}` : '',
    ].filter(Boolean)
    return text(
      { key: `p-${p.handle ?? 'nobody'}`, wrap: 'truncate-end' },
      text({ bold: true }, p.handle ?? 'unowned'),
      p.roles.length > 0 && text({ dimColor: true }, ` (${p.roles.join(', ')})`),
      ' · ',
      p.current ? text({ color: 'claude' }, `▸ ${work(p.current)}`) : text({ dimColor: true }, 'nothing under way'),
      extra.length > 0 && text({ dimColor: true }, ` · ${extra.join(' · ')}`),
    )
  }
  const review = (r: (typeof v.queue)[number]) =>
    text(
      { key: `q-${r.id}-${r.ref ?? ''}`, wrap: 'truncate-end' },
      `${r.id} ${r.title}${r.pr ? ` · PR ${r.pr}` : ''}${r.owner ? ` · by ${r.owner}` : ''}${r.reviewer ? ` · reviewer ${r.reviewer}` : ' · no reviewer'}${r.ref ? ` · on ${r.ref}` : ''}${r.age === null ? '' : ` · ${r.age} d`}`,
    )
  return box(
    { flexDirection: 'column', gap: 1 },
    box({ flexDirection: 'column' }, text({ bold: true }, 'Team', text({ dimColor: true }, ` · ${v.fromTeam ? 'from tasks/team.md' : 'the owners the task list names'}`)), ...people.map(person)),
    box({ flexDirection: 'column' }, text({ bold: true }, 'Review queue'), ...(v.queue.length ? v.queue.map(review) : [text({ dimColor: true }, 'Nothing in review.')])),
    v.waiting.length > 0 &&
      box(
        { flexDirection: 'column' },
        text({ bold: true }, 'Waiting on someone'),
        ...v.waiting.map(w => text({ key: `w-${w.who ?? 'anyone'}`, wrap: 'truncate-end' }, text({ bold: true }, w.who ?? 'anyone'), text({ dimColor: true }, ' · '), w.items.map(i => i.text).join(' · '))),
      ),
  )
}
