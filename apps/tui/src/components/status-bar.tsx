import { Show, type JSX } from "solid-js"
import { useTheme } from "../theme/index"
import { useWorkspace } from "../workspace/index"
import { useClient } from "../client/index"

// ============================================================================
// Helper functions
// ============================================================================

function formatCost(cost: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cost)
}

function relativePath(cwd: string, gitRoot: string | null): string {
  if (gitRoot !== null) {
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
  const { theme } = useTheme()
  const client = useClient()

  return (
    <Show when={client.error() !== null}>
      <box paddingLeft={1} paddingRight={1}>
        <text style={{ fg: theme.error }}>{client.error()}</text>
      </box>
    </Show>
  )
}

function Agent() {
  const { theme } = useTheme()
  const client = useClient()

  return <span style={{ fg: theme.primary }}>{client.agent()}</span>
}

function Status() {
  const { theme } = useTheme()
  const client = useClient()

  const indicator = () => {
    const status = client.agentStatus()
    switch (status._tag) {
      case "streaming":
        return { text: "", color: theme.textMuted }
      case "error":
        return { text: "error", color: theme.error }
      case "idle":
        return { text: "", color: theme.textMuted }
    }
  }

  return (
    <Show when={indicator().text.length > 0}>
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
    <Show when={workspace.gitStatus()} keyed>
      {(git) => (
        <>
          <span style={{ fg: theme.warning }}>{git.branch}</span>
          <Show when={git.files > 0}>
            <span style={{ fg: theme.text }}> ~{git.files}</span>
            <Show when={git.additions > 0}>
              <span style={{ fg: theme.success }}> +{git.additions}</span>
            </Show>
            <Show when={git.deletions > 0}>
              <span style={{ fg: theme.error }}> -{git.deletions}</span>
            </Show>
          </Show>
        </>
      )}
    </Show>
  )
}

function Cost() {
  const { theme } = useTheme()
  const client = useClient()

  return <span style={{ fg: theme.textMuted }}>{formatCost(client.cost())}</span>
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
  Agent,
  Status,
  Cwd,
  Git,
  Cost,
  Separator,
}
