import { Show } from "solid-js"
import type { AgentMode } from "@gent/core"
import type { GitStatus } from "../hooks/use-git-status.js"
import { useTheme } from "../theme/index.js"

interface StatusBarProps {
  mode: AgentMode
  model: string
  cwd: string
  gitRoot: string | null
  git: GitStatus | null
  cost: number
  status: "idle" | "streaming" | "error"
  error: string | null
}

function formatCost(cost: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cost)
}

function shortenModel(model: string): string {
  // anthropic/claude-sonnet-4-20250514 -> claude-sonnet-4
  const parts = model.split("/")
  const name = parts[parts.length - 1] ?? model
  // Remove date suffix
  const match = name.match(/^(claude-[a-z0-9-]+)-\d+$/)
  return match?.[1] ?? name
}

function relativePath(cwd: string, gitRoot: string | null): string {
  if (gitRoot) {
    // Get repo dirname
    const repoParts = gitRoot.split("/")
    const repoName = repoParts[repoParts.length - 1] ?? ""

    // At repo root
    if (cwd === gitRoot) return repoName

    // In subdirectory
    if (cwd.startsWith(gitRoot + "/")) {
      return repoName + "/" + cwd.slice(gitRoot.length + 1)
    }
  }
  // Fall back to just dirname
  const parts = cwd.split("/")
  return parts[parts.length - 1] ?? cwd
}

export function StatusBar(props: StatusBarProps) {
  const { theme } = useTheme()

  const statusIndicator = () => {
    switch (props.status) {
      case "streaming":
        return { text: "thinking...", color: theme.info }
      case "error":
        return { text: "error", color: theme.error }
      default:
        return { text: "", color: theme.textMuted }
    }
  }

  return (
    <box flexDirection="column" flexShrink={0}>
      {/* Error row if error */}
      <Show when={props.error}>
        <box paddingLeft={1} paddingRight={1}>
          <text style={{ fg: theme.error }}>{props.error}</text>
        </box>
      </Show>

      {/* Row 1: mode · model · status */}
      <box paddingLeft={1} paddingRight={1}>
        <text>
          <span style={{ fg: props.mode === "auto" ? theme.success : theme.warning }}>
            {props.mode}
          </span>
          <span style={{ fg: theme.textMuted }}> · </span>
          <span style={{ fg: theme.textMuted }}>{shortenModel(props.model)}</span>
          <Show when={statusIndicator().text}>
            <span style={{ fg: theme.textMuted }}> · </span>
            <span style={{ fg: statusIndicator().color }}>{statusIndicator().text}</span>
          </Show>
        </text>
      </box>

      {/* Row 2: cwd · git · cost */}
      <box paddingLeft={1} paddingRight={1}>
        <text>
          <span style={{ fg: theme.textMuted }}>{relativePath(props.cwd, props.gitRoot)}</span>
          <Show when={props.git}>
            {(git) => (
              <>
                <span style={{ fg: theme.textMuted }}> · </span>
                <span style={{ fg: theme.warning }}>{git().branch}</span>
                <Show when={git().files > 0}>
                  <span style={{ fg: theme.text }}> ~{git().files}</span>
                  <Show when={git().additions > 0}>
                    <span style={{ fg: theme.success }}> +{git().additions}</span>
                  </Show>
                  <Show when={git().deletions > 0}>
                    <span style={{ fg: theme.error }}> -{git().deletions}</span>
                  </Show>
                </Show>
                <span style={{ fg: theme.textMuted }}> · {formatCost(props.cost)}</span>
              </>
            )}
          </Show>
          <Show when={!props.git}>
            <span style={{ fg: theme.textMuted }}> · {formatCost(props.cost)}</span>
          </Show>
        </text>
      </box>
    </box>
  )
}
