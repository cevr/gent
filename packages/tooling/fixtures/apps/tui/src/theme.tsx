// The theme module resolves colors: hex strings, RGBA builders and the like stay here.
import { RGBA } from "@opentui/core"

export const BLACK = RGBA.fromInts(0, 0, 0)
export const fallback = RGBA.fromHex("#000000")
export const fx = { theme: { text: "#e4e4e4", border: "#767676", background: "transparent" } }
