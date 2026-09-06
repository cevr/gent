/**
 * Unified composer with autocomplete, interaction renderers, and submit flows.
 */

import { createContext, Show, type Accessor, type JSX } from "solid-js"
import { Option, Schema } from "effect"
import type { ActiveInteraction, ApprovalResult } from "@gent/core-internal/domain/event.js"
import { useTheme } from "../theme/index"
import { AutocompletePopup, type AutocompleteState } from "./autocomplete-popup"
import { useComposerController } from "./use-composer-controller"
import { ComposerInteractionEvent } from "./composer-interaction-state"
import { useSessionController } from "../routes/session-controller"
import { useExtensionUI } from "../extensions/context"
import { useRequiredContext } from "../utils/solid-context"

interface ComposerContextValue {
  // eslint-disable-next-line effect/noNullish -- AutocompletePopup uses null for its closed Solid state.
  autocomplete: Accessor<AutocompleteState | null>
  handleAutocompleteSelect: (value: string) => void
  handleAutocompleteClose: () => void
}

const ComposerContext = createContext<ComposerContextValue>()

export interface ComposerProps {
  children?: JSX.Element
}

export function Composer(props: ComposerProps) {
  const { theme } = useTheme()
  const sc = useSessionController()
  const controller = useComposerController()
  const ext = useExtensionUI()
  const decodeMetadata = Schema.decodeUnknownOption(Schema.JsonObject)
  const decodeString = Schema.decodeUnknownOption(Schema.String)
  const composerMode = (): "editing" | "shell" => {
    if (controller.mode() === "shell") return "shell"
    return "editing"
  }
  const promptColor = () => {
    if (controller.mode() === "shell") return theme.warning
    return theme.primary
  }

  const contextValue: ComposerContextValue = {
    autocomplete: controller.autocomplete,
    handleAutocompleteSelect: controller.handleAutocompleteSelect,
    handleAutocompleteClose: controller.handleAutocompleteClose,
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

  const composerSurface = () => Option.fromNullishOr(ext.composerSurface())

  return (
    <ComposerContext.Provider value={contextValue}>
      {props.children}

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

      <Show
        when={controller.mode() !== "interaction" && Option.getOrUndefined(composerSurface())}
        keyed
      >
        {(Surface) =>
          Surface({
            draft: sc.interactionState().draft,
            setDraft: (text: string) =>
              sc.onComposerInteraction(ComposerInteractionEvent.cases.RestoreDraft.make({ text })),
            submit: () => controller.handleSubmitFromTextarea(),
            focused: controller.inputFocused(),
            mode: composerMode(),
          })
        }
      </Show>

      <Show when={controller.mode() !== "interaction" && Option.isNone(composerSurface())}>
        <box flexShrink={0} flexDirection="row">
          <text style={{ fg: promptColor() }}>{controller.promptSymbol()}</text>
          <box flexGrow={1}>
            <textarea
              ref={controller.attachTextarea}
              focused={controller.inputFocused()}
              onKeyDown={controller.handleTextareaKeyDown}
              onSubmit={controller.handleSubmitFromTextarea}
              wrapMode="word"
              minHeight={1}
              maxHeight={8}
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
          onClose={ctx.handleAutocompleteClose}
        />
      )}
    </Show>
  )
}
