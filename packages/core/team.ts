// A team (format-v2, F1): tasks/team.md lists who works on the project, their
// roles and their git emails, so the plugin can tell who you are from
// `git config user.email`. Roles are shown, never enforced: these are files in
// git, and anyone can edit them. `approvals:` in its front matter names the roles
// that must sign a spec. Pure.

import { readFrontMatter } from './format'

export type Member = { handle: string; roles: string[]; email: string | null }
export type Team = { members: Member[]; approvals: string[]; problems: string[] }

export const TEAM_FILE = 'tasks/team.md'

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim())
const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line)
const isRule = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line)

/** The team in `text`: its members (bad rows skipped and named in `problems`) and the roles a spec needs. */
export function parseTeam(text: string): Team {
  const { fields, body } = readFrontMatter(text)
  const approvals = (fields.approvals ?? '')
    .split(',')
    .map(r => r.trim().toLowerCase())
    .filter(Boolean)
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const head = lines.findIndex((l, i) => isRow(l) && isRule(lines[i + 1] ?? '') && cells(l).some(c => /^handle$/i.test(c)))
  if (head < 0) return { members: [], approvals, problems: ['no Handle | Role | Email table'] }
  const names = cells(lines[head]!).map(c => c.toLowerCase())
  const col = (re: RegExp) => names.findIndex(n => re.test(n))
  const [hCol, rCol, eCol] = [col(/^handle$/), col(/^roles?$/), col(/^e-?mail$/)]

  const members: Member[] = []
  const problems: string[] = []
  for (let i = head + 2, row = 1; i < lines.length && isRow(lines[i]!); i++, row++) {
    const c = cells(lines[i]!)
    const raw = c[hCol] ?? ''
    if (!raw) {
      problems.push(`row ${row}: no handle`)
      continue
    }
    const handle = raw.startsWith('@') ? raw : `@${raw}`
    const roles = rCol < 0 ? [] : (c[rCol] ?? '').split(',').map(r => r.trim().toLowerCase()).filter(Boolean)
    const email = eCol < 0 ? null : (c[eCol] ?? '').trim().toLowerCase() || null
    const sameHandle = members.find(m => m.handle.toLowerCase() === handle.toLowerCase())
    if (sameHandle) {
      problems.push(`row ${row}: ${handle} is listed twice; kept the first`)
      continue
    }
    const sameEmail = email ? members.find(m => m.email === email) : undefined
    if (sameEmail) {
      problems.push(`row ${row}: ${handle} has the email of ${sameEmail.handle} (${email}); kept ${sameEmail.handle}`)
      continue
    }
    members.push({ handle, roles, email })
  }
  return { members, approvals, problems }
}

/** The member whose email this is, in any case; null when no one is. */
export function whoIs(team: Team | null, email: string | null): Member | null {
  if (!team || !email) return null
  const e = email.trim().toLowerCase()
  return team.members.find(m => m.email === e) ?? null
}

/** Authors that are tools, not people: bots, and the agent's own co-author line. */
const NOT_A_PERSON = (a: { name: string; email: string }) => /\[bot\]/i.test(a.name) || /\[bot\]/i.test(a.email) || /^noreply@anthropic\.com$/i.test(a.email)

/** A first tasks/team.md from the git authors (`/progress team init`): one row per email, handles from names, roles to fill in. */
export function draftTeam(authors: { name: string; email: string }[]): string {
  const rows: { handle: string; email: string }[] = []
  for (const a of authors) {
    const email = a.email.trim().toLowerCase()
    if (!email || NOT_A_PERSON(a) || rows.some(r => r.email === email)) continue
    const base = `@${a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || email.split('@')[0]}`
    let handle = base
    for (let n = 2; rows.some(r => r.handle === handle); n++) handle = `${base}-${n}`
    rows.push({ handle, email })
  }
  return `---
approvals:
---
# Team

Who works on this project. The plugin knows you by your git email (\`git config user.email\`).
Roles are free words (lead, eng, design, product, qa); list in \`approvals:\` the roles that must sign a spec, or leave it empty for one approval.

| Handle | Role | Email |
|---|---|---|
${rows.map(r => `| ${r.handle} |  | ${r.email} |`).join('\n')}${rows.length ? '\n' : ''}`
}

/** `/progress team`: who is on it, what a spec needs, who you are, and anything wrong with the file. */
export function teamText(team: Team | null, email: string | null): string {
  if (!team) return 'No tasks/team.md here. /progress team init drafts one from the git authors.'
  const me = whoIs(team, email)
  const w = Math.max(0, ...team.members.map(m => m.handle.length)) + 2
  const rw = Math.max(0, ...team.members.map(m => (m.roles.join(', ') || 'no role').length))
  const lines = [`Team · ${TEAM_FILE} · ${team.members.length} ${team.members.length === 1 ? 'person' : 'people'}`]
  for (const m of team.members) {
    const roles = m.roles.join(', ') || 'no role'
    lines.push(`  ${m.handle.padEnd(w)}${m === me ? `${roles.padEnd(rw)} ← you` : roles}`)
  }
  lines.push(team.approvals.length ? `A spec needs approval from: ${team.approvals.join(', ')}.` : 'A spec needs one approval (add `approvals: product, design, eng` to ask for each role).')
  if (!email) lines.push("git config user.email is not set, so the plugin can't tell who you are.")
  else if (!me) lines.push(`You are ${email}, who is not in ${TEAM_FILE}: add a row with that email.`)
  for (const p of team.problems) lines.push(`! ${p}`)
  return lines.join('\n')
}
