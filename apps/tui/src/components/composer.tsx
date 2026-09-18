/**
 * Unified composer with autocomplete, interaction renderers, and submit flows.
 */

import { createContext, createSignal, Show, type Accessor, type JSX } from "solid-js"
import { Option, Schema } from "effect"
import type { ActiveInteraction, ApprovalResult } from "@gent/core/protocol"
import { useTheme } from "../theme"
import { AutocompletePopup, type AutocompleteState } from "./autocomplete-popup"
import { useComposerController } from "./use-composer-controller"
import { useSessionController } from "../routes/session-controller"
import { useExtensionUI } from "../extensions/context"
import { useRequiredContext } from "../utils"
import { useTerminalDimensions } from "../terminal"

interface ComposerContextValue {
  // eslint-disable-next-line effect/noNullish -- AutocompletePopup uses null for its closed Solid state.
  autocomplete: Accessor<AutocompleteState | null>
  handleAutocompleteSelect: (value: string) => void
  handleAutocompleteComplete: (value: string) => void
  handleAutocompleteClose: () => void
  setGhost: (ghost: Option.Option<string>) => void
}

const ComposerContext = createContext<ComposerContextValue>()

interface ComposerProps {
  children?: JSX.Element
}

export function Composer(props: ComposerProps) {
  const { theme } = useTheme()
  const sc = useSessionController()
  const controller = useComposerController()
  const ext = useExtensionUI()
  const dimensions = useTerminalDimensions()
  const [pickerHeight, setPickerHeight] = createSignal(0)
  // Keep one transcript row and the composer's spacing/status rows visible.
  const editorHeight = () => Math.max(1, Math.min(8, dimensions().height - pickerHeight() - 4))
  const decodeMetadata = Schema.decodeUnknownOption(Schema.JsonObject)
  const decodeString = Schema.decodeUnknownOption(Schema.String)
  const promptColor = () => {
    if (controller.mode() === "shell") return theme.warning
    return theme.primary
  }

  /**
   * The completion the popup's top row offers, or none.
   *
   * It is drawn as a muted line under the input rather than as text inside it.
   * The buffer's own virtual-text facility (`extmarks`) cannot draw it: marks
   * created with `virtual: true` are stored and returned by `getVirtual()` but
   * never reach the screen, and holding one across an edit breaks undo. Drawing
   * beside the textarea fails differently — a shrink-to-fit input hands the
   * ghost whatever columns are left on each wrapped row, so a long draft splits
   * the ghost mid-word across lines. A row of its own is the one placement that
   * survives wrapping, and it keeps the draft literally what the reader typed:
   * the ghost is never in the buffer, so Enter can never submit it.
   */
  const [ghost, setGhost] = createSignal(Option.none<string>())

  const contextValue: ComposerContextValue = {
    autocomplete: controller.autocomplete,
    handleAutocompleteSelect: controller.handleAutocompleteSelect,
    handleAutocompleteComplete: controller.handleAutocompleteComplete,
    handleAutocompleteClose: controller.handleAutocompleteClose,
    setGhost,
  }

  /** The ghost is only an offer while there is an open popup to complete from. */
  const visibleGhost = (): Option.Option<string> => {
    if (Option.isNone(Option.fromNullishOr(controller.autocomplete()))) return Option.none()
    if (controller.mode() !== "editing") return Option.none()
    return ghost()
  }

  const activeInteraction = (): Option.Option<ActiveInteraction> => {
    const cs = sc.composerState()
    if (cs._tag !== "interaction") return Option.none()
    return Option.some(cs.interaction)
  }

  const interactionRenderer = () => {
    const interaction = activeInteraction()
    if (Option.isNone(interaction)) return Option.none()
    // Route by metadata.type if present, fall back to default renderer (undefined key)
    const meta = interaction.value.metadata
    const metadataType = decodeMetadata(meta).pipe(
      Option.flatMap((metadata) => decodeString(metadata["type"])),
    )
    const specific = Option.flatMap(metadataType, (type) =>
      Option.fromNullishOr(ext.interactionRenderers().get(type)),
    )
    const defaultKey = Option.getOrUndefined(Option.none<string>())
    return Option.orElse(specific, () =>
      Option.fromNullishOr(ext.interactionRenderers().get(defaultKey)),
    )
  }

  return (
    <ComposerContext.Provider value={contextValue}>
      <Show when={Option.getOrUndefined(activeInteraction())} keyed>
        {(interaction) => {
          const Renderer = interactionRenderer()
          if (Option.isNone(Renderer)) {
            // Graceful degradation: cancel interaction so the tool doesn't hang
            controller.cancelInteraction()
            return (
              <box paddingLeft={1} paddingTop={1}>
                <text style={{ fg: theme.warning }}>
                  No renderer for {interaction._tag} — interaction cancelled
                </text>
              </box>
            )
          }
          return Renderer.value({
            event: interaction,
            resolve: (result: ApprovalResult) => {
              controller.resolveInteraction(result)
            },
          })
        }}
      </Show>

      <Show when={controller.mode() !== "interaction"}>
        <box
          flexShrink={0}
          flexDirection="row"
          border={["left"]}
          borderStyle="heavy"
          borderColor={promptColor()}
          paddingLeft={1}
        >
          <Show when={controller.mode() === "shell"}>
            <text style={{ fg: promptColor() }}>$ </text>
          </Show>
          <box flexGrow={1}>
            <textarea
              ref={controller.attachTextarea}
              focused={controller.inputFocused()}
              onKeyDown={controller.handleTextareaKeyDown}
              onSubmit={controller.handleSubmitFromTextarea}
              wrapMode="word"
              minHeight={1}
              maxHeight={editorHeight()}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "return", shift: true, action: "newline" },
                { name: "return", ctrl: true, action: "newline" },
                { name: "linefeed", action: "newline" },
                { name: "linefeed", shift: true, action: "newline" },
                { name: "backspace", meta: true, action: "delete-word-backward" },
              ]}
              backgroundColor="transparent"
              focusedBackgroundColor="transparent"
            />
          </box>
        </box>
      </Show>

      {/* The ghost line: what Tab would complete, muted, on a row of its own. */}
      <Show when={Option.getOrUndefined(visibleGhost())}>
        {(completion) => (
          <box flexShrink={0} height={1} paddingLeft={2} overflow="hidden">
            <text style={{ fg: theme.textMuted }} wrapMode="none">
              {completion()} <span style={{ fg: theme.textMuted }}>⇥</span>
            </text>
          </box>
        )}
      </Show>

      <box
        flexDirection="column"
        flexShrink={0}
        onSizeChange={function () {
          setPickerHeight(this.height)
        }}
      >
        {props.children}
      </box>
    </ComposerContext.Provider>
  )
}

Composer.Autocomplete = function ComposerAutocomplete() {
  const ctx = useRequiredContext(
    ComposerContext,
    "Composer.Autocomplete must be used within Composer",
  )

  return (
    <Show when={ctx.autocomplete()}>
      {(state) => (
        <AutocompletePopup
          state={state()}
          onSelect={ctx.handleAutocompleteSelect}
          onComplete={ctx.handleAutocompleteComplete}
          onClose={ctx.handleAutocompleteClose}
          onGhostChange={ctx.setGhost}
        />
      )}
    </Show>
  )
}
