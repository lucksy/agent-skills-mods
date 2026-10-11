// The task-aware merge (team-view, T7): git hands the merge driver the base, ours
// and theirs of tasks/todo.md, a plan or a spec, and these functions merge them
// by task and by role instead of by line:
//
//   a task on both sides      boxes ticked on either side; the later-stamped Status line
//                             (done date, then started); ours on a tie (Q3); Handoff lines combined by date
//   a task on one side        kept
//   the same number added     ours keeps it; theirs takes the next free one, Dependencies rewritten
//                             (never a number tasks/backlog.md records as an item's old one, ceremonies T4)
//   tasks/backlog.md          the same, item by item, with B ids (ceremonies T4)
//   deleted vs edited         conflict markers around that task only
//   approvals: (front matter) combined by role, the earlier signature wins; status worked out again
//   anything else             the handed-in line merge (git merge-file in the CLI)
//
// Never drops content: whatever can't be settled ends up inside markers. Pure.

import { parseApprovals, type Signature } from './approvals'
import { parseHandoffLine, parseStatusLine, setFrontMatter } from './format'

/**
 * A three-way line merge of three texts that each end with a newline: the
 * merged text (with the usual markers where it couldn't) and whether it was
 * clean. The CLI hands in `git merge-file`; `wholeMerge` is the fallback.
 */
export type LineMerge = (base: string, ours: string, theirs: string) => { text: string; clean: boolean }

export type MergeOpts = {
  lineMerge?: LineMerge
  /** The roles tasks/team.md requires (mergeFrontMatter): `status: approved` is worked out again from them. */
  required?: string[]
  /** mergeTodo (ceremonies T4): `backlog` merges tasks/backlog.md's `## B<n>:` items instead of tasks. */
  items?: 'tasks' | 'backlog'
  /** mergeTodo (ceremonies T4): task numbers a renumbered task must not take, the backlog's `Was:` ones. */
  reserved?: number[]
}

export type MergeResult = { text: string; conflicts: string[] }

const OURS = '<<<<<<< ours'
const SPLIT = '======='
const THEIRS = '>>>>>>> theirs'

const nl = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`)
const markers = (ours: string, theirs: string) => `${OURS}\n${nl(ours)}${SPLIT}\n${nl(theirs)}${THEIRS}\n`

/** The line merge with no line-level diff: a side wins when the other is unchanged; else both sides inside markers. */
export const wholeMerge: LineMerge = (base, ours, theirs) => {
  if (ours === theirs || theirs === base) return { text: ours, clean: true }
  if (ours === base) return { text: theirs, clean: true }
  return { text: markers(ours, theirs), clean: false }
}

// ------------------------------------------------------------------ front matter and prose

const FM = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/
const KV = /^([A-Za-z][\w-]*):/

/**
 * A document's front matter merged key by key (when every line in it is a
 * plain `key: value`), and its body by the line merge. Texts use `\n`.
 */
function mergeDoc(base: string, ours: string, theirs: string, lineMerge: LineMerge): MergeResult {
  if (ours === theirs || theirs === base) return { text: ours, conflicts: [] }
  if (ours === base) return { text: theirs, conflicts: [] }
  const [b, o, t] = [FM.exec(base), FM.exec(ours), FM.exec(theirs)]
  if (!o || !t || (!b && base.trim() !== '')) {
    const r = lineMerge(nl(base), nl(ours), nl(theirs))
    return { text: r.text, conflicts: r.clean ? [] : ['both sides changed the same lines'] }
  }
  const conflicts: string[] = []
  const lines = (m: RegExpExecArray | null) => (m ? m[1]!.split('\n') : [])
  const [bl, ol, tl] = [lines(b), lines(o), lines(t)]
  let head: string
  const keyed = [bl, ol, tl].every(ls => ls.every(l => KV.test(l)))
  const byKey = (ls: string[]) => new Map(ls.map(l => [KV.exec(l)![1]!.toLowerCase(), l]))
  const merged = keyed ? mergeKeys(byKey(bl), ol, byKey(tl), tl) : null
  if (merged) head = merged.join('\n')
  else {
    const r = lineMerge(nl(bl.join('\n')), nl(ol.join('\n')), nl(tl.join('\n')))
    head = r.text.replace(/\n$/, '')
    if (!r.clean) conflicts.push('front matter: both sides changed the same lines')
  }
  const rest = (s: string, m: RegExpExecArray | null) => (m ? s.slice(m[0].length) : s)
  const [bb, ob, tb] = [rest(base, b), rest(ours, o), rest(theirs, t)]
  let body = ob
  if (!(ob === tb || tb === bb)) {
    if (ob === bb) body = tb
    else {
      const r = lineMerge(nl(bb), nl(ob), nl(tb))
      body = ob.endsWith('\n') || tb.endsWith('\n') ? r.text : r.text.replace(/\n$/, '')
      if (!r.clean) conflicts.push('both sides changed the same lines')
    }
  }
  // Ours' own `---` lines around the merged keys.
  return { text: `---\n${head}${o[0].slice(4 + o[1]!.length)}${body}`, conflicts }
}

/** Front-matter lines merged key by key from ours, or null when both sides changed one key differently. */
function mergeKeys(base: Map<string, string>, ours: string[], theirs: Map<string, string>, theirLines: string[]): string[] | null {
  const out = [...ours]
  const at = (key: string) => out.findIndex(l => KV.exec(l)![1]!.toLowerCase() === key)
  const keys = new Set([...base.keys(), ...theirs.keys(), ...ours.map(l => KV.exec(l)![1]!.toLowerCase())])
  for (const key of keys) {
    const [b, o, t] = [base.get(key), at(key) >= 0 ? out[at(key)] : undefined, theirs.get(key)]
    if (o === t || t === b) continue
    if (o !== b) return null
    const i = at(key)
    if (t === undefined) out.splice(i, 1)
    else if (i >= 0) out[i] = t
    else {
      // After the key theirs has before it, as theirs placed it.
      const before = theirLines.slice(0, theirLines.indexOf(t)).reverse().map(l => at(KV.exec(l)![1]!.toLowerCase())).find(j => j >= 0)
      out.splice(before === undefined ? out.length : before + 1, 0, t)
    }
  }
  return out
}

/**
 * A spec's or plan's merge (V3): `approvals:` combined by role (the earlier
 * signature wins a role both signed), `status:` worked out again from
 * `required` when it is given, and every other key and the prose through the
 * line merge. Pure; never drops content.
 */
export function mergeFrontMatter(base: string, ours: string, theirs: string, opts: MergeOpts = {}): MergeResult {
  const lineMerge = opts.lineMerge ?? wholeMerge
  const eol = ours.includes('\r\n') ? '\r\n' : '\n'
  const b = base.replace(/\r\n?/g, '\n')
  let [o, t] = [ours, theirs].map(s => s.replace(/\r\n?/g, '\n')) as [string, string]
  const approvals = (s: string) => {
    const m = FM.exec(s)
    const line = m?.[1]!.split('\n').find(l => /^approvals:/i.test(l))
    return line === undefined ? null : line.replace(/^approvals:\s*/i, '').trim()
  }
  const [ov, tv] = [approvals(o), approvals(t)]
  if (ov !== tv && (ov !== null || tv !== null)) {
    const [os, ts] = [parseApprovals(ov ?? undefined), parseApprovals(tv ?? undefined)]
    const all = combine(os, ts)
    const same = (x: Signature[]) => x.length === all.length && x.every((s, i) => s.role === all[i]!.role && s.handle === all[i]!.handle && s.day === all[i]!.day)
    const value = same(os) && ov !== null ? ov : same(ts) && tv !== null ? tv : all.map(s => `${s.role} ${s.handle} ${s.day}`).join(', ')
    const fields: Record<string, string> = { approvals: value }
    if (opts.required?.length) {
      const signed = opts.required.map(r => all.find(s => s.role === r))
      const complete = signed.every(Boolean)
      fields.status = complete ? 'approved' : 'draft'
      if (complete) fields.approved = signed.map(s => s!.day).sort().pop()!
    }
    ;[o, t] = [setFrontMatter(o, fields), setFrontMatter(t, fields)]
  }
  const r = mergeDoc(b, o, t, lineMerge)
  return { text: r.text.replace(/\n/g, eol), conflicts: r.conflicts }
}

/** Ours' signatures, with theirs added by role; a role both signed keeps the earlier day (ours on a tie). */
function combine(ours: Signature[], theirs: Signature[]): Signature[] {
  const out = [...ours]
  for (const s of theirs) {
    const i = out.findIndex(x => x.role === s.role)
    if (i < 0) out.push(s)
    else if (s.day < out[i]!.day) out[i] = s
  }
  return out
}

// ------------------------------------------------------------------ task lists

const TASK_HEADING = /^(#{1,6}\s+(?:\*\*)?Task\s+)(\d+)(\s*[:.\-–—]\s*)(.*)$/i
const ITEM_HEADING = /^(#{1,6}\s+(?:\*\*)?B)(\d+)(\s*[:.\-–—]\s*)(.*)$/i
const ANY_HEADING = /^#{1,6}\s/
const BOX = /^(\s*[-*+]\s+\[)([ xX~])(\]\s+)(.*)$/
const DEPS = /^(\s*\*\*Dependencies:?\*\*:?)(.*)$/i

/** A stretch of the file from one heading to the next: the preamble, a task, a checkpoint, a phase. */
type Block = {
  key: string
  /** `T3` for a task, null otherwise. */
  id: string | null
  title: string
  /** Its lines without the blank lines at its end. */
  lines: string[]
  /** How many blank lines end it. */
  trail: number
  last: boolean
}

/** The text's blocks in order. Keys are the task id (`T3`, or `B3` for a backlog item), or the heading line for anything else (`#2` on a repeat). */
function blocks(text: string, heading = TASK_HEADING, prefix = 'T'): Block[] {
  const lines = text.split('\n')
  const out: Block[] = []
  const seen = new Map<string, number>()
  let cur: string[] = []
  let head: string | null = null
  let inFence = false
  const close = () => {
    const m = head === null ? null : heading.exec(head)
    const id = m ? `${prefix}${Number(m[2])}` : null
    const base = head === null ? '^' : (id ?? head.trim())
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    let trail = 0
    while (cur.length && cur[cur.length - 1] === '') {
      cur.pop()
      trail++
    }
    out.push({ key: n > 1 ? `${base}#${n}` : base, id, title: m ? m[4]!.trim().toLowerCase() : '', lines: cur, trail, last: false })
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && ANY_HEADING.test(line)) {
      close()
      cur = []
      head = line
    }
    cur.push(line)
  }
  close()
  out[out.length - 1]!.last = true
  return out
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i])
const label = (b: Block) => b.id ?? (b.key === '^' ? 'the top of the file' : b.key.replace(/^#+\s*/, ''))

/** Ours' version of a block when theirs didn't change it from base, theirs' when ours didn't, else null. */
function oneSide(b: string[] | null, o: string[], t: string[]): string[] | null {
  if (sameLines(o, t)) return o
  if (b && sameLines(b, t)) return o
  if (b && sameLines(b, o)) return t
  return null
}

/** A Status line's stamp, for "the later one wins": the done date, then the started date. */
const stamp = (line: string) => {
  const s = parseStatusLine(line)
  return `${s?.done ?? '0000-00-00'} ${s?.started ?? '0000-00-00'}`
}

/** The block without its Status and Handoff lines, where they stood, and the lines themselves. */
function pullState(lines: string[]) {
  const rest: string[] = []
  let status: string | null = null
  const handoffs: string[] = []
  let at: number | null = null
  let inFence = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const isStatus = !inFence && status === null && parseStatusLine(line) !== null
    const isHandoff = !inFence && parseHandoffLine(line) !== null
    if (isStatus || isHandoff) {
      at ??= rest.length
      if (isStatus) status = line
      else handoffs.push(line)
    } else rest.push(line)
  }
  return { rest, status, handoffs, at }
}

/** Box lines with every tick taken out, and the ticks by box text and repeat. */
function pullTicks(lines: string[]) {
  const ticks = new Map<string, string>()
  const count = new Map<string, number>()
  const plain = lines.map(line => {
    const m = BOX.exec(line)
    if (!m) return line
    const n = (count.get(m[4]!) ?? 0) + 1
    count.set(m[4]!, n)
    if (m[2] !== 'x' && m[2] !== 'X') return line
    ticks.set(`${m[4]}#${n}`, m[2]!)
    return `${m[1]} ${m[3]}${m[4]}`
  })
  return { plain, ticks }
}

/** The ticks put back on the merged lines. Inside markers, theirs' half counts its boxes again from where ours' started. */
function putTicks(lines: string[], ticks: Map<string, string>): string[] {
  let count = new Map<string, number>()
  let saved = count
  return lines.map(line => {
    if (line.startsWith('<<<<<<<')) saved = new Map(count)
    if (line === SPLIT) count = new Map(saved)
    const m = BOX.exec(line)
    if (!m) return line
    const n = (count.get(m[4]!) ?? 0) + 1
    count.set(m[4]!, n)
    const tick = ticks.get(`${m[4]}#${n}`)
    return tick && m[2] !== 'x' && m[2] !== 'X' ? `${m[1]}${tick}${m[3]}${m[4]}` : line
  })
}

/** One block that is on both sides (and maybe in base): the merge-rules row for a task, the line merge for the rest. */
function mergeBlock(base: Block | null, ours: Block, theirs: Block, lineMerge: LineMerge): { lines: string[]; clean: boolean } {
  const b = base?.lines ?? null
  const easy = oneSide(b, ours.lines, theirs.lines)
  if (easy) return { lines: easy, clean: true }
  if (ours.key === '^') {
    const r = mergeDoc(nl((b ?? []).join('\n')), nl(ours.lines.join('\n')), nl(theirs.lines.join('\n')), lineMerge)
    return { lines: r.text.replace(/\n$/, '').split('\n'), clean: !r.conflicts.length }
  }
  const [sb, so, st] = [pullState(b ?? []), pullState(ours.lines), pullState(theirs.lines)]
  // The Status line: a three-way pick, then the later stamp when both changed it.
  let status = so.status
  if (so.status !== st.status && st.status !== sb.status) {
    if (so.status === sb.status || so.status === null) status = st.status
    else if (st.status !== null && stamp(st.status) > stamp(so.status)) status = st.status
  }
  const handoffs = [...so.handoffs, ...st.handoffs.filter(h => !so.handoffs.includes(h))]
  handoffs.sort((x, y) => parseHandoffLine(x)!.day.localeCompare(parseHandoffLine(y)!.day))
  const [pb, po, pt] = [pullTicks(sb.rest), pullTicks(so.rest), pullTicks(st.rest)]
  const ticks = new Map([...pt.ticks, ...po.ticks])
  let rest = oneSide(b ? pb.plain : null, po.plain, pt.plain)
  let clean = true
  if (!rest) {
    const r = lineMerge(nl(pb.plain.join('\n')), nl(po.plain.join('\n')), nl(pt.plain.join('\n')))
    rest = r.text.replace(/\n$/, '').split('\n')
    clean = r.clean
  }
  rest = putTicks(rest, ticks)
  const state = [...(status === null ? [] : [status]), ...handoffs]
  const at = Math.min(so.at ?? st.at ?? 1, rest.length)
  return { lines: [...rest.slice(0, at), ...state, ...rest.slice(at)], clean }
}

/**
 * Theirs' blocks with each renumbered task's heading and every Dependencies line that names it rewritten.
 * A backlog item's Dependencies name tasks, not items, so `deps` is off for the backlog.
 */
function renumber(theirs: Block[], moves: Map<string, string>, heading = TASK_HEADING, deps = true): Block[] {
  const num = (id: string) => id.replace(/#\d+$/, '').slice(1)
  const byNumber = new Map([...moves].map(([from, to]) => [num(from), num(to)]))
  return theirs.map(block => {
    const to = block.id && moves.get(block.key)
    const lines = block.lines.map((line, i) => {
      if (i === 0 && to) return line.replace(heading, (_, a, _n, c, d) => `${a}${num(to)}${c}${d}`)
      const named = deps ? DEPS.exec(line) : null
      if (!named) return line
      return named[1]! + named[2]!.replace(/\b((?:T(?:ask)?\s*)?)(\d+)\b/gi, (m, p, n) => (byNumber.has(n) ? `${p}${byNumber.get(n)}` : m))
    })
    return to ? { ...block, key: to, id: to, lines } : { ...block, lines }
  })
}

/** The task-aware merge (V3): base, ours and theirs in, the merged text and what needed markers out. Pure; never drops content. */
export function mergeTodo(base: string, ours: string, theirs: string, opts: MergeOpts = {}): { text: string; conflicts: string[]; renumbered: [string, string][] } {
  if (ours === theirs || theirs === base) return { text: ours, conflicts: [], renumbered: [] }
  if (ours === base) return { text: theirs, conflicts: [], renumbered: [] }
  const lineMerge = opts.lineMerge ?? wholeMerge
  const eol = ours.includes('\r\n') ? '\r\n' : '\n'
  const unix = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  const endsWithNewline = /\n$/.test(ours)
  const backlog = opts.items === 'backlog'
  const [heading, prefix] = backlog ? [ITEM_HEADING, 'B'] : [TASK_HEADING, 'T']
  const [bs, os] = [blocks(unix(base), heading, prefix), blocks(unix(ours), heading, prefix)]
  let ts = blocks(unix(theirs), heading, prefix)
  const [bm, om] = [new Map(bs.map(x => [x.key, x])), new Map(os.map(x => [x.key, x]))]

  // A number added on both sides for two different tasks: theirs moves to the next free one.
  const used = new Set([...bs, ...os, ...ts].flatMap(x => (x.id ? [Number(x.id.slice(1))] : [])))
  // A deferred task's old number is never given to another (ceremonies T4).
  for (const n of backlog ? [] : (opts.reserved ?? [])) used.add(n)
  let free = Math.max(0, ...used)
  const moves = new Map<string, string>()
  for (const t of ts) {
    const o = om.get(t.key)
    if (!t.id || !o?.id || bm.has(t.key) || o.title === t.title) continue
    while (used.has(++free));
    used.add(free)
    moves.set(t.key, `${prefix}${free}`)
  }
  if (moves.size) ts = renumber(ts, moves, heading, !backlog)
  const tm = new Map(ts.map(x => [x.key, x]))

  // Ours' order, with theirs' blocks put after the block theirs has before them.
  const order = os.filter(o => tm.has(o.key) || !bm.has(o.key) || !sameLines(bm.get(o.key)!.lines, o.lines)).map(o => o.key)
  let anchor = -1
  for (const t of ts) {
    const i = order.indexOf(t.key)
    if (i >= 0) {
      anchor = i
      continue
    }
    if (!om.has(t.key) && bm.has(t.key) && sameLines(bm.get(t.key)!.lines, t.lines)) continue
    // A new block goes after ours' new blocks at the same spot; one from base stays where base had it.
    let at = anchor + 1
    while (!bm.has(t.key) && at < order.length && !tm.has(order[at]!)) at++
    order.splice(at, 0, t.key)
    anchor = at
  }

  const conflicts: string[] = []
  const out = order.map((key, i) => {
    const [b, o, t] = [bm.get(key) ?? null, om.get(key) ?? null, tm.get(key) ?? null]
    const src = (o ?? t)!
    let lines: string[]
    if (o && t) {
      const r = mergeBlock(b, o, t, lineMerge)
      lines = r.lines
      if (!r.clean) conflicts.push(`${label(src)}: both sides changed the same lines`)
    } else if (b) {
      // On one side only, and in base: the other side deleted it, and this one changed it.
      lines = [OURS, ...(o?.lines ?? []), SPLIT, ...(t?.lines ?? []), THEIRS]
      conflicts.push(`${label(src)}: ${o ? 'changed in ours, deleted in theirs' : 'deleted in ours, changed in theirs'}`)
    } else lines = src.lines
    const isLast = i === order.length - 1
    const trail = isLast ? (src.last ? src.trail : os[os.length - 1]!.trail) : src.last ? Math.max(src.trail, 1) : src.trail
    return [...lines, ...Array<string>(trail).fill('')]
  })
  const text = out.flat().join('\n') + (endsWithNewline ? '\n' : '')
  return { text: text.replace(/\n/g, eol), conflicts, renumbered: [...moves].map(([from, to]) => [from.replace(/#\d+$/, ''), to]) }
}
