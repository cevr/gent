/**
 * Unified composer with autocomplete, interaction renderers, and submit flows.
 */

import { createContext, Show, useContext, type Accessor, type JSX } from "solid-js"
import type { ActiveInteraction, InteractionEventTag } from "@gent/core/domain/event.js"
import { useTheme } from "../theme/index"
import { AutocompletePopup, type AutocompleteState } from "./autocomplete-popup"
import { useComposerController, type ComposerControllerProps } from "./use-composer-controller"
import { useExtensionUI } from "../extensions/context"

interface ComposerContextValue {
  autocomplete: Accessor<AutocompleteState | null>
  handleAutocompleteSelect: (value: string) => void
  handleAutocompleteClose: () => void
}

const ComposerContext = createContext<ComposerContextValue>()

export interface ComposerProps extends ComposerControllerProps {
  children?: JSX.Element
}

export function Composer(props: ComposerProps) {
  const { theme } = useTheme()
  const controller = useComposerController(props)
  const ext = useExtensionUI()

  const contextValue: ComposerContextValue = {
    autocomplete: controller.autocomplete,
    handleAutocompleteSelect: controller.handleAutocompleteSelect,
    handleAutocompleteClose: controller.handleAutocompleteClose,
  }

  const activeInteraction = (): ActiveInteraction | undefined =>
    props.composerState?._tag === "interaction" ? props.composerState.interaction : undefined

  const interactionRenderer = () => {
    const interaction = activeInteraction()
    if (interaction === undefined) return undefined
    return ext.interactionRenderers().get(interaction._tag)
  }

  return (
    <ComposerContext.Provider value={contextValue}>
      {props.children}

      <Show when={activeInteraction()} keyed>
        {(interaction) => {
          const Renderer = interactionRenderer()
          if (Renderer === undefined) return null
          return Renderer({
            event: interaction,
            resolve: (result: unknown) => {
              controller.resolveInteraction(
                interaction._tag as InteractionEventTag,
                result as never,
              )
            },
          })
        }}
      </Show>

      <Show when={controller.mode() !== "interaction"}>
        <box flexShrink={0} flexDirection="row">
          <text style={{ fg: controller.mode() === "shell" ? theme.warning : theme.primary }}>
            {controller.promptSymbol()}
          </text>
          <box flexGrow={1}>
            <textarea
              ref={controller.attachTextarea}
              focused={controller.inputFocused()}
              onKeyDown={controller.handleTextareaKeyDown}
              wrapMode="word"
              minHeight={1}
              maxHeight={8}
              keyBindings={[
                { name: "return", shift: true, action: "newline" },
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
    <Show when={ctx.autocomplete()} keyed>
      {(state) => (
        <AutocompletePopup
          state={state}
          onSelect={ctx.handleAutocompleteSelect}
          onClose={ctx.handleAutocompleteClose}
        />
      )}
    </Show>
  )
}
