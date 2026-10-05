// Colors written at a call site, and SGR dim: each skips the contrast rule.
import { parseColor, RGBA, RGBA as Color, TextAttributes } from "@opentui/core"
declare const theme: { readonly text: RGBA; readonly textMuted: RGBA }
declare const selected: () => boolean
declare const input: string

// A hex string anywhere, as a literal and as a plain template.
export const accent = "#e5484d"
export const tint = `#30a46c`

// A named color in a style key, a JSX color attribute and a label's color.
export const Named = () => (
  <box borderColor="gray">
    <text style={{ fg: "red" }}>failed</text>
    <textarea textColor="white" focusedBackgroundColor="#fff" />
  </box>
)
export const label = { text: "reconnecting", color: "yellow" }

// A hex string in a JSX attribute.
export const Border = () => <box borderColor="#585858" />

// Dim, as a style key and as an attribute flag.
export const Quiet = () => (
  <text style={{ fg: theme.textMuted, dim: !selected() }} attributes={TextAttributes.DIM}>
    hint
  </text>
)

// A color built in place.
export const red = RGBA.fromInts(255, 0, 0)
export const parsed = RGBA.fromHex(input)
export const blue = parseColor("blue")
export const green = Color.fromValues(0, 1, 0, 1)
