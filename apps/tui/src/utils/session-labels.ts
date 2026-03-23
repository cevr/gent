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
  agentName: string,
  reasoningLevel: string | undefined,
  tokens: number,
  contextLength: number | undefined,
  theme: ThemeColors,
  options?: { debugMode?: boolean },
): BorderLabelItem[] {
  const items: BorderLabelItem[] = []

  if (tokens > 0 && contextLength !== undefined && contextLength > 0) {
    const pct = Math.min(100, Math.round((tokens / contextLength) * 100))
    let color = theme.textMuted
    if (pct >= 90) {
      color = theme.error
    } else if (pct >= 70) {
      color = theme.warning
    }
    items.push({ text: `${formatTokens(tokens)} (${pct}%)`, color })
  }

  if (options?.debugMode === true) {
    items.push({ text: "debug", color: theme.warning })
  }

  items.push({ text: agentName, color: theme.textMuted })

  if (reasoningLevel !== undefined) {
    items.push({ text: reasoningLevel, color: theme.info })
  }

  return items
}
