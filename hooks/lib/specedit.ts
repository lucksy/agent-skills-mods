// What the spec pane's buttons do to the file (A1): set the approval in front
// matter, and pick the editor that opens it.

/**
 * The spec text with `status: <status>` in its front matter: the line replaced
 * where there is one, added to existing front matter, or a new block on top.
 * Everything else is kept byte for byte.
 */
export function withStatus(text: string, status: 'approved' | 'draft'): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)
  if (!fm) return `---${eol}status: ${status}${eol}---${eol}${text}`
  const inner = fm[1] ?? ''
  const next = /^status:.*$/m.test(inner) ? inner.replace(/^status:.*$/m, `status: ${status}`) : `${inner}${eol}status: ${status}`
  return `---${eol}${next}${eol}---${fm[2] ?? eol}${text.slice(fm[0].length)}`
}

/** Editors that open a window of their own, so a run from the pane returns at once. */
const GUI_EDITORS = /^(code|code-insiders|cursor|windsurf|zed|subl|mate|atom|idea|webstorm|fleet|gedit|kate|bbedit|nova)$/

/**
 * The commands to try, in order, to open `path` for editing: $VISUAL or $EDITOR
 * when it is a windowed editor (a terminal one like vim would need this
 * terminal), then the machine's default app.
 */
export function editorArgvs(env: { visual?: string; editor?: string }, path: string): string[][] {
  const out: string[][] = []
  for (const cmd of [env.visual, env.editor]) {
    const parts = (cmd ?? '').trim().split(/\s+/).filter(Boolean)
    const name = parts[0]?.split('/').pop() ?? ''
    if (GUI_EDITORS.test(name)) out.push([...parts.filter(p => p !== '--wait' && p !== '-w'), path])
  }
  out.push(['open', path], ['xdg-open', path], ['cmd', '/c', 'start', '', path])
  return out
}
