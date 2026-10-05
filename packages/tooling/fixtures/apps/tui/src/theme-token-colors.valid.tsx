// Tokens at every color slot; strings that are not colors.
import type { RGBA } from "@opentui/core"
declare const theme: {
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly border: RGBA
  readonly error: RGBA
}
declare const failed: () => boolean

export const Row = () => (
  <box borderColor={theme.border}>
    <text style={{ fg: failed() ? theme.error : theme.text }}>row</text>
    <textarea
      backgroundColor="transparent"
      focusedBackgroundColor="transparent"
      textColor={theme.text}
    />
  </box>
)

// A label's color is a token; its text may start with `#`.
export const label = { text: "#123 merged", color: theme.textMuted }
// An extension's status label names its token; the host resolves it.
export const cacheLabel = { text: "cache cold", color: "warning" }
export const issue = "#1234"
export const heading = "# Title"
export const columns = { width: 12, dimensions: 3 }
