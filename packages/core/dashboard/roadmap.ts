// The Roadmap view (K3). Wired into the page ahead of T8, which builds it.
// Pure: State in, HTML out. Its styles live here too, so T8 touches this file only.

import type { State } from '../state'

export function roadmapHtml(_s: State): string {
  return '<p class="muted">Not built yet (T8).</p>'
}

/** This view's CSS, added to the page's stylesheet. */
export const ROADMAP_STYLE = ''
