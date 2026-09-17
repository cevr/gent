/**
 * Session route - message list, composer, streaming
 */

import { createMemo, createSignal, For, Show } from "solid-js"
import { useTerminalDimensions } from "../terminal-dimensions"
import { Option, Predicate, Schema } from "effect"
import type { RGBA } from "@opentui/core"
import {
  ModelId,
  ReasoningEffort,
  type Branch,
  type BranchId,
  type SessionId,
} from "@gent/core/protocol"
import { MessageList } from "../components/message-list"
import { NativeTranscript } from "../components/native-transcript"
import { Composer } from "../components/composer"
import { ComposerFrame } from "../components/composer-frame"
import { truncate } from "../utils/truncate"
import { CommandPalette } from "../components/command-palette"
import { useCommand } from "../command/context"
import { useTheme, buildSyntaxStyle } from "../theme/index"
import { BranchPicker } from "../components/branch-picker"
import { MessagePicker } from "../components/message-picker"
import {
  DEFAULT_ROW_ID,
  modelRows,
  reasoningRows,
  SettingsPicker,
} from "../components/settings-picker"
import { collectDiagrams, MermaidViewer } from "../components/mermaid-viewer"
import { QueueWidget } from "../components/queue-widget"
import { useWorkspace } from "../workspace/context"
import {
  buildContextLabels,
  buildTopRightLabels,
  formatCwdGit,
  type BorderLabelItem,
} from "../utils/session-labels"
import { formatDuration } from "../utils/format-duration"
import { PromptSearchPalette } from "../components/prompt-search-palette"
import { createSessionController, SessionControllerContext } from "./session-controller"
import { useExtensionUI } from "../extensions/context"
import { useClient } from "../client/index"
import { Auth } from "./auth"
import type { BorderLabelColor, WidgetSlot } from "../extensions/client-facets.js"

interface SessionProps {
  sessionId: SessionId
  branchId: BranchId
  /** Branches to dock the picker over at boot; `None` resumes straight in. */
  initialBranches: Option.Option<readonly Branch[]>
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

/** A reasoning row id; `default` decodes to `None` and clears the override. */
const parseReasoningRow = Schema.decodeUnknownOption(ReasoningEffort)

export function Session(props: SessionProps) {
  const { theme } = useTheme()
  const command = useCommand()
  const dimensions = useTerminalDimensions()
  const workspace = useWorkspace()
  const controller = createSessionController(props)
  const client = useClient()
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
    } else if (conn?._tag === "Connected" && conn.generation > 0) {
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

    return items
  }

  /**
   * The running total, rendered last of everything.
   *
   * Cost used to sit in the top-left group, which put it between the
   * connection state and the model. It is the one number a reader glances at
   * without reading the rest of the row, so it belongs at the far end where
   * its position is fixed and nothing before it can shift it.
   */
  const costLabels = (): BorderLabelItem[] => {
    const c = client.cost()
    if (c <= 0) return []
    return [{ text: `$${c.toFixed(2)}`, color: theme.textMuted }]
  }

  const topRightLabels = (): BorderLabelItem[] => {
    const model = Option.fromNullishOr(client.modelInfo())
    const items: BorderLabelItem[] = []
    if (Option.isSome(model)) items.push({ text: model.value.name, color: theme.textMuted })
    return items.concat(
      buildTopRightLabels({
        reasoningLevel: Option.fromNullishOr(client.reasoningLevel()),
        theme,
        debugMode: props.debugMode === true,
      }),
    )
  }

  /**
   * The labels anchored to the right edge: the context gauge and the running
   * total. Both are numbers a reader checks at a glance without reading the
   * row, so they hold their place and the left group truncates instead.
   */
  const rightAnchoredLabels = (): BorderLabelItem[] =>
    buildContextLabels({
      metrics: client.sessionMetrics(),
      contextLength: client.modelInfo()?.contextLength,
      theme,
    }).concat(costLabels())

  const bottomLeftLabels = (): BorderLabelItem[] => {
    const a = controller.activity()
    const items: BorderLabelItem[] = []
    if (controller.uiState().transcriptExpanded) {
      items.push({ text: "transcript · Esc to return", color: theme.textMuted })
    }
    // A local error (a slash command that could not apply, a failed RPC)
    // replaces the phase word until the next turn clears it.
    const localError = Option.fromNullishOr(client.error())
    if (Option.isSome(localError)) {
      items.push({ text: localError.value, color: theme.error })
    } else if (a.phase === "idle") {
      items.push({ text: controller.phaseLabel(), color: theme.textMuted })
    }

    // Where the session is rooted, beside the phase word rather than behind a
    // debug flag. A reader running several sessions at once cannot tell them
    // apart from the model and cost alone, and the cwd is the thing that
    // distinguishes them.
    items.push({
      text: formatCwdGit(
        workspace.cwd,
        Option.fromNullishOr(workspace.gitRoot()),
        Option.fromNullishOr(workspace.gitStatus()?.branch),
      ),
      color: theme.textMuted,
    })

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
          disclosure={controller.uiState().disclosure}
          displayRevision={controller.uiState().displayRevision}
          overlayOpen={command.paletteOpen() || controller.uiState().overlay._tag !== "none"}
          renderItems={(items, streaming) => (
            <MessageList
              items={items}
              disclosure={controller.uiState().disclosure}
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
                    label += ` (${formatDuration(controller.elapsed(), "compact")})`
                  return truncate(label, Math.max(1, dimensions().width - 2))
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
              ...rightAnchoredLabels(),
            ]}
            rightLabels={rightAnchoredLabels().length}
          >
            <Composer>
              <Composer.Autocomplete />
              <CommandPalette />
            </Composer>
          </ComposerFrame>
          <SettingsPicker
            open={controller.uiState().overlay._tag === "model"}
            title="Model"
            rows={modelRows(client.models())}
            current={Option.some(client.model())}
            onSelect={(id) => controller.onModelSelect(ModelId.make(id))}
            onClose={controller.closeOverlay}
          />
          <SettingsPicker
            open={controller.uiState().overlay._tag === "reasoning"}
            title="Reasoning"
            rows={reasoningRows(client.resolvedReasoningLevel())}
            current={Option.some(
              Option.getOrElse(
                Option.fromUndefinedOr(client.session()?.reasoningLevel),
                () => DEFAULT_ROW_ID,
              ),
            )}
            onSelect={(id) => controller.onReasoningSelect(parseReasoningRow(id))}
            onClose={controller.closeOverlay}
          />
          {(() => {
            const overlay = controller.uiState().overlay
            if (overlay._tag !== "branches") return <></>
            return (
              <BranchPicker
                open={true}
                sessionId={props.sessionId}
                sessionName={controller.currentSessionName()}
                branches={overlay.branches}
                onSelect={controller.onBranchPickerSelect}
                onClose={controller.onBranchPickerDismiss}
              />
            )
          })()}
          <ExtensionWidgets slot="below-input" />
        </box>

        <MessagePicker
          open={controller.uiState().overlay._tag === "fork"}
          messages={controller.forkMessages()}
          onSelect={controller.onForkSelect}
          onClose={controller.closeOverlay}
        />

        <MermaidViewer
          open={controller.uiState().overlay._tag === "mermaid"}
          diagrams={mermaidDiagrams()}
          onClose={controller.closeOverlay}
        />

        <PromptSearchPalette
          state={controller.promptSearch.state()}
          entries={controller.promptSearch.entries()}
          onEvent={controller.promptSearch.onEvent}
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
