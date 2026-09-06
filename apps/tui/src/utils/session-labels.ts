import { Option } from "effect"
import type { RGBA } from "@opentui/core"
import type { BorderLabelItem } from "./border-segments"
import { formatTokens } from "./format-tool"

interface ThemeColors {
  textMuted: RGBA
  error: RGBA
  warning: RGBA
  info: RGBA
}

export function buildTopRightLabels(
  // eslint-disable-next-line effect/noNullish -- this helper mirrors the optional client snapshot fields.
  reasoningLevel: string | undefined,
  tokens: number,
  // eslint-disable-next-line effect/noNullish -- this helper mirrors the optional client snapshot fields.
  contextLength: number | undefined,
  theme: ThemeColors,
  // eslint-disable-next-line effect/noNullish -- Solid component options are optional at this boundary.
  options?: { debugMode?: boolean },
): BorderLabelItem[] {
  const items: BorderLabelItem[] = []
  const reasoning = Option.fromNullishOr(reasoningLevel)
  const context = Option.fromNullishOr(contextLength)

  if (tokens > 0 && Option.isSome(context) && context.value > 0) {
    const pct = Math.min(100, Math.round((tokens / context.value) * 100))
    let color = theme.textMuted
    if (pct >= 90) {
      color = theme.error
    } else if (pct >= 70) {
      color = theme.warning
    }
    items.push({ text: `${formatTokens(tokens)} (${pct}%)`, color })
  }

  const debug = Option.fromNullishOr(options)
  if (Option.isSome(debug) && debug.value.debugMode === true) {
    items.push({ text: "debug", color: theme.warning })
  }

  if (Option.isSome(reasoning)) {
    items.push({ text: reasoning.value, color: theme.info })
  }

  return items
}
