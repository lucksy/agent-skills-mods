// The current task's marker (surface module): a steady ● between turns, and a
// turning ◐ ◓ ◑ ◒ while the agent works, so the band shows the turn is alive.

import type { ClientModule } from 'claude-code'

export type PulseProps = { isActive: boolean; color?: string }
type State = { frame: number }

export const PULSE_FRAMES = ['◐', '◓', '◑', '◒'] as const
const FRAME_MS = 140

/** Whether each instance's turn is running, as its latest props said; the timer reads it. */
const latest = new WeakMap<object, boolean>()

const Pulse: ClientModule<PulseProps, State> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ frame: 0 })
    surface.every(FRAME_MS, () => {
      if (!latest.get(surface)) return
      surface.setState({ frame: ((surface.state?.frame ?? 0) + 1) % PULSE_FRAMES.length })
    })
  }
  latest.set(surface, props.isActive)
  const glyph = props.isActive ? PULSE_FRAMES[(surface.state?.frame ?? 0) % PULSE_FRAMES.length] : '●'
  return (
    <Text color={props.color ?? 'warning'} bold>
      {glyph}
    </Text>
  )
}

export default Pulse
