import { Option } from "effect"
import type { RGBA } from "@opentui/core"
import type { BorderLabelItem } from "./border-segments"
import { formatTokens } from "./format-tool"
import type { ModelContextMetrics } from "@gent/core-internal/runtime/agent/agent-loop.state"

interface ThemeColors {
  textMuted: RGBA
  error: RGBA
  warning: RGBA
  info: RGBA
}

const pressureColor = (pct: number, theme: ThemeColors): RGBA => {
  if (pct >= 90) return theme.error
  if (pct >= 70) return theme.warning
  return theme.textMuted
}

/** `ctx 42% · 3 omitted · compacted ×2`: percent of the model's input budget, then what the projection dropped. */
const projectionLabel = (context: ModelContextMetrics, theme: ThemeColors): BorderLabelItem => {
  const pct = Math.min(
    100,
    Math.round((context.estimatedTokens / context.contextLimitTokens) * 100),
  )
  const parts = [`ctx ${pct}%`]
  if (context.omittedMessages > 0) parts.push(`${context.omittedMessages} omitted`)
  if (context.compactions > 0) parts.push(`compacted ×${context.compactions}`)
  return { text: parts.join(" · "), color: pressureColor(pct, theme) }
}

export function buildTopRightLabels(
  // eslint-disable-next-line effect/noNullish -- this helper mirrors the optional client snapshot fields.
  reasoningLevel: string | undefined,
  tokens: number,
  // eslint-disable-next-line effect/noNullish -- this helper mirrors the optional client snapshot fields.
  contextLength: number | undefined,
  theme: ThemeColors,
  // eslint-disable-next-line effect/noNullish -- Solid component options are optional at this boundary.
  options?: { debugMode?: boolean; context?: ModelContextMetrics },
): BorderLabelItem[] {
  const items: BorderLabelItem[] = []
  const reasoning = Option.fromNullishOr(reasoningLevel)
  const context = Option.fromNullishOr(contextLength)
  const projection = Option.fromNullishOr(options?.context)

  if (Option.isSome(projection) && projection.value.contextLimitTokens > 0) {
    // The projection is what the model saw; it beats the provider's last usage report.
    items.push(projectionLabel(projection.value, theme))
  } else if (tokens > 0 && Option.isSome(context) && context.value > 0) {
    const pct = Math.min(100, Math.round((tokens / context.value) * 100))
    items.push({ text: `${formatTokens(tokens)} (${pct}%)`, color: pressureColor(pct, theme) })
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
