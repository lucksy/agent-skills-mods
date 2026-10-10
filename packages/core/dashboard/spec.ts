// The Spec view (K5). Wired into the page ahead of T11, which builds it.
// Pure: State in, HTML out. Its styles live here too, so T11 touches this file only.

import type { State } from '../state'

export function specHtml(_s: State): string {
  return '<p class="muted">Not built yet (T11).</p>'
}

/** This view's CSS, added to the page's stylesheet. */
export const SPEC_STYLE = ''
