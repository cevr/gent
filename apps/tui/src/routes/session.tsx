/**
 * Session route - message list, composer, streaming
 */

import { createMemo, createSignal, For, Show } from "solid-js"
import { useTerminalDimensions } from "../terminal-dimensions"
import { Option, Predicate } from "effect"
import type { RGBA } from "@opentui/core"
import type { BranchId, SessionId } from "@gent/core-internal/domain/ids.js"
import { MessageList } from "../components/message-list"
import { NativeTranscript } from "../components/native-transcript"
import { Composer } from "../components/composer"
import { ComposerFrame } from "../components/composer-frame"
import { pickerText } from "../components/picker-text"
import { CommandPalette } from "../components/command-palette"
import { useCommand } from "../command/context"
import { useTheme, buildSyntaxStyle } from "../theme/index"
import { SessionTree } from "../components/session-tree"
import { MessagePicker } from "../components/message-picker"
import { collectDiagrams, MermaidViewer } from "../components/mermaid-viewer"
import { QueueWidget } from "../components/queue-widget"
import { useWorkspace } from "../workspace/context"
import { formatCwdGit, formatElapsed, type BorderLabelItem } from "../components/bordered-input"
import { buildTopRightLabels } from "../utils/session-labels"
import { PromptSearchPalette } from "../components/prompt-search-palette"
import { createSessionController, SessionControllerContext } from "./session-controller"
import { useExtensionUI } from "../extensions/context"
import { Auth } from "./auth"
import { Permissions } from "./permissions"
import type { BorderLabelColor, WidgetSlot } from "../extensions/client-facets.js"

export interface SessionProps {
  sessionId: SessionId
  branchId: BranchId
  initialPrompt?: string
  debugMode?: boolean
  missingAuthProviders?: readonly string[]
}

function ExtensionWidgets(props: { slot: WidgetSlot }) {
  const ext = useExtensionUI()
  const slotWidgets = () => ext.widgets().filter((w) => w.slot === props.slot)

  return (
    <For each={slotWidgets()}>
      {(widget) => {
        const Widget = widget.component
        return <Widget />
      }}
    </For>
  )
}

export function Session(props: SessionProps) {
  const { theme } = useTheme()
  const command = useCommand()
  const dimensions = useTerminalDimensions()
  const workspace = useWorkspace()
  const controller = createSessionController(props)
  const client = controller.client
  const ext = useExtensionUI()

  const syntaxStyle = createMemo(() => buildSyntaxStyle(theme))
  const [footerHeight, setFooterHeight] = createSignal(4)
  const mermaidDiagrams = createMemo(() => {
    if (controller.uiState().overlay._tag === "mermaid") {
      return collectDiagrams(controller.messages(), dimensions().width)
    }
    return []
  })

  // Map semantic color names from extensions to resolved theme colors
  const resolveColor = (color: BorderLabelColor | string): RGBA => {
    if (Predicate.isString(color)) {
      const colorMap = {
        warning: theme.warning,
        info: theme.info,
        success: theme.success,
        primary: theme.primary,
        text: theme.text,
        textMuted: theme.textMuted,
      }
      const isKnownColor = (name: string): name is keyof typeof colorMap =>
        Object.hasOwn(colorMap, name)
      if (isKnownColor(color)) return colorMap[color]
      return theme.text
    }
    return color
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

  const topRightLabels = (): BorderLabelItem[] => {
    const model = Option.fromNullishOr(client.modelInfo())
    const items: BorderLabelItem[] = []
    if (Option.isSome(model)) items.push({ text: model.value.name, color: theme.textMuted })
    return items.concat(
      buildTopRightLabels(
        client.session()?.reasoningLevel,
        client.latestInputTokens(),
        client.modelInfo()?.contextLength,
        theme,
        { debugMode: props.debugMode },
      ),
    )
  }

  const bottomLeftLabels = (): BorderLabelItem[] => {
    const a = controller.activity()
    const items: BorderLabelItem[] = []
    if (controller.uiState().transcriptExpanded) {
      items.push({ text: "transcript · Esc to return", color: theme.textMuted })
    }
    if (a.phase === "idle") {
      items.push({ text: controller.phaseLabel(), color: theme.textMuted })
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
    const label = formatCwdGit(
      workspace.cwd,
      Option.fromNullishOr(workspace.gitRoot()),
      Option.fromNullishOr(workspace.gitStatus()?.branch),
    )
    if (props.debugMode) items.push({ text: label, color: theme.textMuted })

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
        <NativeTranscript
          items={controller.items()}
          streaming={controller.activity().phase !== "idle"}
          footerHeight={footerHeight()}
          expanded={controller.uiState().transcriptExpanded}
          toolsExpanded={controller.toolsExpanded()}
          displayRevision={controller.uiState().displayRevision}
          overlayOpen={command.paletteOpen() || controller.uiState().overlay._tag !== "none"}
          renderItems={(items, streaming) => (
            <MessageList
              items={items}
              toolsExpanded={controller.toolsExpanded()}
              fullDetail={controller.uiState().transcriptExpanded}
              syntaxStyle={syntaxStyle}
              streaming={streaming}
              getChildSessions={controller.getChildren}
            />
          )}
        >
          <Show when={controller.items().length === 0}>
            <box height={1} flexShrink={0}>
              <text>
                <span style={{ fg: theme.primary, bold: true }}>gent</span>
                <span style={{ fg: theme.textMuted }}> · Ctrl+P for commands</span>
              </text>
            </box>
          </Show>
          <ExtensionWidgets slot="below-messages" />
          {/* QueueWidget stays hardwired because its data comes from session controller
              state that is not exposed through the extension context. */}
          <QueueWidget
            queuedMessages={controller.queueState().followUp}
            steerMessages={controller.queueState().steering}
          />
        </NativeTranscript>

        <box
          flexDirection="column"
          flexShrink={0}
          onSizeChange={function () {
            setFooterHeight(this.height)
          }}
        >
          <ExtensionWidgets slot="above-input" />

          <Show when={controller.activity().phase !== "idle"}>
            <box height={1} flexShrink={0} paddingLeft={2} marginTop={1} overflow="hidden">
              <text wrapMode="none" style={{ fg: theme.textMuted }}>
                {(() => {
                  let label = "Generating"
                  if (controller.activity().phase === "tool") label = controller.phaseLabel()
                  if (controller.elapsed() >= 1000)
                    label += ` (${formatElapsed(controller.elapsed())})`
                  return pickerText(label, Math.max(1, dimensions().width - 2))
                })()}
              </text>
            </box>
          </Show>

          <ComposerFrame
            labels={[
              ...bottomLeftLabels(),
              ...topLeftLabels(),
              ...topRightLabels(),
              ...bottomRightLabels(),
            ]}
          >
            <Composer>
              <Composer.Autocomplete />
              <CommandPalette />
            </Composer>
          </ComposerFrame>
          <ExtensionWidgets slot="below-input" />
        </box>

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
                  sessionId={props.sessionId}
                  enforceAuth={overlay.enforceAuth}
                  onResolved={controller.resolveAuthGate}
                  onClose={controller.closeOverlay}
                />
              )
            case "permissions":
              return <Permissions onClose={controller.closeOverlay} />
            case "extension": {
              const Overlay = Option.fromNullishOr(ext.overlays().get(overlay.overlayId))
              if (Option.isNone(Overlay)) return <></>
              const OverlayComponent = Overlay.value
              return <OverlayComponent open={true} onClose={controller.closeOverlay} />
            }
            default:
              return <></>
          }
        })()}
      </box>
    </SessionControllerContext.Provider>
  )
}
