/**
 * Auto goal input overlay — prompts for a goal when entering auto mode.
 *
 * Renders a ChromePanel with a text input. On submit, dispatches StartAuto(goal).
 * On Escape, closes without starting auto.
 */

import { createSignal } from "solid-js"
import { useTerminalDimensions } from "../terminal-dimensions"
import { Option } from "effect"
import { ref } from "@gent/core/extensions/api"
import { AutoRpc } from "@gent/extensions/client.js"
import { ChromePanel } from "../components/chrome-panel"
import { useScopedKeyboard } from "../keyboard/context"
import { useClient } from "../client/context"
import { useTheme } from "../theme/context"

const PANEL_WIDTH = 60
const PANEL_HEIGHT = 5

export function AutoGoalOverlay(props: { open: boolean; onClose: () => void }) {
  const clientCtx = useClient()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [goal, setGoal] = createSignal("")

  const submit = () => {
    const text = goal().trim()
    if (text === "") return
    const session = Option.fromNullishOr(clientCtx.session())
    if (Option.isNone(session)) return
    const startRef = ref(AutoRpc.StartAuto)
    clientCtx.runtime.cast(
      clientCtx.client.extension.request({
        sessionId: session.value.sessionId,
        extensionId: startRef.extensionId,
        capabilityId: startRef.capabilityId,
        input: { goal: text },
        branchId: session.value.branchId,
      }),
    )
    setGoal("")
    props.onClose()
  }

  useScopedKeyboard((e) => {
    if (e.name === "escape") {
      setGoal("")
      props.onClose()
      return true
    }
    if (e.name === "return") {
      submit()
      return true
    }
    if (e.name === "backspace") {
      setGoal((prev) => prev.slice(0, -1))
      return true
    }
    const sequence = Option.fromNullishOr(e.sequence)
    if (Option.isSome(sequence) && sequence.value.length === 1 && !e.ctrl && !e.meta) {
      setGoal((prev) => prev + sequence.value)
      return true
    }
    return false
  })

  const left = () => Math.floor((dimensions().width - PANEL_WIDTH) / 2)
  const top = () => Math.floor((dimensions().height - PANEL_HEIGHT) / 2)

  return (
    <ChromePanel.Root
      title="Auto Mode — Enter Goal"
      width={PANEL_WIDTH}
      height={PANEL_HEIGHT}
      left={left()}
      top={top()}
    >
      <box paddingLeft={1} paddingRight={1} flexGrow={1} flexDirection="row">
        <text>
          <span style={{ fg: theme.info, bold: true }}>{">"}</span>
          <span style={{ fg: theme.text }}> {goal()}</span>
          <span style={{ fg: theme.textMuted }}>_</span>
        </text>
      </box>
      <ChromePanel.Footer>
        <span style={{ fg: theme.textMuted }}>enter submit · esc cancel</span>
      </ChromePanel.Footer>
    </ChromePanel.Root>
  )
}
