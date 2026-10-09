// An animated progress bar (surface module): eases from the last value to the
// new one when a task is done, and fills in from empty when first drawn.
// Eighth-block cells keep the motion smooth at any width.

import type { ClientModule } from 'claude-code'

export type MeterProps = { done: number; total: number; color?: string }
type State = { shown: number; target: number }

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const FRAME_MS = 33

/** The bar's text for a fraction `f` of `width` cells: whole blocks, one partial, then track. */
export function meterCells(f: number, width: number): { fill: string; track: string } {
  const eighths = Math.round(Math.max(0, Math.min(1, f)) * width * 8)
  const whole = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8] ?? ''
  const fill = '█'.repeat(whole) + part
  return { fill, track: '░'.repeat(Math.max(0, width - whole - (part ? 1 : 0))) }
}

const Meter: ClientModule<MeterProps, State> = (props, surface) => {
  const { Text } = surface.elements
  const target = props.total > 0 ? props.done / props.total : 0
  const state = surface.state
  if (state === undefined) {
    surface.setState({ shown: 0, target })
    // One timer for the instance's life; it only redraws while the bar moves.
    surface.every(FRAME_MS, () => {
      const s = surface.state
      if (!s || Math.abs(s.target - s.shown) < 0.002) return
      const step = (s.target - s.shown) * 0.22
      const shown = Math.abs(step) < 0.004 ? s.target : s.shown + step
      surface.setState({ shown, target: s.target })
    })
  } else if (state.target !== target) surface.setState({ shown: state.shown, target })
  const width = Math.max(4, surface.columns || 20)
  const { fill, track } = meterCells(state?.shown ?? 0, width)
  return (
    <Text wrap="truncate-end">
      <Text color={props.color ?? 'success'}>{fill}</Text>
      <Text color="subtle">{track}</Text>
    </Text>
  )
}

export default Meter
