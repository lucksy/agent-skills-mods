// The plan pane's tabs (surface module): `[ Timeline ] [ Charts ] [ Tasks ]`,
// switched with ←/→ once the row has the focus, or by a click on a tab. The
// choice goes to the hooks module, which keeps it and redraws the pane.

import type { ClientModule } from 'claude-code'

export const TABS = ['timeline', 'charts', 'tasks'] as const
export type Tab = (typeof TABS)[number]
export type TabsProps = { active: Tab }

const LABEL: Record<Tab, string> = { timeline: 'Timeline', charts: 'Charts', tasks: 'Tasks' }

/** Each tab's columns in the row, for a click: `[ Timeline ]` then one space. */
export function tabAt(x: number): Tab | null {
  let at = 0
  for (const t of TABS) {
    const w = LABEL[t].length + 4
    if (x >= at && x < at + w) return t
    at += w + 1
  }
  return null
}

const Tabs: ClientModule<TabsProps, { ready: true }> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ ready: true })
    surface.onKey(k => {
      const i = TABS.indexOf(current.get(surface) ?? 'tasks')
      if (k.key === 'left' || k.key === 'right') surface.post({ tab: TABS[(i + (k.key === 'left' ? TABS.length - 1 : 1)) % TABS.length]! })
      else if (k.key === '1' || k.key === '2' || k.key === '3') surface.post({ tab: TABS[Number(k.key) - 1]! })
    })
    surface.onPointer(p => {
      if (p.type !== 'down') return
      const t = tabAt(p.x)
      if (t) surface.post({ tab: t })
    })
  }
  current.set(surface, props.active)
  return (
    <Box flexDirection="row" gap={1}>
      {TABS.map(t =>
        t === props.active ? (
          <Text color="claude" bold>
            [ {LABEL[t]} ]
          </Text>
        ) : (
          <Text dimColor>[ {LABEL[t]} ]</Text>
        ),
      )}
    </Box>
  )
}

/** The tab each instance shows, for its key listener. */
const current = new WeakMap<object, Tab>()

export default Tabs
