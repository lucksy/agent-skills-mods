// Small helpers the dashboard's views share. Pure.

/** Text from markdown, safe in HTML content and in double-quoted attributes. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `1 task`, `3 tasks`. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// Markdown's inline marks as agent-skills writes them in questions and boxes:
// `code`, **strong**, *emphasis*. A mark opens only before a non-space and closes
// only after one, so "2 * 3 * 4" and snake_case stay as written.
const CODE = /`([^`]+)`/g
const STRONG = /\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g
const EM = /(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g

/** Inline markdown as HTML: escaped first, then the marks turned into tags; code is left as typed. */
export function inline(md: string): string {
  const codes: string[] = []
  const held = md.replace(CODE, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
  return esc(held)
    .replace(STRONG, '<strong>$1</strong>')
    .replace(EM, '$1<em>$2</em>')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${esc(codes[Number(i)]!)}</code>`)
}

/** Inline markdown as plain text: the marks dropped, for titles and tooltips. */
export function plainInline(md: string): string {
  return md.replace(CODE, '$1').replace(STRONG, '$1').replace(EM, '$1$2')
}
