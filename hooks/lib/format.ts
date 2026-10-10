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

export type TaskStatusWord = 'todo' | 'in progress' | 'done' | 'blocked'
export type TaskStep = 'build' | 'test' | 'commit'

/** What a task's `**Status:**` line says. */
export type TaskState = { status: TaskStatusWord; started?: string; done?: string; step?: TaskStep }

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
  const parts = (m[1] ?? '').split(/\s*[·|,;]\s*/).map(p => p.trim().toLowerCase())
  const word = parts[0] ?? ''
  const status: TaskStatusWord = /^done|^complete/.test(word)
    ? 'done'
    : /^in[ -]?progress|^doing|^started|^building|^testing/.test(word)
      ? 'in progress'
      : /^blocked/.test(word)
        ? 'blocked'
        : 'todo'
  const state: TaskState = { status }
  for (const p of parts.slice(1)) {
    const kv = /^(started|done|step)\s*:?\s*(.+)$/.exec(p)
    if (!kv) continue
    const value = kv[2]!.trim()
    if (kv[1] === 'step' && /^(build|test|commit)$/.test(value)) state.step = value as TaskStep
    else if (kv[1] === 'started' && DAY.test(value)) state.started = value
    else if (kv[1] === 'done' && DAY.test(value)) state.done = value
  }
  return state
}

/** The line for a state, in the order every tool writes it. */
export function statusLine(s: TaskState): string {
  const bits: string[] = [s.status]
  if (s.started) bits.push(`started ${s.started}`)
  if (s.done) bits.push(`done ${s.done}`)
  if (s.step && s.status === 'in progress') bits.push(`step ${s.step}`)
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
  } = {},
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const secs = sections(lines)
  if (secs.length === 0) return text
  // Edit from the bottom so earlier line numbers stay put.
  for (const s of [...secs].reverse()) {
    const had = s.status === null ? null : parseStatusLine(lines[s.status]!)
    const allTicked = s.boxes.length > 0 && s.boxes.every(Boolean)
    const someTicked = s.boxes.some(Boolean)
    let next: TaskState = had ? { ...had } : { status: 'todo' }
    const change = opts.changes?.[s.id]
    if (change && next.status !== 'done') next = { ...next, ...change, started: next.started ?? change.started }
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
  return setFrontMatter(after, { status: 'draft' })
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
