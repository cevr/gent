import { Show, type JSX } from "solid-js"
import { useTheme } from "../theme/index"
import { useModel } from "../model/index"
import { useWorkspace } from "../workspace/index"
import { useAgentState } from "../agent-state/index"

// ============================================================================
// Helper functions
// ============================================================================

function formatCost(cost: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cost)
}

function shortenModel(model: string): string {
  const parts = model.split("/")
  const name = parts[parts.length - 1] ?? model
  const match = name.match(/^(claude-[a-z0-9-]+)-\d+$/)
  return match?.[1] ?? name
}

function relativePath(cwd: string, gitRoot: string | null): string {
  if (gitRoot) {
    const repoParts = gitRoot.split("/")
    const repoName = repoParts[repoParts.length - 1] ?? ""
    if (cwd === gitRoot) return repoName
    if (cwd.startsWith(gitRoot + "/")) {
      return repoName + "/" + cwd.slice(gitRoot.length + 1)
    }
  }
  const parts = cwd.split("/")
  return parts[parts.length - 1] ?? cwd
}

// ============================================================================
// Compound Components
// ============================================================================

interface RootProps {
  children: JSX.Element
}

function Root(props: RootProps) {
  return (
    <box flexDirection="column" flexShrink={0}>
      {props.children}
    </box>
  )
}

function ErrorRow() {
  const { error } = useAgentState()
  const { theme } = useTheme()

  return (
    <Show when={error()}>
      <box paddingLeft={1} paddingRight={1}>
        <text style={{ fg: theme.error }}>{error()}</text>
      </box>
    </Show>
  )
}

function Mode() {
  const { mode } = useAgentState()
  const { theme } = useTheme()

  return <span style={{ fg: mode() === "build" ? theme.success : theme.warning }}>{mode()}</span>
}

function Model() {
  const { theme } = useTheme()
  const model = useModel()

  const display = () => {
    const info = model.currentModelInfo()
    return shortenModel(info?.name ?? model.currentModel())
  }

  return <span style={{ fg: theme.textMuted }}>{display()}</span>
}

function Status() {
  const { status } = useAgentState()
  const { theme } = useTheme()

  const indicator = () => {
    switch (status()) {
      case "streaming":
        return { text: "thinking...", color: theme.info }
      case "error":
        return { text: "error", color: theme.error }
      default:
        return { text: "", color: theme.textMuted }
    }
  }

  return (
    <Show when={indicator().text}>
      <span style={{ fg: indicator().color }}>{indicator().text}</span>
    </Show>
  )
}

function Cwd() {
  const { theme } = useTheme()
  const workspace = useWorkspace()

  return (
    <span style={{ fg: theme.textMuted }}>{relativePath(workspace.cwd, workspace.gitRoot())}</span>
  )
}

function Git() {
  const { theme } = useTheme()
  const workspace = useWorkspace()

  return (
    <Show when={workspace.gitStatus()}>
      {(git) => (
        <>
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
        </>
      )}
    </Show>
  )
}

function Cost() {
  const { cost } = useAgentState()
  const { theme } = useTheme()

  return <span style={{ fg: theme.textMuted }}>{formatCost(cost())}</span>
}

function Separator() {
  const { theme } = useTheme()
  return <span style={{ fg: theme.textMuted }}> · </span>
}

interface RowProps {
  children: JSX.Element
}

function Row(props: RowProps) {
  return (
    <box paddingLeft={1} paddingRight={1}>
      <text>{props.children}</text>
    </box>
  )
}

// ============================================================================
// Export compound component
// ============================================================================

export const StatusBar = {
  Root,
  Row,
  ErrorRow,
  Mode,
  Model,
  Status,
  Cwd,
  Git,
  Cost,
  Separator,
}
