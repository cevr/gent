/**
 * Session route - message list, composer, streaming
 */

import { createMemo, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import { MessageList } from "../components/message-list"
import { Composer } from "../components/composer"
import { useTheme, buildSyntaxStyle } from "../theme/index"
import { SessionTree } from "../components/session-tree"
import { MessagePicker } from "../components/message-picker"
import { collectDiagrams, MermaidViewer } from "../components/mermaid-viewer"
import { QueueWidget } from "../components/queue-widget"
import { useWorkspace } from "../workspace/index"
import {
  BorderedInput,
  formatCwdGit,
  formatElapsed,
  type BorderLabelItem,
} from "../components/bordered-input"
import { buildTopRightLabels } from "../utils/session-labels"
import { PromptSearchPalette } from "../components/prompt-search-palette"
import { useSessionController } from "./session-controller"
import { ExtensionWidgets } from "../components/extension-widgets"
import { useExtensionUI } from "../extensions/context"

export interface SessionProps {
  sessionId: SessionId
  branchId: BranchId
  initialPrompt?: string
  debugMode?: boolean
}

export function Session(props: SessionProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const workspace = useWorkspace()
  const controller = useSessionController(props)
  const client = controller.client
  const ext = useExtensionUI()

  const syntaxStyle = createMemo(() => buildSyntaxStyle(theme))
  const mermaidDiagrams = createMemo(() =>
    controller.uiState().overlay._tag === "mermaid"
      ? collectDiagrams(controller.messages(), dimensions().width)
      : [],
  )

  const borderColor = () => {
    if (client.isError()) return theme.error
    if (props.debugMode === true) return theme.warning
    if (client.isStreaming()) return theme.borderActive
    return theme.border
  }

  const topLeftLabels = (): BorderLabelItem[] => {
    const items: BorderLabelItem[] = []
    const conn = client.connectionState()
    if (client.isReconnecting()) {
      items.push({ text: "reconnecting", color: theme.warning })
    } else if (conn?._tag === "connected" && conn.generation > 0) {
      items.push({ text: `restart ${conn.generation}`, color: theme.textMuted })
    }

    // Auto mode indicator
    const autoSnap = ext.snapshots().get("auto")
    const autoModel = autoSnap?.model as
      | { active?: boolean; phase?: string; iteration?: number; maxIterations?: number }
      | undefined
    if (autoModel?.active) {
      const phase = autoModel.phase === "awaiting-counsel" ? "counsel" : "auto"
      const iter =
        autoModel.iteration !== undefined
          ? ` ${autoModel.iteration}/${autoModel.maxIterations ?? "?"}`
          : ""
      items.push({
        text: `${phase}${iter}`,
        color: autoModel.phase === "awaiting-counsel" ? theme.warning : theme.info,
      })
    }

    // Plan mode indicator
    const planSnap = ext.snapshots().get("plan")
    const planModel = planSnap?.model as
      | { mode?: string; progress?: { total: number; done: number; inProgress: number } }
      | undefined
    if (planModel?.mode === "plan") {
      items.push({ text: "plan", color: theme.primary })
    } else if (planModel?.mode === "executing") {
      const p = planModel.progress
      const label = p ? `exec ${p.done}/${p.total}` : "exec"
      items.push({ text: label, color: theme.primary })
    }

    const c = client.cost()
    if (c > 0) items.push({ text: `$${c.toFixed(2)}`, color: theme.textMuted })
    return items
  }

  const topRightLabels = (): BorderLabelItem[] =>
    buildTopRightLabels(
      client.agent(),
      client.session()?.reasoningLevel,
      client.latestInputTokens(),
      client.modelInfo()?.contextLength,
      theme,
      { debugMode: props.debugMode },
    )

  const bottomLeftLabels = (): BorderLabelItem[] => {
    const a = controller.activity()
    const items: BorderLabelItem[] = []
    if (a.phase !== "idle") {
      items.push({ text: controller.spinner(), color: theme.textMuted })
    }
    items.push({
      text: controller.phaseLabel(),
      color: a.phase === "idle" ? theme.textMuted : theme.info,
    })
    if (a.phase !== "idle" && controller.elapsed() >= 1000) {
      items.push({ text: formatElapsed(controller.elapsed()), color: theme.textMuted })
    }
    return items
  }

  const bottomRightLabels = (): BorderLabelItem[] => {
    const label = formatCwdGit(workspace.cwd, workspace.gitRoot(), workspace.gitStatus()?.branch)
    return [{ text: label, color: theme.textMuted }]
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Messages */}
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        <box flexDirection="column">
          <ExtensionWidgets slot="above-messages" />
          <MessageList
            items={controller.items()}
            toolsExpanded={controller.toolsExpanded()}
            syntaxStyle={syntaxStyle}
            streaming={client.isStreaming()}
            getChildSessions={controller.getChildren}
          />

          <ExtensionWidgets slot="below-messages" />
          {/* QueueWidget stays hardwired — its data comes from session controller state,
              not available via extension context yet (planned for batch 9) */}
          <QueueWidget
            queuedMessages={controller.queueState().followUp}
            steerMessages={controller.queueState().steering}
          />
        </box>
      </scrollbox>

      <ExtensionWidgets slot="above-input" />

      {/* Bordered input */}
      <BorderedInput
        topLeft={topLeftLabels()}
        topRight={topRightLabels()}
        bottomLeft={bottomLeftLabels()}
        bottomRight={bottomRightLabels()}
        borderColor={borderColor()}
      >
        <Composer
          onSubmit={controller.onSubmit}
          onSlashCommand={controller.onSlashCommand}
          clearMessages={controller.clearMessages}
          onRestoreQueue={controller.onRestoreQueue}
          suspended={controller.promptSearchOpen()}
          interactionState={controller.interactionState()}
          onInteractionEvent={controller.onComposerInteraction}
          composerState={controller.composerState()}
          onComposerEvent={controller.onComposerEvent}
        >
          <Composer.Autocomplete />
        </Composer>
      </BorderedInput>

      <SessionTree
        open={controller.uiState().overlay._tag === "tree"}
        tree={controller.treeOverlay()}
        currentSessionId={props.sessionId}
        onSelect={controller.onSessionTreeSelect}
        onClose={controller.closeOverlay}
      />

      <MessagePicker
        open={controller.uiState().overlay._tag === "fork"}
        messages={controller.messages()}
        onSelect={controller.onForkSelect}
        onClose={controller.closeOverlay}
      />

      <MermaidViewer
        open={controller.uiState().overlay._tag === "mermaid"}
        diagrams={mermaidDiagrams()}
        onClose={controller.closeOverlay}
      />

      <PromptSearchPalette
        state={controller.promptSearchState()}
        entries={controller.promptEntries()}
        onEvent={controller.onPromptSearchEvent}
      />

      <Show when={controller.uiState().overlay._tag === "extension"}>
        {(() => {
          const overlay = controller.uiState().overlay
          if (overlay._tag !== "extension") return null
          const Overlay = ext.overlays().get(overlay.overlayId)
          if (Overlay === undefined) return null
          return <Overlay open={true} onClose={controller.closeOverlay} />
        })()}
      </Show>

      <ExtensionWidgets slot="below-input" />
    </box>
  )
}
