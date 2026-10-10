// The merge driver (team-view, T8): what git runs as `--merge %O %A %B %P` and
// what `/progress merge-driver install|uninstall|status` writes and reads.
//
//   mergeByPath        tasks/todo.md → mergeTodo; tasks/plan.md, SPEC*.md, specs/*.md → mergeFrontMatter;
//                      anything else → the handed-in line merge alone
//   .gitattributes     the four `merge=agent-skills` lines, added and removed line by line
//   .git/config        the `[merge "agent-skills"]` section, added and removed whole
//
// Every other byte of both files is kept, so uninstall undoes install. Pure: the
// CLI hands in `git merge-file`, the plugin reads and writes the files.

import { mergeFrontMatter, mergeTodo, wholeMerge, type LineMerge } from './merge'

export const DRIVER = 'agent-skills'

/** The spec's `.gitattributes` lines, as install writes them. */
export const ATTRIBUTE_LINES = [
  'tasks/todo.md   merge=agent-skills',
  'tasks/plan.md   merge=agent-skills',
  'SPEC*.md        merge=agent-skills',
  'specs/*.md      merge=agent-skills',
]

const SECTION = `[merge "${DRIVER}"]`
const NAME = 'agent-skills task-aware merge'

/** Which merge a path gets: by task, by front matter and prose, or by line only. */
export function mergeKind(path: string): 'todo' | 'doc' | 'lines' {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (p === 'tasks/todo.md') return 'todo'
  if (p === 'tasks/plan.md' || /^specs\/[^/]+\.md$/.test(p) || /(^|\/)SPEC[^/]*\.md$/.test(p)) return 'doc'
  return 'lines'
}

export type DriverResult = { text: string; conflicts: string[]; renumbered: [string, string][] }

/**
 * The driver's merge of one file, picked by its path in the repo (`%P`).
 * `required`: the roles tasks/team.md says sign a spec (a spec's status is worked out again from them).
 */
export function mergeByPath(path: string, base: string, ours: string, theirs: string, opts: { lineMerge?: LineMerge; required?: string[] } = {}): DriverResult {
  const lineMerge = opts.lineMerge ?? wholeMerge
  const kind = mergeKind(path)
  if (kind === 'todo') return mergeTodo(base, ours, theirs, { lineMerge })
  if (kind === 'doc') {
    const isSpec = path.replace(/\\/g, '/') !== 'tasks/plan.md'
    const r = mergeFrontMatter(base, ours, theirs, { lineMerge, ...(isSpec && opts.required?.length ? { required: opts.required } : {}) })
    return { ...r, renumbered: [] }
  }
  const r = lineMerge(base, ours, theirs)
  return { text: r.text, conflicts: r.clean ? [] : ['both sides changed the same lines'], renumbered: [] }
}

/** What the driver prints to stderr: one line per renumber and per conflict. */
export function driverReport(path: string, r: DriverResult): string[] {
  return [
    ...r.renumbered.map(([from, to]) => `${path}: ${from} (theirs) is now ${to}`),
    ...r.conflicts.map(c => `${path}: ${c}`),
  ]
}

// ------------------------------------------------------------------ .gitattributes

const lineList = (text: string) => text.replace(/\r\n?/g, '\n').split('\n')
const hasLine = (text: string | null, line: string) => text !== null && lineList(text).some(l => l.trim() === line.trim())

/** `.gitattributes` with the driver's lines added (those already there skipped); everything else kept. */
export function addAttributes(text: string | null): string {
  const t = text ?? ''
  const missing = ATTRIBUTE_LINES.filter(l => !hasLine(t, l))
  if (!missing.length) return t
  const eol = t.includes('\r\n') ? '\r\n' : '\n'
  const lead = t === '' || t.endsWith('\n') ? '' : eol
  return `${t}${lead}${missing.join(eol)}${eol}`
}

/** `.gitattributes` without the driver's lines. Null when nothing else was in it, so the file can go. */
export function removeAttributes(text: string): string | null {
  const ours = new Set(ATTRIBUTE_LINES.map(l => l.trim()))
  const kept = text.split(/(?<=\n)/).filter(l => !ours.has(l.replace(/\r?\n$/, '').trim()))
  const out = kept.join('')
  return out === '' ? null : out
}

// ------------------------------------------------------------------ .git/config

/**
 * The driver command for a script path: the path shell-quoted when it needs it,
 * and the whole value in git config's double quotes when it holds `;` or `#`.
 */
export function driverCommand(script: string): string {
  const shell = /^[\w@%+=:,./-]+$/.test(script) ? script : `'${script.replace(/'/g, `'\\''`)}'`
  return `node ${shell} --merge %O %A %B %P`
}

const configValue = (v: string) => (/[;#"\\]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v)

/** The section install adds to `.git/config`. */
export function driverSection(script: string): string {
  return `${SECTION}\n    name = ${NAME}\n    driver = ${configValue(driverCommand(script))}\n`
}

const isHeader = (l: string) => /^\s*\[/.test(l)
const isOurs = (l: string) => /^\s*\[\s*merge\s+"agent-skills"\s*\]\s*$/.test(l.replace(/\r?\n$/, ''))

/** `.git/config` with the driver's section, replacing an earlier one of ours; everything else kept. */
export function addDriverConfig(text: string | null, script: string): string {
  const t = removeDriverConfig(text ?? '')
  const lead = t === '' || t.endsWith('\n') ? '' : '\n'
  return `${t}${lead}${driverSection(script)}`
}

/** `.git/config` without the driver's section (its header and every line up to the next section). */
export function removeDriverConfig(text: string): string {
  const out: string[] = []
  let skip = false
  for (const l of text.split(/(?<=\n)/)) {
    if (isHeader(l)) skip = isOurs(l)
    if (!skip) out.push(l)
  }
  return out.join('')
}

/** The driver command in `.git/config`, unquoted; null when the section or its `driver` is missing. */
export function readDriver(text: string | null): string | null {
  if (text === null) return null
  let inside = false
  for (const l of lineList(text)) {
    if (isHeader(l)) inside = isOurs(l)
    else if (inside) {
      const m = /^\s*driver\s*=\s*(.*?)\s*$/i.exec(l)
      if (m) return m[1]!.replace(/^"([\s\S]*)"$/, (_, v: string) => v.replace(/\\(["\\])/g, '$1'))
    }
  }
  return null
}

/** The script path a driver command runs (`node <path> --merge …`), unquoted; null when it isn't ours. */
export function driverScript(command: string): string | null {
  const m = /^node\s+('(?:[^']|'\\'')*'|\S+)\s+--merge\b/.exec(command)
  if (!m) return null
  const p = m[1]!
  return p.startsWith("'") ? p.slice(1, -1).replace(/'\\''/g, "'") : p
}

export type DriverStatus = { attributes: string[]; missing: string[]; driver: string | null; script: string | null }

/** What is installed: the attribute lines present and missing, and the driver command with its script. */
export function driverStatus(attributes: string | null, config: string | null): DriverStatus {
  const driver = readDriver(config)
  return {
    attributes: ATTRIBUTE_LINES.filter(l => hasLine(attributes, l)),
    missing: ATTRIBUTE_LINES.filter(l => !hasLine(attributes, l)),
    driver,
    script: driver ? driverScript(driver) : null,
  }
}

/** `/progress merge-driver status`: installed, not installed, partly installed, or a broken path. */
export function driverStatusText(s: DriverStatus, scriptExists: boolean): string {
  if (!s.driver && !s.attributes.length) return 'The merge driver is not installed. /progress merge-driver install shows what it writes and asks first.'
  const parts: string[] = []
  if (!s.driver) parts.push(`.gitattributes names the driver, but .git/config has no [merge "${DRIVER}"] entry, so git merges those files line by line.`)
  else if (!s.script) parts.push(`.git/config has a [merge "${DRIVER}"] driver that isn't this plugin's: ${s.driver}`)
  else if (!scriptExists) parts.push(`Broken path: .git/config runs ${s.script}, which isn't there (the plugin moved?).`)
  if (!s.attributes.length) parts.push(`.git/config has the driver, but .gitattributes doesn't name it, so git doesn't use it.`)
  else if (s.missing.length) parts.push(`.gitattributes is missing: ${s.missing.join(' · ')}`)
  if (!parts.length) return `The merge driver is installed: git merges tasks/todo.md by task and specs' approvals by role. It runs ${s.script}.`
  return [...parts, '/progress merge-driver install puts it right (it asks first).'].join('\n')
}
