// The agent-skills progress format (E1), kept by this plugin on top of the files
// agent-skills writes. agent-skills itself records only checkboxes; the format
// adds what a viewer needs to show state and time without guessing:
//
//   SPEC.md, specs/<module>.md, tasks/plan.md   front matter: status, created, approved
//   tasks/todo.md                               front matter: plan, created
//   each `## Task N:` section                   **Status:** in progress · started 2026-10-09 · step test
//
// Everything stays plain markdown, so other agents and editors read it as text.
// The full description is docs/progress-format.md. Pure: no Claude Code API.

export type TaskStatusWord = 'todo' | 'in progress' | 'in review' | 'done' | 'blocked'
export type TaskStep = 'build' | 'test' | 'commit'

/**
 * What a task's `**Status:**` line says. v2 (format-v2) adds who owns the task,
 * its pull request and its reviewer: `in review · @amila · started … · PR #42 · reviewer @bob`.
 */
export type TaskState = { status: TaskStatusWord; owner?: string; started?: string; done?: string; step?: TaskStep; pr?: string; reviewer?: string }

export const FORMAT_VERSION = 1

const DAY = /^\d{4}-\d{2}-\d{2}$/
const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

// ------------------------------------------------------------------ front matter

/** The front matter's `key: value` lines, and the text after it. */
export function readFrontMatter(text: string): { fields: Record<string, string>; body: string; hasFrontMatter: boolean } {
  const m = FM.exec(text)
  if (!m) return { fields: {}, body: text, hasFrontMatter: false }
  const fields: Record<string, string> = {}
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line)
    if (kv) fields[kv[1]!.toLowerCase()] = (kv[2] ?? '').replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '')
  }
  return { fields, body: text.slice(m[0].length), hasFrontMatter: true }
}

/**
 * The text with these front matter fields set (a null removes one): a line
 * replaced in place, a new one added at the end of the block, or a new block
 * on top. Every other byte is kept.
 */
export function setFrontMatter(text: string, fields: Record<string, string | null>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const m = FM.exec(text)
  let lines = m ? (m[1] ?? '').split(/\r?\n/) : []
  for (const [key, value] of Object.entries(fields)) {
    const at = lines.findIndex(l => new RegExp(`^${key}:`, 'i').test(l))
    if (value === null) {
      if (at >= 0) lines = lines.filter((_, i) => i !== at)
    } else if (at >= 0) lines[at] = `${key}: ${value}`
    else lines.push(`${key}: ${value}`)
  }
  const rest = m ? text.slice(m[0].length) : text
  if (lines.length === 0) return rest
  return `---${eol}${lines.join(eol)}${eol}---${eol}${rest}`
}

// ------------------------------------------------------------------ status lines

const STATUS_LINE = /^\s*\*\*Status:?\*\*:?\s*(.*)$/i

/** `**Status:** in progress · started 2026-10-09 · step test`, or null for another line. */
export function parseStatusLine(line: string): TaskState | null {
  const m = STATUS_LINE.exec(line)
  if (!m) return null
  // Matched in lower case; handles and links keep the case they were written in.
  const raw = (m[1] ?? '').split(/\s*[·|,;]\s*/).map(p => p.trim())
  const word = (raw[0] ?? '').toLowerCase()
  const status: TaskStatusWord = /^done|^complete/.test(word)
    ? 'done'
    : /^in[ -]?review|^review/.test(word)
      ? 'in review'
      : /^in[ -]?progress|^doing|^started|^building|^testing/.test(word)
        ? 'in progress'
        : /^blocked/.test(word)
          ? 'blocked'
          : 'todo'
  const state: TaskState = { status }
  for (const part of raw.slice(1)) {
    const reviewer = /^reviewer\s*:?\s*(@[\w.-]+)$/i.exec(part)
    const pr = /^pr\s*:?\s*(#\d+|https?:\/\/\S+)$/i.exec(part)
    if (reviewer) state.reviewer = reviewer[1]!
    else if (pr) state.pr = pr[1]!
    else if (/^@[\w.-]+$/.test(part)) state.owner = part
    const p = part.toLowerCase()
    const kv = /^(started|done|step)\s*:?\s*(.+)$/.exec(p)
    if (!kv) continue
    const value = kv[2]!.trim()
    if (kv[1] === 'step' && /^(build|test|commit)$/.test(value)) state.step = value as TaskStep
    else if (kv[1] === 'started' && DAY.test(value)) state.started = value
    else if (kv[1] === 'done' && DAY.test(value)) state.done = value
  }
  return state
}

/** The line for a state, in the order every tool writes it: status, owner, dates, step, PR, reviewer. */
export function statusLine(s: TaskState): string {
  const bits: string[] = [s.status]
  if (s.owner) bits.push(s.owner)
  if (s.started) bits.push(`started ${s.started}`)
  if (s.done) bits.push(`done ${s.done}`)
  if (s.step && s.status === 'in progress') bits.push(`step ${s.step}`)
  if (s.pr) bits.push(`PR ${s.pr}`)
  if (s.reviewer) bits.push(`reviewer ${s.reviewer}`)
  return `**Status:** ${bits.join(' · ')}`
}

const TASK_HEADING = /^#{1,6}\s+(?:\*\*)?Task\s+(\d+)\s*[:.\-–—]/i
const ANY_HEADING = /^#{1,6}\s/
const BOX = /^\s*[-*+]\s+\[([ xX])\]/

type Section = { id: string; heading: number; end: number; status: number | null; boxes: boolean[] }

/** Each `## Task N:` section: its heading line, where it ends, its Status line and its boxes. */
function sections(lines: string[]): Section[] {
  const out: Section[] = []
  let cur: Section | null = null
  let inFence = false
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) return
    if (ANY_HEADING.test(line)) {
      if (cur) cur.end = i
      const m = TASK_HEADING.exec(line)
      cur = m ? { id: `T${m[1]}`, heading: i, end: lines.length, status: null, boxes: [] } : null
      if (cur) out.push(cur)
      return
    }
    if (!cur) return
    if (cur.status === null && STATUS_LINE.test(line)) cur.status = i
    const b = BOX.exec(line)
    if (b) cur.boxes.push(b[1] !== ' ')
  })
  return out
}

/** Each task section's state as its Status line says, by id. */
export function taskStates(text: string): Record<string, TaskState> {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: Record<string, TaskState> = {}
  for (const s of sections(lines)) {
    const st = s.status === null ? null : parseStatusLine(lines[s.status]!)
    if (st) out[s.id] = st
  }
  return out
}

/**
 * `/progress assign T4 @sara` (format-v2, F2): the owner written on task `id`'s
 * Status line (added under its heading when it has none), or cleared with
 * null. Every other byte is kept. The text unchanged when there is no such task.
 */
export function setOwner(text: string, id: string, owner: string | null): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const s = sections(lines).find(x => x.id === id)
  if (!s) return text
  const next: TaskState = { ...((s.status === null ? null : parseStatusLine(lines[s.status]!)) ?? { status: 'todo' }) }
  if (owner) next.owner = owner
  else delete next.owner
  const line = statusLine(next)
  if (s.status === null) lines.splice(s.heading + 1, 0, line)
  else lines[s.status] = line
  return lines.join(eol)
}

/** A task's size (ceremonies, C1): `**Size:** M` on its own line under the Status line. */
export type TaskSize = 'S' | 'M' | 'L'

const SIZE_LINE = /^\s*\*\*Size:?\*\*:?\s*([SML])\s*$/i

/** A `**Size:**` line's size, or null for another line. */
export function parseSizeLine(line: string): TaskSize | null {
  const m = SIZE_LINE.exec(line)
  return m ? (m[1]!.toUpperCase() as TaskSize) : null
}

/**
 * `/progress size T4 M` (ceremonies T1): task `id`'s Size line written in place,
 * or under its Status line (under its heading when it has none), or removed with
 * null. Every other byte is kept. The text unchanged when there is no such task.
 */
export function setSize(text: string, id: string, size: TaskSize | null): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const s = sections(lines).find(x => x.id === id)
  if (!s) return text
  let at = -1
  let inFence = false
  for (let i = s.heading + 1; i < s.end && at < 0; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) inFence = !inFence
    else if (!inFence && parseSizeLine(lines[i]!)) at = i
  }
  if (size === null) {
    if (at < 0) return text
    lines.splice(at, 1)
  } else if (at >= 0) lines[at] = `**Size:** ${size}`
  else lines.splice((s.status ?? s.heading) + 1, 0, `**Size:** ${size}`)
  return lines.join(eol)
}

/** A backlog item's old task number (ceremonies, C2): `**Was:** T9 · deferred 2026-10-14 @amila`. */
export type Was = { id: string; day: string | null; by: string | null }

const WAS_LINE = /^\s*\*\*Was:?\*\*:?\s*T(\d+)\b(?:\s*·\s*deferred\s+(\d{4}-\d{2}-\d{2}))?(?:\s+(@[\w.-]+))?\s*$/i

/** A `**Was:**` line, or null for another line. */
export function parseWasLine(line: string): Was | null {
  const m = WAS_LINE.exec(line)
  return m ? { id: `T${m[1]}`, day: m[2] ?? null, by: m[3] ?? null } : null
}

/** A handoff (format-v2, F6): `**Handoff:** 2026-10-10 @sara → @bob: migration done, tests left`. */
export type Handoff = { day: string; from: string | null; to: string; note: string }

const HANDOFF_LINE = /^\s*\*\*Handoff:?\*\*:?\s*(\d{4}-\d{2}-\d{2})\s+(?:(@[\w.-]+)\s+)?(?:→|->)\s*(@[\w.-]+)\s*:\s*(.*)$/

/** A `**Handoff:**` line, or null for another line. */
export function parseHandoffLine(line: string): Handoff | null {
  const m = HANDOFF_LINE.exec(line)
  return m ? { day: m[1]!, from: m[2] ?? null, to: m[3]!, note: m[4]!.trim() } : null
}

/**
 * `/progress handoff T4 @bob "note"` (format-v2, F6): task `id` owned by `to`,
 * with a dated note under its Status line after any earlier ones. Every other
 * byte is kept. The text unchanged when there is no such task.
 */
export function addHandoff(text: string, id: string, h: Handoff): string {
  const owned = setOwner(text, id, h.to)
  const eol = owned.includes('\r\n') ? '\r\n' : '\n'
  const lines = owned.replace(/\r\n?/g, '\n').split('\n')
  const s = sections(lines).find(x => x.id === id)
  if (!s || s.status === null) return text
  let at = s.status + 1
  while (at < lines.length && parseHandoffLine(lines[at]!)) at++
  lines.splice(at, 0, `**Handoff:** ${h.day} ${h.from ? `${h.from} ` : ''}→ ${h.to}: ${h.note.replace(/\s*\n\s*/g, ' ').trim()}`)
  return lines.join(eol)
}

/** An answer to an open question (team-view): `  → A: Upstash · @pm 2026-10-11` on the line below it. */
export type Answer = { text: string; by: string | null; day: string | null }

const ANSWER_LINE = /^\s*(?:→|->)\s*A:\s*(.*?)\s*$/
/** The ` · @pm 2026-10-11` an answer ends with; the handle may be missing. */
const ANSWER_SIG = /^(.*?)\s*·\s*(?:(@[\w.-]+)\s+)?(\d{4}-\d{2}-\d{2})$/

/** An `→ A:` line, or null for another line. */
export function parseAnswerLine(line: string): Answer | null {
  const m = ANSWER_LINE.exec(line)
  if (!m) return null
  const sig = ANSWER_SIG.exec(m[1]!)
  return sig ? { text: sig[1]!, by: sig[2] ?? null, day: sig[3]! } : { text: m[1]!, by: null, day: null }
}

const QUESTION_ITEM = /^(\s*)[-*+]\s+(?:\*\*)?Q(\d+)\b/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/

/**
 * `/progress answer Q2 "Upstash"` (team-view): the answer written under
 * question `q` of tasks/plan.md's Open Questions, after any lines the question
 * wraps onto, in place of an earlier answer. Every other byte is kept. Null
 * when the plan has no such question.
 */
export function setAnswer(text: string, q: string, a: Answer): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const n = q.replace(/^Q/i, '')
  const head = lines.findIndex(l => /^##\s+Open Questions\s*$/i.test(l))
  if (head < 0) return null
  let at = -1
  for (let i = head + 1; i < lines.length && !/^##\s/.test(lines[i]!); i++) {
    const m = QUESTION_ITEM.exec(lines[i]!)
    if (m && m[2] === n) at = i
  }
  if (at < 0) return null
  const indent = QUESTION_ITEM.exec(lines[at]!)![1]!
  const sig = [a.by, a.day].filter(Boolean).join(' ')
  const line = `${indent}  → A: ${a.text.replace(/\s*\n\s*/g, ' ').trim()}${sig ? ` · ${sig}` : ''}`
  // The question's own lines: indented, not blank, not a list item or a heading.
  let end = at + 1
  while (end < lines.length && /^\s+\S/.test(lines[end]!) && !LIST_ITEM.test(lines[end]!)) {
    if (parseAnswerLine(lines[end]!)) {
      lines[end] = line
      return lines.join(eol)
    }
    end++
  }
  lines.splice(end, 0, line)
  return lines.join(eol)
}

/** A checkpoint signed off (team-view): `**Signed off:** @amila 2026-10-11` under its heading. */
export type SignOff = { by: string | null; day: string }

const SIGNED_OFF_LINE = /^\s*\*\*Signed off:?\*\*:?\s*(?:(@[\w.-]+)\s+)?(\d{4}-\d{2}-\d{2})\s*$/i
const CHECKPOINT_HEADING = /^#{1,6}\s+(?:\*\*)?Checkpoint\b/i

/** A `**Signed off:**` line, or null for another line. */
export function parseSignedOffLine(line: string): SignOff | null {
  const m = SIGNED_OFF_LINE.exec(line)
  return m ? { by: m[1] ?? null, day: m[2]! } : null
}

/**
 * `/progress signoff` (team-view): checkpoint `index` (counting the list's
 * `## Checkpoint` headings from 0) signed off, in place of an earlier sign-off,
 * and its review box ticked. Every other byte is kept. The text unchanged when
 * there is no such checkpoint.
 */
export function signOff(text: string, index: number, s: SignOff): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let inFence = false
  let n = -1
  let head = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) inFence = !inFence
    if (!inFence && CHECKPOINT_HEADING.test(lines[i]!) && ++n === index) {
      head = i
      break
    }
  }
  if (head < 0) return text
  let end = head + 1
  while (end < lines.length && !ANY_HEADING.test(lines[end]!)) end++
  for (let i = head + 1; i < end; i++) {
    const m = /^(\s*[-*+]\s+)\[ \](.*\breview\b.*)$/i.exec(lines[i]!)
    if (m) {
      lines[i] = `${m[1]}[x]${m[2]}`
      break
    }
  }
  const line = `**Signed off:** ${s.by ? `${s.by} ` : ''}${s.day}`
  if (head + 1 < lines.length && parseSignedOffLine(lines[head + 1]!)) lines[head + 1] = line
  else lines.splice(head + 1, 0, line)
  return lines.join(eol)
}

/**
 * `/progress review T4 #42 @bob` (format-v2, F4): task `id` in review, with the
 * PR and reviewer given (each kept from before when not given), owner and
 * dates kept. The text unchanged when there is no such task.
 */
export function setReview(text: string, id: string, opts: { pr?: string; reviewer?: string }): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const s = sections(lines).find(x => x.id === id)
  if (!s) return text
  const had = (s.status === null ? null : parseStatusLine(lines[s.status]!)) ?? { status: 'todo' as const }
  const next: TaskState = { ...had, status: 'in review', ...(opts.pr ? { pr: opts.pr } : {}), ...(opts.reviewer ? { reviewer: opts.reviewer } : {}) }
  delete next.step
  const line = statusLine(next)
  if (s.status === null) lines.splice(s.heading + 1, 0, line)
  else lines[s.status] = line
  return lines.join(eol)
}

/**
 * The task list with Status lines brought up to date:
 * - every `## Task N:` section has one, right under its heading;
 * - a task with every box ticked is `done`, dated `today` unless it has a date;
 * - a task with some boxes ticked and no state yet is `in progress`;
 * - `changes` (the plugin's own observations: started, step) merge in last;
 * - front matter gets `plan` and `created` when missing.
 * Returns the text unchanged when there is nothing to add.
 */
export function stampTodo(
  text: string,
  today: string,
  opts: {
    changes?: Record<string, Partial<TaskState>>
    plan?: string
    /** For a project already under way: the file's first commit day, and the day git first shows each task done. */
    created?: string
    doneDays?: Record<string, string>
    /** Only this task's Status line, and no front matter: what one live write owns (team-view, T11). */
    only?: string
  } = {},
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const secs = sections(lines).filter(s => opts.only === undefined || s.id === opts.only)
  if (secs.length === 0) return text
  // Edit from the bottom so earlier line numbers stay put.
  for (const s of [...secs].reverse()) {
    const had = s.status === null ? null : parseStatusLine(lines[s.status]!)
    const allTicked = s.boxes.length > 0 && s.boxes.every(Boolean)
    const someTicked = s.boxes.some(Boolean)
    let next: TaskState = had ? { ...had } : { status: 'todo' }
    const change = opts.changes?.[s.id]
    // Work going on under a task in review leaves it in review: only its last box (done) or a person moves it on.
    // A queued owner (auto-claim) fills an empty owner and never replaces one: a person's assignment wins.
    if (change && next.status !== 'done') next = { ...next, ...change, owner: next.owner ?? change.owner, started: next.started ?? change.started, status: next.status === 'in review' && change.status === 'in progress' ? 'in review' : (change.status ?? next.status) }
    if (!next.owner) delete next.owner
    if (allTicked) next = { ...next, status: 'done', done: next.done ?? opts.doneDays?.[s.id] ?? today }
    else if (next.status === 'done' && s.boxes.length > 0) next = { ...next, status: 'in progress', done: undefined }
    else if (someTicked && next.status === 'todo') next = { ...next, status: 'in progress', started: next.started ?? today }
    if (next.status === 'in progress' && !next.started) next.started = today
    if (next.status !== 'in progress') delete next.step
    if (next.status !== 'done') delete next.done
    const line = statusLine(next)
    if (s.status === null) lines.splice(s.heading + 1, 0, line)
    else if (lines[s.status] !== line) lines[s.status] = line
  }
  let out = lines.join(eol)
  if (opts.only !== undefined) return out
  const fm = readFrontMatter(out)
  const want: Record<string, string> = {}
  if (!fm.fields.plan && opts.plan) want.plan = opts.plan
  if (!fm.fields.created) want.created = opts.created ?? today
  if (Object.keys(want).length) out = setFrontMatter(out, want)
  return out
}

/**
 * A spec's or plan's front matter brought up to date: `status: draft` and
 * `created` when missing, and an `approved` date once the status is approved.
 */
export function stampDoc(text: string, today: string, past: Past = {}): string {
  const { fields } = readFrontMatter(text)
  const want: Record<string, string> = {}
  const status = (fields.status ?? '').toLowerCase()
  if (status !== 'draft' && status !== 'approved') want.status = 'draft'
  if (!fields.created) want.created = past.created ?? today
  const created = DAY.test(fields.created ?? '') ? fields.created! : want.created
  if (status === 'approved' && !DAY.test(fields.approved ?? '')) want.approved = latest(past.approved ?? today, created)
  return Object.keys(want).length ? setFrontMatter(text, want) : text
}

/**
 * What git shows about a file of a project already under way: the day it was
 * first committed, and for a spec the day it was evidently approved (the plan's
 * first commit, as agent-skills plans only after approval).
 */
export type Past = { created?: string; approved?: string }

const latest = (a: string, b: string | undefined) => (b && b > a ? b : a)

/**
 * Front matter stamped with the day the format came in, moved back to what git
 * shows: a `created` later than the file's first commit, and an `approved`
 * written the same day as that `created`, later than the plan's first commit.
 * An approval of its own day (a spec approved again after a change) is kept.
 */
export function backdateDoc(text: string, past: Past): string {
  const { fields } = readFrontMatter(text)
  const want: Record<string, string> = {}
  const created = fields.created ?? ''
  if (past.created && DAY.test(created) && created > past.created) want.created = past.created
  const approved = fields.approved ?? ''
  if (want.created && past.approved && approved === created && approved > past.approved) want.approved = latest(past.approved, want.created)
  return Object.keys(want).length ? setFrontMatter(text, want) : text
}

/**
 * A task list's dates moved back to what git shows: `created` later than the
 * file's first commit, and done dates later than the day git first shows the
 * task done (a start after that moves with it).
 */
export function backdateTodo(text: string, past: { created?: string; doneDays?: Record<string, string> }): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (const s of sections(lines)) {
    const day = past.doneDays?.[s.id]
    if (s.status === null || !day) continue
    const st = parseStatusLine(lines[s.status]!)
    if (!st || st.status !== 'done' || !st.done || st.done <= day) continue
    const next: TaskState = { ...st, done: day }
    if (next.started && next.started > day) next.started = day
    lines[s.status] = statusLine(next)
  }
  let out = lines.join(eol)
  const created = readFrontMatter(out).fields.created ?? ''
  if (past.created && DAY.test(created) && created > past.created) out = setFrontMatter(out, { created: past.created })
  return out
}

/** A short name for a plan, from the task list's title: `# Tasks: API keys` → `api-keys`. */
export function planName(text: string): string | undefined {
  const title = /^#\s+(.*)$/m.exec(readFrontMatter(text).body)?.[1]
  if (!title) return undefined
  const name = title
    .replace(/^(tasks|todo|task list|implementation plan|plan)\s*[:\-–—]\s*/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return name || undefined
}

// ------------------------------------------------------------------ edits

/**
 * An Edit rewritten so that, applied to `before`, it yields `after`: the span
 * between the first and last differing lines. Null when that span is not
 * unique in `before`, so the original edit should go through as it was.
 */
export function editBetween(before: string, after: string): { old_string: string; new_string: string } | null {
  if (before === after) return null
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--
  // Take a line of context each side, so an insertion has text to anchor to.
  const from = Math.max(0, start - 1)
  const toA = Math.min(a.length, endA + 1)
  const toB = Math.min(b.length, endB + 1)
  const old_string = a.slice(from, toA).join('\n')
  const new_string = b.slice(from, toB).join('\n')
  if (!old_string || before.indexOf(old_string) !== before.lastIndexOf(old_string)) return null
  return { old_string, new_string }
}

/** The text an Edit produces, as the Edit tool applies it; null when it would fail. */
export function applyEdit(text: string, old_string: string, new_string: string, replaceAll = false): string | null {
  const at = text.indexOf(old_string)
  if (at < 0 || old_string === '') return null
  if (replaceAll) return text.split(old_string).join(new_string)
  if (text.indexOf(old_string, at + 1) >= 0) return null
  return text.slice(0, at) + new_string + text.slice(at + old_string.length)
}

// ------------------------------------------------------------------ instructions

/** What Claude is told, every session, about keeping the format. */
export const FORMAT_RULES = [
  'agent-skills progress format (kept by the agent-skills-mods plugin; agent-skills itself only writes checkboxes). Keep it whenever you write or update these files:',
  '- SPEC.md, specs/<module>.md, SPEC-<id>.md and tasks/plan.md start with front matter: `status: draft` and `created: YYYY-MM-DD`. When the user approves the document, set `status: approved` and `approved: YYYY-MM-DD`. Never mark a document approved yourself.',
  '- tasks/todo.md starts with front matter `plan: <short-name>` and `created: YYYY-MM-DD`.',
  '- Each `## Task N: title` section has a `**Status:**` line right under its heading: `**Status:** todo`, `**Status:** in progress · started YYYY-MM-DD · step build|test|commit`, `**Status:** done · started YYYY-MM-DD · done YYYY-MM-DD`, or `**Status:** blocked` (say why under Open questions in tasks/plan.md, naming the task as T<N>).',
  '- Task numbers are stable ids (T<N>): never renumber; new tasks take the next free number. Write dependencies as `**Dependencies:** T1, T2` (or None).',
  '- Open questions in tasks/plan.md are numbered and name the tasks they block: `- Q2 (T6): Upstash Redis or self-hosted for the sliding window?`.',
  '- When you start a task, set it to in progress with today as started; when you tick its last box, set it to done with today\'s date. The plugin also updates Status lines itself (from your edits, test runs and commits), so re-read tasks/todo.md before editing it.',
  '- Teams (v2): a Status line may also carry an owner and, for a task in review, its PR and reviewer: `**Status:** in review · @sara · started YYYY-MM-DD · PR #42 · reviewer @bob`. Keep every token when you rewrite the line. Who owns or reviews a task is set by people (`/progress assign`, `claim`, `review`, `handoff`); change it only when asked.',
  '- A task may have `**Handoff:** YYYY-MM-DD @from → @to: note` lines under its Status line: read them before working on the task, and never remove them.',
  '- When tasks/team.md has `approvals: <roles>`, a spec is approved only once every listed role has signed in its front matter `approvals:` (`role @handle YYYY-MM-DD`, comma-separated); `status: approved` comes with the last signature. Record a signature only for the person who approved, by their own role, and never sign for anyone.',
  '- A task list may name the module of SPEC.md\'s capability map it builds: `module: <id>` in its front matter.',
  '- An answered open question in tasks/plan.md has its answer on the line below it: `  → A: <answer> · @handle YYYY-MM-DD`. An answered question no longer blocks its task. Write an answer only when the person gives it (`/progress answer Q2 "…"`), in their name, and never answer for anyone.',
  '- A checkpoint the person has reviewed has `**Signed off:** @handle YYYY-MM-DD` on the line below its heading, and its review box ticked (`/progress signoff`). Never sign off for anyone.',
  '- A task may have a size on its own line under its Status line: `**Size:** S`, `M` or `L` (S = ½ point, M = 1, L = 2; a task without one counts as 1). Sizes are set by people (`/progress size T4 M`); keep the line when you rewrite the section, and don\'t add or change one unless asked.',
  '- tasks/backlog.md, when there is one, holds work not yet scheduled: `## B<N>: title` items in the task shape (boxes, `**Size:**`, `**Dependencies:**` naming T ids). An item deferred from tasks/todo.md keeps its old number on a `**Was:** T9 · deferred YYYY-MM-DD @handle` line. B numbers are stable ids too; add items with `/progress backlog add "title" [S|M|L]`. The next free task number counts those `Was:` numbers as well, so a deferred number is never given to a new task. Tasks move between the two files with `/progress pull B3` and `/progress defer T9`; don\'t move them by hand unless asked.',
].join('\n')

// ------------------------------------------------------------------ the person's own changes

/** Every box in task `id`'s section ticked (`/progress done T4`). */
export function tickTask(text: string, id: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const sec = sections(lines).find(s => s.id === id)
  if (!sec) return text
  for (let i = sec.heading + 1; i < sec.end; i++) lines[i] = lines[i]!.replace(/^(\s*[-*+]\s+)\[ \]/, '$1[x]')
  return lines.join(eol)
}

/** Whether task `id` has a `## Task N:` section the format can stamp. */
export const hasTaskSection = (text: string, id: string) => sections(text.replace(/\r\n?/g, '\n').split('\n')).some(s => s.id === id)

/**
 * The plan with a numbered open question for a blocked task added under
 * `## Open Questions` (made when missing): `- Q3 (T6): why`.
 */
export function addQuestion(planText: string | null, id: string, why: string): { text: string; q: string } {
  const base = planText ?? '# Implementation Plan\n'
  const used = [...base.matchAll(/^\s*[-*+]\s+Q(\d+)\b/gm)].map(m => Number(m[1]))
  const q = `Q${(used.length ? Math.max(...used) : 0) + 1}`
  const line = `- ${q} (${id}): ${why}`
  const head = /^##\s+Open Questions\s*$/im.exec(base)
  if (!head) return { text: `${base.replace(/\s*$/, '')}\n\n## Open Questions\n\n${line}\n`, q }
  // After the section's last list item, or right under its heading.
  const after = base.slice(head.index + head[0].length)
  const next = /^##\s/m.exec(after)
  const body = next ? after.slice(0, next.index) : after
  const insertAt = head.index + head[0].length + body.replace(/\s*$/, '').length
  return { text: `${base.slice(0, insertAt)}\n${line}${base.slice(insertAt)}`, q }
}

/**
 * Spec drift: the new text of an approved spec whose content changed goes
 * back to `status: draft`. The `approved` date stays as the last approval, so
 * `/spec-view diff` compares against it. Null when nothing drifted.
 */
export function driftedSpec(before: string, after: string): string | null {
  const was = readFrontMatter(before)
  if ((was.fields.status ?? '').toLowerCase() !== 'approved') return null
  const now = readFrontMatter(after)
  if ((now.fields.status ?? '').toLowerCase() !== 'approved') return null
  if (was.body.trim() === now.body.trim()) return null
  // The signatures were for the text before this change (format-v2): they go too.
  return setFrontMatter(after, { status: 'draft', approvals: null })
}

/** Box `index` (in order, within task `id`'s section) ticked or unticked; the text unchanged when there is no such box. */
export function toggleBox(text: string, id: string, index: number): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const sec = sections(lines).find(s => s.id === id)
  if (!sec) return text
  let n = -1
  for (let i = sec.heading + 1; i < sec.end; i++) {
    const m = /^(\s*[-*+]\s+)\[([ xX])\](.*)$/.exec(lines[i]!)
    if (!m || ++n !== index) continue
    lines[i] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${m[3]}`
    return lines.join(eol)
  }
  return text
}
