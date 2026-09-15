import { Option } from "effect"
import type { RGBA } from "@opentui/core"
import { formatTokens } from "./format-tool"
import type { ModelContextMetrics } from "@gent/core/protocol"

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
