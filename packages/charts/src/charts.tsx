// The dashboard's charts (K4), drawn by Nivo. The page's views (packages/core/
// dashboard) describe each chart in TypeScript and write it into a mount:
//
//   <div data-chart='{"kind":"line","data":[…],"colors":["--done"],"props":{…}}'>
//     <p class="chart-text">…the one-line summary, which is all a page without JS shows…</p>
//   </div>
//
// This bundle only draws them: series, colours and wording stay in core, where
// they are tested. Colours name the page's CSS tokens (`--done`), resolved here
// and redrawn when the theme changes. A chart that fails keeps its summary.

import { ResponsiveBar } from '@nivo/bar'
import { ResponsiveLine } from '@nivo/line'
import { ResponsiveScatterPlot } from '@nivo/scatterplot'
import { createRoot, type Root } from 'react-dom/client'

type Spec = {
  kind: 'line' | 'bar' | 'scatter'
  data: unknown[]
  /** CSS custom properties, one per series (or per key for bars). */
  colors: string[]
  /** Plain Nivo props: anything JSON can carry. */
  props?: Record<string, unknown>
  height?: number
}

const css = () => getComputedStyle(document.documentElement)
const token = (name: string) => css().getPropertyValue(name).trim() || name

/** Nivo's theme from the page's tokens, so charts read as part of the page in either scheme. */
function theme() {
  const ink2 = token('--ink2')
  const line = token('--line')
  const line2 = token('--line2')
  return {
    background: 'transparent',
    text: { fill: ink2, fontSize: 12, fontFamily: 'inherit' },
    axis: {
      domain: { line: { stroke: line2, strokeWidth: 1 } },
      ticks: { line: { stroke: line2, strokeWidth: 1 }, text: { fill: ink2, fontSize: 11.5 } },
      legend: { text: { fill: ink2, fontSize: 12 } },
    },
    grid: { line: { stroke: line, strokeWidth: 1 } },
    crosshair: { line: { stroke: token('--ink3'), strokeWidth: 1, strokeOpacity: 1 } },
    legends: { text: { fill: ink2, fontSize: 12 } },
    tooltip: {
      container: {
        background: token('--surface'),
        color: token('--ink'),
        fontSize: 12.5,
        border: `1px solid ${line2}`,
        borderRadius: 6,
        boxShadow: 'none',
        padding: '6px 10px',
      },
    },
  }
}

function Chart({ spec }: { spec: Spec }) {
  const colors = spec.colors.map(token)
  const common = { theme: theme(), colors, animate: !matchMedia('(prefers-reduced-motion: reduce)').matches, ...spec.props }
  if (spec.kind === 'bar') return <ResponsiveBar data={spec.data as never} {...(common as object)} />
  if (spec.kind === 'scatter') return <ResponsiveScatterPlot data={spec.data as never} {...(common as object)} />
  return <ResponsiveLine data={spec.data as never} {...(common as object)} />
}

const roots: { el: HTMLElement; root: Root; spec: Spec }[] = []

function draw() {
  for (const { root, spec } of roots) root.render(<Chart spec={spec} />)
}

function mount() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-chart]')) {
    try {
      const spec = JSON.parse(el.dataset.chart!) as Spec
      const box = document.createElement('div')
      box.className = 'chart-box'
      box.style.height = `${spec.height ?? 240}px`
      box.setAttribute('aria-hidden', 'true')
      el.prepend(box)
      el.classList.add('has-chart')
      roots.push({ el, root: createRoot(box), spec })
    } catch {
      // Leave the text summary in place.
    }
  }
  draw()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
else mount()
