// Approvals by role (format-v2, F5). tasks/team.md's `approvals:` names the
// roles that must sign a spec; each signature goes into the spec's front matter
// with the person and the day:
//
//   approvals: design @sara 2026-10-09, eng @amila 2026-10-10
//
// `status: approved` is written only when the last required role signs, so every
// tool that reads `status:` keeps working. Pure.

import { readFrontMatter, setFrontMatter } from './format'
import type { Member, Team } from './team'

export type Signature = { role: string; handle: string; day: string }

const ITEM = /^\s*([\w-]+)\s+(@[\w.-]+)\s+(\d{4}-\d{2}-\d{2})\s*$/

/** The `approvals:` front-matter value as signatures; anything unreadable is skipped. */
export function parseApprovals(value: string | undefined): Signature[] {
  return (value ?? '').split(',').flatMap(item => {
    const m = ITEM.exec(item)
    return m ? [{ role: m[1]!.toLowerCase(), handle: m[2]!, day: m[3]! }] : []
  })
}

const approvalsValue = (sigs: Signature[]) => sigs.map(s => `${s.role} ${s.handle} ${s.day}`).join(', ')

/**
 * `a` in the spec pane, by someone in tasks/team.md: they sign every required
 * role they hold that nobody has signed yet. The spec flips to approved, dated
 * today, once every required role has a signature. `signed` is empty when
 * there was nothing for them to sign (and the text is then unchanged).
 */
export function signSpec(text: string, me: Member, required: string[], today: string): { text: string; signed: string[]; complete: boolean } {
  const { fields } = readFrontMatter(text)
  const sigs = parseApprovals(fields.approvals)
  const done = new Set(sigs.map(s => s.role))
  const signed = required.filter(r => me.roles.includes(r) && !done.has(r))
  if (!signed.length) return { text, signed, complete: required.every(r => done.has(r)) }
  const next = [...sigs, ...signed.map(role => ({ role, handle: me.handle, day: today }))]
  const complete = required.every(r => next.some(s => s.role === r))
  const out = setFrontMatter(text, { status: complete ? 'approved' : 'draft', approvals: approvalsValue(next), ...(complete ? { approved: today } : {}) })
  return { text: out, signed, complete }
}

/** Who has signed and who it still waits on: `1/3 approved · waiting on @pm (product), @amila or @kim (eng)`. */
export function approvalStatus(sigs: Signature[], team: Team): { signed: Signature[]; waiting: { role: string; who: string[] }[]; text: string } {
  const required = team.approvals
  const signed = sigs.filter(s => required.includes(s.role))
  const waiting = required.filter(r => !signed.some(s => s.role === r)).map(role => ({ role, who: team.members.filter(m => m.roles.includes(role)).map(m => m.handle) }))
  const names = waiting.map(w => (w.who.length ? `${w.who.join(' or ')} (${w.role})` : `${w.role} (nobody on the team has it)`))
  const count = `${required.length - waiting.length}/${required.length} approved`
  return { signed, waiting, text: waiting.length ? `${count} · waiting on ${names.join(', ')}` : count }
}

/** Back to draft (`d`), or a spec changed after approval: every signature goes. */
export function clearApprovals(text: string): string {
  return setFrontMatter(text, { approvals: null })
}
