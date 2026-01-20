/**
 * Unified input component with autocomplete support
 */

import { createSignal, createContext, useContext, onMount, Show, type JSX, type Accessor } from "solid-js"
import type { InputRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { useWorkspace } from "../workspace/index"
import { useCommand } from "../command/index"
import { useAgentState } from "../agent-state/index"
import {
  AutocompletePopup,
  type AutocompleteState,
  type AutocompleteType,
} from "./autocomplete-popup"
import { executeShell } from "../utils/shell"
import { expandFileRefs } from "../utils/file-refs"
import { executeSlashCommand, parseSlashCommand } from "../commands/slash-commands"

export type InputMode = "normal" | "shell"

interface InputContextValue {
  autocomplete: Accessor<AutocompleteState | null>
  handleAutocompleteSelect: (value: string) => void
  handleAutocompleteClose: () => void
}

const InputContext = createContext<InputContextValue>()

export interface InputProps {
  onSubmit: (content: string) => void
  onSlashCommand?: (cmd: string, args: string) => Promise<void>
  clearMessages?: () => void
  children?: JSX.Element
}

export function Input(props: InputProps) {
  const { theme } = useTheme()
  const workspace = useWorkspace()
  const command = useCommand()
  const agentState = useAgentState()

  let inputRef: InputRenderable | null = null

  const [inputMode, setInputMode] = createSignal<InputMode>("normal")
  const [autocomplete, setAutocomplete] = createSignal<AutocompleteState | null>(null)

  // Delete word backward
  const deleteWordBackward = () => {
    if (!inputRef) return
    const value = inputRef.value
    const cursor = inputRef.cursorPosition
    if (cursor === 0) return

    let pos = cursor - 1
    while (pos > 0 && value[pos - 1] === " ") pos--
    while (pos > 0 && value[pos - 1] !== " ") pos--

    inputRef.value = value.slice(0, pos) + value.slice(cursor)
    inputRef.cursorPosition = pos
  }

  // Delete line backward
  const deleteLineBackward = () => {
    if (!inputRef) return
    const value = inputRef.value
    const cursor = inputRef.cursorPosition
    if (cursor === 0) return

    inputRef.value = value.slice(cursor)
    inputRef.cursorPosition = 0
  }

  // Handle autocomplete selection
  const handleAutocompleteSelect = (value: string) => {
    const state = autocomplete()
    if (!state || !inputRef) return

    const currentValue = inputRef.value
    const beforeTrigger = currentValue.slice(0, state.triggerPos)

    let insertion = ""
    switch (state.type) {
      case "$":
        insertion = `$${value.split(":").pop() ?? value} `
        break
      case "@":
        insertion = `@${value} `
        break
      case "/":
        insertion = `/${value} `
        break
    }

    inputRef.value = beforeTrigger + insertion
    inputRef.cursorPosition = beforeTrigger.length + insertion.length
    setAutocomplete(null)
  }

  // Handle autocomplete close
  const handleAutocompleteClose = () => {
    setAutocomplete(null)
    inputRef?.focus()
  }

  // Handle input changes for autocomplete detection
  const handleInputChange = (value: string) => {
    // No autocomplete in shell mode
    if (inputMode() === "shell") {
      setAutocomplete(null)
      return
    }

    // Handle / command autocomplete
    if (autocomplete()?.type === "/") {
      if (value.startsWith("/")) {
        setAutocomplete({ type: "/", filter: value.slice(1), triggerPos: 0 })
      } else {
        setAutocomplete(null)
      }
      return
    }

    // Detect $ or @ triggers
    const match = value.match(/(?:^|[\s])([$@])([^\s]*)$/)
    if (match) {
      const [fullMatch, prefix, filter] = match
      if (!prefix) return
      const triggerPos = value.length - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)
      setAutocomplete({ type: prefix as AutocompleteType, filter: filter ?? "", triggerPos })
    } else {
      setAutocomplete(null)
    }
  }

  useKeyboard((e) => {
    // Handle autocomplete keyboard first
    if (autocomplete()) {
      if (e.name === "escape") {
        setAutocomplete(null)
        return
      }
      // Let autocomplete popup handle up/down/enter/tab
      if (["up", "down", "return", "tab"].includes(e.name)) {
        return
      }
      if (e.ctrl && (e.name === "p" || e.name === "n")) {
        return
      }
    }

    // Shell mode: ! at position 0 enters shell mode
    if (
      e.name === "!" &&
      inputRef?.cursorPosition === 0 &&
      inputMode() === "normal" &&
      !autocomplete()
    ) {
      setInputMode("shell")
      return
    }

    // Exit shell mode on ESC or backspace at position 0
    if (inputMode() === "shell") {
      if (e.name === "escape") {
        setInputMode("normal")
        if (inputRef) inputRef.value = ""
        return
      }
      // Backspace at position 0 or 1 exits shell mode (like deleting the implicit !)
      if (e.name === "backspace" && (inputRef?.cursorPosition ?? 0) <= 1) {
        setInputMode("normal")
        return
      }
    }

    // / at position 0 opens command autocomplete
    if (
      e.name === "/" &&
      inputRef?.cursorPosition === 0 &&
      inputMode() === "normal" &&
      !autocomplete()
    ) {
      setAutocomplete({ type: "/", filter: "", triggerPos: 0 })
      return
    }

    // Option+Backspace / Ctrl+W: delete word backward
    if ((e.meta && e.name === "backspace") || (e.ctrl && e.name === "w")) {
      deleteWordBackward()
      return
    }

    // Cmd+Backspace / Ctrl+U: delete line backward
    if ((e.super && e.name === "backspace") || (e.ctrl && e.name === "u")) {
      deleteLineBackward()
      return
    }
  })

  const handleSubmit = async (value: string) => {
    const text = value.trim()
    if (!text) return

    // Close autocomplete
    setAutocomplete(null)

    // 1. Shell mode: execute entire input as bash
    if (inputMode() === "shell") {
      const { output, truncated, savedPath } = await executeShell(text, workspace.cwd)
      let userMessage = `$ ${text}\n\n${output}`
      if (truncated) {
        userMessage += `\n\n[truncated - full output saved to ${savedPath}]`
      }

      setInputMode("normal")
      clearInput()
      props.onSubmit(userMessage)
      return
    }

    // 2. Slash command: /cmd [args]
    const parsed = parseSlashCommand(text)
    if (parsed) {
      const [cmd, args] = parsed
      clearInput()

      if (props.onSlashCommand) {
        await props.onSlashCommand(cmd, args)
      } else {
        // Default slash command handling
        const result = await executeSlashCommand(cmd, args, {
          openPalette: () => command.openPalette(),
          clearMessages: props.clearMessages ?? (() => {}),
          navigateToSessions: () => command.openPalette(),
          compactHistory: async () => {
            agentState.setError("Compact not implemented yet")
          },
          createBranch: async () => {
            // No-op in home view
          },
        })

        if (result.error) {
          agentState.setError(result.error)
        }
      }
      return
    }

    // 3. Normal message (may contain @file refs)
    const expanded = await expandFileRefs(text, workspace.cwd)
    clearInput()
    props.onSubmit(expanded)
  }

  const clearInput = () => {
    if (inputRef) inputRef.value = ""
  }

  // Focus input on mount
  onMount(() => {
    inputRef?.focus()
  })

  // Prompt symbol based on input mode
  const promptSymbol = () => (inputMode() === "shell" ? "$ " : "❯ ")

  // Input stays focused unless command palette is open
  const inputFocused = () => !command.paletteOpen()

  const contextValue: InputContextValue = {
    autocomplete,
    handleAutocompleteSelect,
    handleAutocompleteClose,
  }

  return (
    <InputContext.Provider value={contextValue}>
      {/* Children (for Autocomplete placement) */}
      {props.children}

      {/* Input row */}
      <box flexShrink={0} flexDirection="row" paddingLeft={1}>
        <text style={{ fg: inputMode() === "shell" ? theme.warning : theme.primary }}>
          {promptSymbol()}
        </text>
        <box flexGrow={1}>
          <input
            ref={(r) => (inputRef = r)}
            focused={inputFocused()}
            onInput={handleInputChange}
            onSubmit={(v) => void handleSubmit(v)}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
          />
        </box>
      </box>
    </InputContext.Provider>
  )
}

/** Autocomplete popup - place where you want it to render */
Input.Autocomplete = function InputAutocomplete() {
  const ctx = useContext(InputContext)
  if (!ctx) return null

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
