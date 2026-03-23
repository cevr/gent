/**
 * Unified composer with autocomplete, prompt mode, and submit flows.
 */

import { createContext, Show, useContext, type Accessor, type JSX } from "solid-js"
import { useTheme } from "../theme/index"
import { AutocompletePopup, type AutocompleteState } from "./autocomplete-popup"
import { ComposerPrompt } from "./composer-prompt"
import { useComposerController, type ComposerControllerProps } from "./use-composer-controller"

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

  const contextValue: ComposerContextValue = {
    autocomplete: controller.autocomplete,
    handleAutocompleteSelect: controller.handleAutocompleteSelect,
    handleAutocompleteClose: controller.handleAutocompleteClose,
  }

  return (
    <ComposerContext.Provider value={contextValue}>
      {props.children}

      <Show when={controller.currentQuestion()} keyed>
        {(question) => (
          <ComposerPrompt question={question} onSubmit={controller.handlePromptSubmit} />
        )}
      </Show>

      <Show when={controller.mode() !== "prompt"}>
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
