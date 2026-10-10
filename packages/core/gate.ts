// The spec gate (D2): an opt-in warning when source files change while the spec
// still awaits approval. It warns and never blocks.

import type { Spec, TaskList } from './parse'
import { specApproval } from './view'

/** Paths that are writing about the work, not the work: specs, plans, docs, notes. */
const NOT_SOURCE = /(^|\/)(tasks|specs|docs|\.claude|\.git)\/|\.(md|mdx|markdown|txt|rst|adoc)$/i

/** The path relative to the project, or null when it lies outside it. */
export function relativeTo(cwd: string, path: string): string | null {
  const p = path.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  if (!p.startsWith('/')) return p.replace(/^\.\//, '')
  return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : null
}

/** A file of the project that is not a spec, plan or doc. */
export function isSourceFile(cwd: string, path: string): boolean {
  const rel = relativeTo(cwd, path)
  return rel !== null && rel !== '' && !NOT_SOURCE.test(rel)
}

export type GateWarning = { toast: string; context: string }

/**
 * What to say when `path` changes before the spec is approved, or null when
 * there is nothing to say: no spec, an approved one, or a file that isn't source.
 */
export function gateWarning(input: { cwd: string; path: string; spec: Spec | null; specFile: string | null; hasPlan: boolean }): GateWarning | null {
  const { cwd, path, spec, hasPlan } = input
  if (!spec || specApproval(spec, hasPlan) !== 'awaiting' || !isSourceFile(cwd, path)) return null
  const file = input.specFile ?? 'SPEC.md'
  const rel = relativeTo(cwd, path) ?? path
  return {
    toast: `♦ Spec gate · ${rel} changed while ${file} awaits approval`,
    context: [
      `agent-skills-mods spec gate: ${rel} was edited while ${file} is still awaiting approval.`,
      'The spec-driven-development skill asks for the human to approve the spec before implementation starts.',
      'Pause source changes, summarise what the spec still needs, and ask the user to approve it (the spec pane has an Approve button, or they can say so).',
      'This is a warning only; the edit went through.',
    ].join(' '),
  }
}

/** The first checkpoint reached (its task done) whose own items are not all ticked. */
export function dueCheckpoint(list: TaskList | null): { after: string; title: string; open: string[] } | null {
  for (const t of list?.tasks ?? []) {
    const cp = t.checkpoint
    if (!cp || t.status !== 'done' || cp.items.length === 0) continue
    const open = cp.items.filter(b => !b.isDone).map(b => b.text)
    if (open.length) return { after: t.id, title: cp.title, open }
  }
  return null
}

/**
 * The checkpoint gate: an edit to a source file while a reached checkpoint
 * still waits for review. Like the spec gate, it warns and never blocks.
 */
export function checkpointWarning(input: { cwd: string; path: string; list: TaskList | null }): GateWarning | null {
  const due = dueCheckpoint(input.list)
  if (!due || !isSourceFile(input.cwd, input.path)) return null
  const rel = relativeTo(input.cwd, input.path) ?? input.path
  return {
    toast: `♦ Checkpoint gate · ${rel} changed before "${due.title}" was reviewed`,
    context: [
      `agent-skills-mods checkpoint gate: ${rel} was edited, but checkpoint "${due.title}" (after ${due.after}) still waits for review: ${due.open.join('; ')}.`,
      'The planning skill asks for that review with the human before the next phase starts.',
      'Stop starting new work: run the checks it lists, report the results, and ask the user to review before going on. This is a warning only; the edit went through.',
    ].join(' '),
  }
}
