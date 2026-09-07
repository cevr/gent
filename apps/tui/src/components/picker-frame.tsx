import type { JSX } from "solid-js"
import { useTheme } from "../theme/index"

export const pickerHeight = (itemCount: number, terminalRows: number): number =>
  Math.min(Math.min(Math.max(itemCount, 1), 6) + 5, Math.max(6, Math.floor(terminalRows / 2) + 1))

export function PickerFrame(props: { height: number; children: JSX.Element; footer: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" flexShrink={0} width="100%" height={props.height}>
      <box
        flexDirection="column"
        flexGrow={1}
        border={["top", "bottom"]}
        borderColor={theme.border}
      >
        {props.children}
      </box>
      <text height={1} flexShrink={0} wrapMode="none" truncate style={{ fg: theme.textMuted }}>
        {props.footer}
      </text>
    </box>
  )
}
