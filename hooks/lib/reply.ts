// The plugin's command replies (/progress …, /spec-view …) read as plain text,
// which is what the model gets. This reads that text back into kinds of line,
// so the transcript row can draw it styled: a title, boxes with their glyph,
// warnings, fields, sections, with wrapped lines kept under their text. Pure.

export type Inline = { text: string; isCode: boolean }

export type ReplyLine =
  | { kind: 'blank' }
  | { kind: 'title'; label: string | null; text: Inline[]; note: string | null }
  | { kind: 'heading'; text: string }
  | { kind: 'box'; indent: number; isDone: boolean; text: Inline[] }
  | { kind: 'mark'; indent: number; level: 'warn' | 'error'; text: Inline[]; note: string | null }
  | { kind: 'bullet'; indent: number; text: Inline[] }
  | { kind: 'field'; indent: number; label: string; text: Inline[] }
  | { kind: 'text'; indent: number; text: Inline[] }

/** `code` spans apart from the words around them. */
export function inline(text: string): Inline[] {
  const out: Inline[] = []
  const re = /`([^`]+)`/g
  let at = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index), isCode: false })
    out.push({ text: m[1]!, isCode: true })
    at = m.index! + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at), isCode: false })
  return out
}

const BOX = /^(\s*)\[( |x|X)\]\s+(.*)$/
const MARK = /^(\s*)([!×])\s+(.*)$/
const BULLET = /^(\s*)[-•·]\s+(.*)$/
const FIELD = /^(\s*)([A-Z][A-Za-z0-9 /'-]{1,28}):\s+(.+)$/
/** A note at the end of a line: `  (fixable)`, `  (Phase 0 — Baseline)`. */
const NOTE = /\s{2,}\(([^()]+)\)$/

/** A heading: a file name alone (`tasks/todo.md`), or a short line ending in a colon. */
const isHeading = (line: string) => /^[\w./-]+\.(md|json|html)$/.test(line) || (/^[A-Z][^.!?]{0,48}:$/.test(line) && !line.includes(': '))

export function replyLines(text: string): ReplyLine[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: ReplyLine[] = []
  let titled = false
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line === '') {
      if (out.length && out[out.length - 1]!.kind !== 'blank') out.push({ kind: 'blank' })
      continue
    }
    const note = (s: string) => {
      const m = NOTE.exec(s)
      return m ? { body: s.slice(0, m.index), note: m[1]! } : { body: s, note: null }
    }
    let m: RegExpExecArray | null
    if ((m = BOX.exec(line))) {
      out.push({ kind: 'box', indent: m[1]!.length, isDone: m[2] !== ' ', text: inline(m[3]!) })
    } else if ((m = MARK.exec(line))) {
      const n = note(m[3]!)
      out.push({ kind: 'mark', indent: m[1]!.length, level: m[2] === '×' ? 'error' : 'warn', text: inline(n.body), note: n.note })
    } else if (!titled) {
      // The first line says what the reply is: `Next: T4 title  (Phase 0)`.
      const n = note(line)
      const f = /^([A-Z][A-Za-z ]{1,20}):\s+(.+)$/.exec(n.body)
      out.push({ kind: 'title', label: f ? f[1]! : null, text: inline(f ? f[2]! : n.body), note: n.note })
    } else if (isHeading(line.trim()) && !/^\s/.test(line)) {
      out.push({ kind: 'heading', text: line.trim().replace(/:$/, '') })
    } else if ((m = BULLET.exec(line))) {
      out.push({ kind: 'bullet', indent: m[1]!.length, text: inline(m[2]!) })
    } else if ((m = FIELD.exec(line))) {
      out.push({ kind: 'field', indent: m[1]!.length, label: m[2]!, text: inline(m[3]!) })
    } else {
      const indent = /^\s*/.exec(line)![0].length
      out.push({ kind: 'text', indent, text: inline(line.slice(indent)) })
    }
    titled = true
  }
  while (out.length && out[out.length - 1]!.kind === 'blank') out.pop()
  return out
}
