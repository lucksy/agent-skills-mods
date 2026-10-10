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
//
// JSON carries no functions, so what needs one is named in the spec:
//   - each datum's `tip` (and a line slice's `head`) is its tooltip, in words;
//   - `format: { x, y }` names the axis labels: `day` (5 Oct), `int`, `days` (3 d);
//   - `dashed` names line series drawn dashed, `cone` two whose gap is filled;
//   - `guides` are named reference lines across the value axis;
//   - a bar row's `label` is the text on its bar.

import { ResponsiveBar } from '@nivo/bar'
import { ResponsiveLine } from '@nivo/line'
import { ResponsiveScatterPlot } from '@nivo/scatterplot'
import { createRoot, type Root } from 'react-dom/client'

type Format = 'day' | 'int' | 'days'
type Spec = {
  kind: 'line' | 'bar' | 'scatter'
  data: unknown[]
  /** CSS custom properties, one per series (or per key for bars). */
  colors: string[]
  /** Plain Nivo props: anything JSON can carry. */
  props?: Record<string, unknown>
  height?: number
  format?: { x?: Format; y?: Format }
  dashed?: string[]
  cone?: [string, string]
  guides?: { value: number; label: string }[]
}

const css = () => getComputedStyle(document.documentElement)
const token = (name: string) => css().getPropertyValue(name).trim() || name

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** `5 Oct` for a Date (the time scale's ticks, in UTC) or a YYYY-MM-DD day. */
const day = (v: unknown) => {
  const d = v instanceof Date ? v : new Date(`${String(v)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? String(v) : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}
const FORMATS: Record<Format, (v: unknown) => string> = {
  day,
  int: v => (Number.isInteger(Number(v)) ? String(v) : ''),
  days: v => (Number.isInteger(Number(v)) ? `${v} d` : ''),
}

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
    labels: { text: { fill: token('--ink'), fontSize: 11.5, fontWeight: 600 } },
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

/** A tooltip in words: an optional heading, then a line per item, each with its series' colour beside it. */
function Tip({ head, items }: { head?: string; items: { color?: string; text: string }[] }) {
  return (
    <div style={{ ...theme().tooltip.container, whiteSpace: 'nowrap' }}>
      {head ? <div style={{ fontWeight: 600, marginBottom: 2 }}>{head}</div> : null}
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {it.color ? <span style={{ width: 10, height: 10, borderRadius: 2, background: it.color, flex: 'none' }} /> : null}
          <span>{it.text}</span>
        </div>
      ))}
    </div>
  )
}

const tipOf = (d: any): string | undefined => (d && typeof d.tip === 'string' ? d.tip : undefined)

/** The lines, the forecast's dashed; and the fast-to-slow gap filled, under them. */
function lineLayers(spec: Spec) {
  const dashed = new Set(spec.dashed ?? [])
  const Lines = ({ series, lineGenerator }: any) => (
    <g>
      {series.map((s: any) => (
        <path
          key={s.id}
          d={lineGenerator(s.data.map((d: any) => d.position)) ?? ''}
          fill="none"
          stroke={s.color}
          strokeWidth={dashed.has(s.id) ? 1.5 : Number(spec.props?.lineWidth ?? 2)}
          strokeDasharray={dashed.has(s.id) ? '5 4' : undefined}
        />
      ))}
    </g>
  )
  const Cone = ({ series }: any) => {
    const [a, b] = (spec.cone ?? []).map(id => series.find((s: any) => s.id === id))
    if (!a || !b) return null
    const pts = [...a.data, ...[...b.data].reverse()].map((d: any) => `${d.position.x},${d.position.y}`)
    return <polygon points={pts.join(' ')} fill={a.color} fillOpacity={0.14} stroke="none" />
  }
  return ['grid', 'markers', 'axes', 'areas', Cone, 'crosshair', Lines, 'points', 'slices', 'mesh', 'legends']
}

/** Named guides as Nivo markers, labelled, across the value axis. */
function markers(spec: Spec, axis: 'x' | 'y') {
  const stroke = token('--ink3')
  return (spec.guides ?? []).map(g => ({
    axis,
    value: g.value,
    legend: g.label,
    legendPosition: axis === 'x' ? 'top' : 'right',
    lineStyle: { stroke, strokeWidth: 1, strokeDasharray: '4 3' },
    textStyle: { fill: token('--ink2'), fontSize: 11 },
  }))
}

function Chart({ spec }: { spec: Spec }) {
  const colors = spec.colors.map(token)
  const props: Record<string, any> = { ...spec.props }
  for (const [key, side] of [['x', 'axisBottom'], ['y', 'axisLeft']] as const) {
    const f = spec.format?.[key]
    if (f && props[side] !== null) props[side] = { ...(props[side] ?? {}), format: FORMATS[f] }
  }
  const common = { theme: theme(), colors, animate: !matchMedia('(prefers-reduced-motion: reduce)').matches, ...props }
  if (spec.kind === 'bar') {
    const rows = spec.data as any[]
    const label = rows.some(r => typeof r.label === 'string') ? { label: (d: any) => d.data.label ?? String(d.value) } : {}
    return (
      <ResponsiveBar
        data={spec.data as never}
        {...(common as object)}
        {...label}
        markers={markers(spec, props.layout === 'horizontal' ? 'x' : 'y') as never}
        tooltip={({ data, color, value }: any) => <Tip items={[{ color, text: tipOf(data) ?? String(value) }]} />}
      />
    )
  }
  if (spec.kind === 'scatter') {
    return (
      <ResponsiveScatterPlot
        data={spec.data as never}
        {...(common as object)}
        markers={markers(spec, 'y') as never}
        tooltip={({ node }: any) => <Tip items={[{ color: node.color, text: tipOf(node.data) ?? `${node.formattedX}: ${node.formattedY}` }]} />}
      />
    )
  }
  return (
    <ResponsiveLine
      data={spec.data as never}
      {...(common as object)}
      layers={lineLayers(spec) as never}
      markers={markers(spec, 'y') as never}
      tooltip={({ point }: any) => <Tip items={[{ color: point.seriesColor, text: tipOf(point.data) ?? `${point.data.xFormatted}: ${point.data.yFormatted}` }]} />}
      sliceTooltip={({ slice }: any) => {
        // Top of the stack first, as the eye reads the areas.
        const pts = [...slice.points].sort((a: any, b: any) => b.seriesIndex - a.seriesIndex)
        const items = pts.map((p: any) => ({ color: p.seriesColor, text: tipOf(p.data) ?? String(p.data.yFormatted) }))
        return <Tip head={pts[0]?.data.head} items={items} />
      }}
    />
  )
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
