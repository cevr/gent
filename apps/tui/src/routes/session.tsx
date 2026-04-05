/**
 * Session route - message list, composer, streaming
 */

import { createMemo } from "solid-js"
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
import { createSessionController, SessionControllerContext } from "./session-controller"
import { ExtensionWidgets } from "../components/extension-widgets"
import { useExtensionUI } from "../extensions/context"
import { Auth } from "./auth"
import { Permissions } from "./permissions"

export interface SessionProps {
  sessionId: SessionId
  branchId: BranchId
  initialPrompt?: string
  debugMode?: boolean
  missingAuthProviders?: readonly string[]
}

export function Session(props: SessionProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const workspace = useWorkspace()
  const controller = createSessionController(props)
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

  // Map semantic color names from extensions to resolved theme colors
  const resolveColor = (color: unknown) => {
    if (typeof color === "string") {
      const colorMap: Record<string, unknown> = {
        warning: theme.warning,
        info: theme.info,
        primary: theme.primary,
        text: theme.text,
        textMuted: theme.textMuted,
      }
      return (colorMap[color] ?? theme.text) as typeof theme.text
    }
    return color as typeof theme.text
  }

  const topLeftLabels = (): BorderLabelItem[] => {
    const items: BorderLabelItem[] = []

    // Core chrome: connection/restart status
    const conn = client.connectionState()
    if (client.isReconnecting()) {
      items.push({ text: "reconnecting", color: theme.warning })
    } else if (conn?._tag === "connected" && conn.generation > 0) {
      items.push({ text: `restart ${conn.generation}`, color: theme.textMuted })
    }

    // Extension-contributed labels
    for (const label of ext.borderLabels()) {
      if (label.position === "top-left") {
        for (const item of label.produce()) {
          items.push({ text: item.text, color: resolveColor(item.color) })
        }
      }
    }

    // Core chrome: cost
    const c = client.cost()
    if (c > 0) items.push({ text: `$${c.toFixed(2)}`, color: theme.textMuted })
    return items
  }

  const topRightLabels = (): BorderLabelItem[] =>
    buildTopRightLabels(
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

    // Extension-contributed labels
    for (const label of ext.borderLabels()) {
      if (label.position === "bottom-left") {
        for (const item of label.produce()) {
          items.push({ text: item.text, color: resolveColor(item.color) })
        }
      }
    }

    return items
  }

  const bottomRightLabels = (): BorderLabelItem[] => {
    const items: BorderLabelItem[] = []
    const label = formatCwdGit(workspace.cwd, workspace.gitRoot(), workspace.gitStatus()?.branch)
    items.push({ text: label, color: theme.textMuted })

    // Extension-contributed labels
    for (const bl of ext.borderLabels()) {
      if (bl.position === "bottom-right") {
        for (const item of bl.produce()) {
          items.push({ text: item.text, color: resolveColor(item.color) })
        }
      }
    }

    return items
  }

  return (
    <SessionControllerContext.Provider value={controller}>
      <box flexDirection="column" flexGrow={1}>
        {/* Messages */}
        <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
          <box flexDirection="column">
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
          <Composer>
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

        {(() => {
          const overlay = controller.uiState().overlay
          switch (overlay._tag) {
            case "auth":
              return (
                <Auth
                  enforceAuth={overlay.enforceAuth}
                  onResolved={controller.closeOverlay}
                  onClose={controller.closeOverlay}
                />
              )
            case "permissions":
              return <Permissions onClose={controller.closeOverlay} />
            case "extension": {
              const Overlay = ext.overlays().get(overlay.overlayId)
              if (Overlay === undefined) return null
              return <Overlay open={true} onClose={controller.closeOverlay} />
            }
            default:
              return null
          }
        })()}

        <ExtensionWidgets slot="below-input" />
      </box>
    </SessionControllerContext.Provider>
  )
}
