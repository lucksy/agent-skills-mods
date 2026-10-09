// The spec gate (D2): an opt-in warning when source files change while the spec
// still awaits approval. It warns and never blocks.

import type { Spec } from './parse'
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
