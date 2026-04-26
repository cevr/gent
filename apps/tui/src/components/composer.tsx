/**
 * Unified composer with autocomplete, interaction renderers, and submit flows.
 */

import { createContext, Show, useContext, type Accessor, type JSX } from "solid-js"
import type { ActiveInteraction, ApprovalResult } from "@gent/core/domain/event.js"
import { useTheme } from "../theme/index"
import { AutocompletePopup, type AutocompleteState } from "./autocomplete-popup"
import { useComposerController } from "./use-composer-controller"
import { ComposerInteractionEvent } from "./composer-interaction-state"
import { useSessionController } from "../routes/session-controller"
import { useExtensionUI } from "../extensions/context"

interface ComposerContextValue {
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

  const contextValue: ComposerContextValue = {
    autocomplete: controller.autocomplete,
    handleAutocompleteSelect: controller.handleAutocompleteSelect,
    handleAutocompleteClose: controller.handleAutocompleteClose,
  }

  const activeInteraction = (): ActiveInteraction | undefined => {
    const cs = sc.composerState()
    return cs?._tag === "interaction" ? cs.interaction : undefined
  }

  const interactionRenderer = () => {
    const interaction = activeInteraction()
    if (interaction === undefined) return undefined
    // Route by metadata.type if present, fall back to default renderer (undefined key)
    const meta = interaction.metadata
    const metadataType =
      meta !== undefined && typeof meta === "object" && meta !== null && "type" in meta
        ? String((meta as Record<string, unknown>)["type"])
        : undefined
    return ext.interactionRenderers().get(metadataType) ?? ext.interactionRenderers().get(undefined)
  }

  return (
    <ComposerContext.Provider value={contextValue}>
      {props.children}

      <Show when={activeInteraction()} keyed>
        {(interaction) => {
          const Renderer = interactionRenderer()
          if (Renderer === undefined) {
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
          return Renderer({
            event: interaction,
            resolve: (result: ApprovalResult) => {
              controller.resolveInteraction(result)
            },
          })
        }}
      </Show>

      <Show when={controller.mode() !== "interaction" && ext.composerSurface()} keyed>
        {(Surface) =>
          Surface({
            draft: sc.interactionState().draft,
            setDraft: (text: string) =>
              sc.onComposerInteraction(ComposerInteractionEvent.RestoreDraft.make({ text })),
            submit: () => controller.handleSubmitFromTextarea(),
            focused: controller.inputFocused(),
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TUI adapter narrows heterogeneous framework value shape
            mode: controller.mode() as "editing" | "shell",
          })
        }
      </Show>

      <Show when={controller.mode() !== "interaction" && ext.composerSurface() === undefined}>
        <box flexShrink={0} flexDirection="row">
          <text style={{ fg: controller.mode() === "shell" ? theme.warning : theme.primary }}>
            {controller.promptSymbol()}
          </text>
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
  const ctx = useContext(ComposerContext)
  if (ctx === undefined) return null

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
