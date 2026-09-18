import { Option } from "effect"
import type { RGBA } from "@opentui/core"
import { formatTokens } from "../utils"
import type { ModelContextMetrics } from "@gent/core/protocol"
import type { SessionMetrics } from "../client"

/** One colored label on the composer frame rule. */
export interface BorderLabelItem {
  text: string
  color: RGBA
}

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

/** `ctx 42%`: percent of the model's input budget. What the projection dropped is in the thread pane. */
const projectionLabel = (context: ModelContextMetrics, theme: ThemeColors): BorderLabelItem => {
  const pct = Math.min(
    100,
    Math.round((context.estimatedTokens / context.contextLimitTokens) * 100),
  )
  return { text: `ctx ${pct}%`, color: pressureColor(pct, theme) }
}

/**
 * The context gauge alone, for the labels anchored to the right edge.
 *
 * It is split from {@link buildTopRightLabels} because the two halves sit at
 * opposite ends of the row: effort belongs beside the model name, while the
 * gauge belongs with the running total a reader checks at a glance.
 */
export function buildContextLabels(input: {
  readonly metrics: SessionMetrics
  // eslint-disable-next-line effect/noNullish -- this mirrors the optional client snapshot field.
  readonly contextLength: number | undefined
  readonly theme: ThemeColors
}): BorderLabelItem[] {
  const projection = input.metrics.context
  if (Option.isSome(projection) && projection.value.contextLimitTokens > 0) {
    // The projection is what the model saw; it beats the provider's last usage report.
    return [projectionLabel(projection.value, input.theme)]
  }
  const tokens = input.metrics.latestInputTokens
  const limit = Option.fromNullishOr(input.contextLength)
  if (tokens > 0 && Option.isSome(limit) && limit.value > 0) {
    const pct = Math.min(100, Math.round((tokens / limit.value) * 100))
    return [{ text: `${formatTokens(tokens)} (${pct}%)`, color: pressureColor(pct, input.theme) }]
  }
  return []
}

/**
 * The labels that sit beside the model name: its effort, and the debug mark.
 *
 * The context gauge used to be here too. It moved to {@link buildContextLabels}
 * when the row grew a right-anchored group — effort names how the model is
 * configured, the gauge reports what the session has spent, and the two
 * belong at opposite ends.
 */
export function buildTopRightLabels(input: {
  readonly reasoningLevel: Option.Option<string>
  readonly theme: ThemeColors
  readonly debugMode: boolean
}): BorderLabelItem[] {
  const items: BorderLabelItem[] = []

  if (Option.isSome(input.reasoningLevel)) {
    items.push({ text: input.reasoningLevel.value, color: input.theme.info })
  }

  if (input.debugMode) {
    items.push({ text: "debug", color: input.theme.warning })
  }

  return items
}

/** `repo/sub/dir (branch)`: the cwd relative to the git root, else its last segment. */
export function formatCwdGit(
  cwd: string,
  gitRoot: Option.Option<string>,
  branch: Option.Option<string>,
): string {
  let label: string
  if (Option.isSome(gitRoot)) {
    const repoParts = gitRoot.value.split("/")
    const repoName = Option.getOrElse(
      Option.fromNullishOr(repoParts[repoParts.length - 1]),
      () => "",
    )
    if (cwd === gitRoot.value) {
      label = repoName
    } else if (cwd.startsWith(gitRoot.value + "/")) {
      label = repoName + "/" + cwd.slice(gitRoot.value.length + 1)
    } else {
      label = Option.getOrElse(Option.fromNullishOr(repoParts[repoParts.length - 1]), () => cwd)
    }
  } else {
    const parts = cwd.split("/")
    label = Option.getOrElse(Option.fromNullishOr(parts[parts.length - 1]), () => cwd)
  }

  if (Option.isSome(branch) && branch.value.length > 0) {
    return `${label} (${branch.value})`
  }
  return label
}
