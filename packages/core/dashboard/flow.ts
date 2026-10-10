// The Flow view (K4). Wired into the page ahead of T9, which builds it.
// Pure: State in, HTML out. Its styles live here too, so T9 touches this file only.

import type { State } from '../state'

export function flowHtml(_s: State): string {
  return '<p class="muted">Not built yet (T9).</p>'
}

/** This view's CSS, added to the page's stylesheet. */
export const FLOW_STYLE = ''
