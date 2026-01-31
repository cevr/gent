/**
 * Unified input component with autocomplete support
 */

import {
  createSignal,
  createContext,
  useContext,
  onMount,
  Show,
  For,
  type JSX,
  type Accessor,
} from "solid-js"
import { Effect } from "effect"
import { SyntaxStyle, type InputRenderable } from "@opentui/core"
import type { Question } from "@gent/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { useWorkspace } from "../workspace/index"
import { useCommand } from "../command/index"
import { useClient } from "../client/index"
import { useRuntime } from "../hooks/use-runtime"
import {
  AutocompletePopup,
  type AutocompleteState,
  type AutocompleteType,
} from "./autocomplete-popup"
import { executeShell } from "../utils/shell"
import { expandFileRefs } from "../utils/file-refs"
import { executeSlashCommand, parseSlashCommand } from "../commands/slash-commands"
import { ClientError, formatError, type UiError } from "../utils/format-error"
import type { InputState, InputEvent, InputEffect } from "./input-state"

interface InputContextValue {
  autocomplete: Accessor<AutocompleteState | null>
  handleAutocompleteSelect: (value: string) => void
  handleAutocompleteClose: () => void
}

const InputContext = createContext<InputContextValue>()

// Paste placeholder management
const PASTE_THRESHOLD_LINES = 3
const PASTE_THRESHOLD_LENGTH = 150
let pasteIdCounter = 0
const pasteStore = new Map<string, string>()
const markdownSyntaxStyle = SyntaxStyle.create()

function countLines(text: string): number {
  return text.split("\n").length
}

function createPastePlaceholder(text: string): string {
  const id = `paste-${++pasteIdCounter}`
  pasteStore.set(id, text)
  const lines = countLines(text)
  return `[Pasted ~${lines} lines #${id}]`
}

function expandPastePlaceholders(text: string): string {
  return text.replace(/\[Pasted ~\d+ lines #(paste-\d+)\]/g, (_, id) => {
    const content = pasteStore.get(id)
    if (content !== undefined) {
      pasteStore.delete(id)
      return content
    }
    return _
  })
}

function isLargePaste(inserted: string): boolean {
  return countLines(inserted) >= PASTE_THRESHOLD_LINES || inserted.length >= PASTE_THRESHOLD_LENGTH
}

export interface InputProps {
  onSubmit: (content: string, mode?: "queue" | "interject") => void
  onSlashCommand?: (cmd: string, args: string) => Effect.Effect<void, UiError>
  clearMessages?: () => void
  children?: JSX.Element
  /** Input state from parent (optional - for state machine mode) */
  inputState?: InputState
  /** Callback for state changes */
  onInputEvent?: (event: InputEvent) => void
  /** Callback for effects */
  onInputEffect?: (effect: InputEffect) => void
}

export function Input(props: InputProps) {
  const { theme } = useTheme()
  const workspace = useWorkspace()
  const command = useCommand()
  const client = useClient()
  const { cast } = useRuntime(client.client.runtime)

  let inputRef: InputRenderable | null = null

  // Internal state for uncontrolled mode (when inputState prop not provided)
  const [internalMode, setInternalMode] = createSignal<"normal" | "shell">("normal")
  const [autocomplete, setAutocomplete] = createSignal<AutocompleteState | null>(null)
  let submitMode: "queue" | "interject" = "queue"
  let previousValue = ""

  // Effective mode from props or internal state
  const effectiveMode = (): "normal" | "shell" | "prompt" => {
    if (props.inputState !== undefined) {
      return props.inputState._tag
    }
    return internalMode()
  }

  // Delete word backward
  const deleteWordBackward = () => {
    if (inputRef === null) return
    const value = inputRef.value
    const cursor = inputRef.cursorOffset
    if (cursor === 0) return

    let pos = cursor - 1
    while (pos > 0 && value[pos - 1] === " ") pos--
    while (pos > 0 && value[pos - 1] !== " ") pos--

    inputRef.value = value.slice(0, pos) + value.slice(cursor)
    inputRef.cursorOffset = pos
  }

  // Delete line backward
  const deleteLineBackward = () => {
    if (inputRef === null) return
    const value = inputRef.value
    const cursor = inputRef.cursorOffset
    if (cursor === 0) return

    inputRef.value = value.slice(cursor)
    inputRef.cursorOffset = 0
  }

  // Handle autocomplete selection
  const handleAutocompleteSelect = (value: string) => {
    const state = autocomplete()
    if (state === null || inputRef === null) return

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
    inputRef.cursorOffset = beforeTrigger.length + insertion.length
    setAutocomplete(null)
  }

  // Handle autocomplete close
  const handleAutocompleteClose = () => {
    setAutocomplete(null)
    inputRef?.focus()
  }

  // Handle input changes for autocomplete detection and paste detection
  const handleInputChange = (value: string) => {
    // Detect large pastes by comparing with previous value
    // If value grew significantly, check if it's a paste
    if (value.length > previousValue.length && inputRef !== null) {
      const inserted = value.slice(previousValue.length)
      if (isLargePaste(inserted)) {
        // Replace the pasted content with a placeholder
        const placeholder = createPastePlaceholder(inserted)
        const newValue = previousValue + placeholder
        inputRef.value = newValue
        inputRef.cursorOffset = newValue.length
        previousValue = newValue
        setAutocomplete(null)
        return
      }
    }
    previousValue = value

    // No autocomplete in shell mode
    if (effectiveMode() === "shell") {
      setAutocomplete(null)
      return
    }

    // Handle / command autocomplete
    const currentAutocomplete = autocomplete()
    if (currentAutocomplete !== null && currentAutocomplete.type === "/") {
      if (value.startsWith("/")) {
        setAutocomplete({ type: "/", filter: value.slice(1), triggerPos: 0 })
      } else {
        setAutocomplete(null)
      }
      return
    }

    // Detect $ or @ triggers
    const match = value.match(/(?:^|[\s])([$@])([^\s]*)$/)
    if (match !== null) {
      const [fullMatch, prefix, filter] = match
      if (prefix === undefined || prefix.length === 0) return
      const triggerPos = value.length - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)
      setAutocomplete({ type: prefix as AutocompleteType, filter: filter ?? "", triggerPos })
    } else {
      setAutocomplete(null)
    }
  }

  useKeyboard((e) => {
    const isShiftTab =
      (e.name === "tab" && e.shift === true) ||
      e.name === "backtab" ||
      e.sequence === "\x1b[Z" ||
      e.sequence === "\x1b[1;2Z"
    if (isShiftTab) {
      const nextAgent = client.agent() === "deepwork" ? "cowork" : "deepwork"
      client.steer({ _tag: "SwitchAgent", agent: nextAgent })
      return
    }
    if (
      e.name === "return" &&
      effectiveMode() !== "prompt" &&
      effectiveMode() !== "shell" &&
      autocomplete() === null
    ) {
      submitMode = e.super === true || e.meta === true ? "interject" : "queue"
    }
    // Handle autocomplete keyboard first
    if (autocomplete() !== null) {
      if (e.name === "escape") {
        setAutocomplete(null)
        return
      }
      // Let autocomplete popup handle up/down/enter/tab
      if (["up", "down", "return", "tab"].includes(e.name)) {
        return
      }
      if (e.ctrl === true && (e.name === "p" || e.name === "n")) {
        return
      }
    }

    // Shell mode: ! at position 0 enters shell mode
    if (
      e.name === "!" &&
      inputRef?.cursorOffset === 0 &&
      effectiveMode() === "normal" &&
      autocomplete() === null
    ) {
      setInternalMode("shell")
      return
    }

    // Exit shell mode on ESC or backspace at position 0
    if (effectiveMode() === "shell") {
      if (e.name === "escape") {
        setInternalMode("normal")
        if (inputRef !== null) inputRef.value = ""
        return
      }
      // Backspace at position 0 or 1 exits shell mode (like deleting the implicit !)
      if (e.name === "backspace" && (inputRef?.cursorOffset ?? 0) <= 1) {
        setInternalMode("normal")
        return
      }
    }

    // / at position 0 opens command autocomplete
    if (
      e.name === "/" &&
      inputRef?.cursorOffset === 0 &&
      effectiveMode() === "normal" &&
      autocomplete() === null
    ) {
      setAutocomplete({ type: "/", filter: "", triggerPos: 0 })
      return
    }

    // Option+Backspace / Ctrl+W: delete word backward
    if ((e.meta === true && e.name === "backspace") || (e.ctrl === true && e.name === "w")) {
      deleteWordBackward()
      return
    }

    // Cmd+Backspace / Ctrl+U: delete line backward
    if ((e.super === true && e.name === "backspace") || (e.ctrl === true && e.name === "u")) {
      deleteLineBackward()
      return
    }
  })

  const handleSubmit = () => {
    const value = inputRef?.value ?? ""
    // Expand paste placeholders before processing
    const expanded = expandPastePlaceholders(value)
    const text = expanded.trim()
    if (text.length === 0) return

    // Close autocomplete
    setAutocomplete(null)

    // 1. Shell mode: execute entire input as bash
    if (effectiveMode() === "shell") {
      cast(
        executeShell(text, workspace.cwd).pipe(
          Effect.map(({ output, truncated, savedPath }) => {
            let userMessage = `$ ${text}\n\n${output}`
            if (truncated) {
              userMessage += `\n\n[truncated - full output saved to ${savedPath}]`
            }
            return userMessage
          }),
          Effect.tap((userMessage) =>
            Effect.sync(() => {
              setInternalMode("normal")
              clearInput()
              props.onSubmit(userMessage)
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              client.setError(formatError(error))
            }),
          ),
        ),
      )
      submitMode = "queue"
      return
    }

    // 2. Slash command: /cmd [args]
    const parsed = parseSlashCommand(text)
    if (parsed !== null) {
      const [cmd, args] = parsed
      clearInput()

      const commandEffect =
        props.onSlashCommand !== undefined
          ? props.onSlashCommand(cmd, args)
          : executeSlashCommand(cmd, args, {
              openPalette: () => command.openPalette(),
              clearMessages: props.clearMessages ?? (() => {}),
              navigateToSessions: () => command.openPalette(),
              compactHistory: Effect.fail(ClientError("Compact not implemented yet")),
              createBranch: Effect.void,
              openTree: () => {},
              openFork: () => {},
              toggleBypass: Effect.fail(ClientError("Bypass not implemented yet")),
              openPermissions: () => {},
              openAuth: () => {},
            }).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (result.error !== undefined) {
                    client.setError(result.error)
                  }
                }),
              ),
              Effect.asVoid,
            )

      cast(
        commandEffect.pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              client.setError(formatError(error))
            }),
          ),
        ),
      )
      submitMode = "queue"
      return
    }

    // 3. Normal message (may contain @file refs)
    const mode = submitMode
    submitMode = "queue"

    cast(
      expandFileRefs(text, workspace.cwd).pipe(
        Effect.tap((expanded) =>
          Effect.sync(() => {
            clearInput()
            props.onSubmit(expanded, mode)
          }),
        ),
      ),
    )
  }

  const clearInput = () => {
    if (inputRef !== null) inputRef.value = ""
    previousValue = ""
  }

  // Focus input on mount
  onMount(() => {
    inputRef?.focus()
  })

  // Prompt symbol based on input mode
  const promptSymbol = () => (effectiveMode() === "shell" ? "$ " : "❯ ")

  // Input stays focused unless command palette is open or in prompt mode
  const inputFocused = () => !command.paletteOpen() && effectiveMode() !== "prompt"

  const contextValue: InputContextValue = {
    autocomplete,
    handleAutocompleteSelect,
    handleAutocompleteClose,
  }

  // Get current prompt state if in prompt mode
  const currentPrompt = () => {
    if (props.inputState?._tag === "prompt") {
      return props.inputState.prompt
    }
    return null
  }

  // Get current question
  const currentQuestion = () => {
    const prompt = currentPrompt()
    if (prompt === null) return null
    return prompt.questions[prompt.currentIndex] ?? null
  }

  return (
    <InputContext.Provider value={contextValue}>
      {/* Children (for Autocomplete placement) */}
      {props.children}

      {/* Prompt UI when in prompt mode */}
      <Show when={currentQuestion()} keyed>
        {(question) => <PromptUI question={question} onSubmit={handlePromptSubmit} />}
      </Show>

      {/* Normal input row (hidden when in prompt mode) */}
      <Show when={effectiveMode() !== "prompt"}>
        <box flexShrink={0} flexDirection="row" paddingLeft={1}>
          <text style={{ fg: effectiveMode() === "shell" ? theme.warning : theme.primary }}>
            {promptSymbol()}
          </text>
          <box flexGrow={1}>
            <input
              ref={(r) => (inputRef = r)}
              focused={inputFocused()}
              onInput={handleInputChange}
              onSubmit={handleSubmit}
              backgroundColor="transparent"
              focusedBackgroundColor="transparent"
            />
          </box>
        </box>
      </Show>
    </InputContext.Provider>
  )

  // Handle prompt submission
  function handlePromptSubmit(selections: readonly string[]) {
    props.onInputEvent?.({ _tag: "SubmitAnswer", selections })
  }
}

/** Autocomplete popup - place where you want it to render */
Input.Autocomplete = function InputAutocomplete() {
  const ctx = useContext(InputContext)
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

// ============================================================================
// Prompt UI Component
// ============================================================================

interface PromptUIProps {
  question: Question
  onSubmit: (selections: readonly string[]) => void
}

function PromptUI(props: PromptUIProps) {
  const { theme } = useTheme()

  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [freeformText, setFreeformText] = createSignal("")
  const [focusIndex, setFocusIndex] = createSignal(0)

  const options = () => props.question.options ?? []
  const hasOptions = () => options().length > 0
  const isMultiple = () => props.question.multiple === true

  // Focus count = options + freeform input
  const focusableCount = () => options().length + 1

  useKeyboard((e) => {
    // Navigation
    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      setFocusIndex((i) => (i - 1 + focusableCount()) % focusableCount())
      return
    }
    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      setFocusIndex((i) => (i + 1) % focusableCount())
      return
    }

    // Selection with space (when focused on option)
    if (e.name === "space" && focusIndex() < options().length) {
      const opt = options()[focusIndex()]
      if (opt === undefined) return
      const label = opt.label

      if (isMultiple()) {
        // Toggle selection
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(label)) {
            next.delete(label)
          } else {
            next.add(label)
          }
          return next
        })
      } else {
        // Single select - replace
        setSelected(new Set([label]))
      }
      return
    }

    // Submit with Enter
    if (e.name === "return") {
      submitAnswer()
      return
    }
  })

  const submitAnswer = () => {
    const selections: string[] = [...selected()]
    const freeform = freeformText().trim()
    if (freeform.length > 0) {
      selections.push(freeform)
    }
    // If no selections and no freeform, use "Other" as default
    if (selections.length === 0) {
      selections.push("Other")
    }
    props.onSubmit(selections)
  }

  const isSelected = (label: string) => selected().has(label)
  const isFocused = (index: number) => focusIndex() === index
  const isFreeformFocused = () => focusIndex() === options().length

  return (
    <box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      {/* Header if present */}
      <Show when={props.question.header !== undefined && props.question.header.length > 0}>
        <text style={{ fg: theme.textMuted }}>
          <b>{props.question.header}</b>
        </text>
      </Show>

      {/* Question */}
      <text style={{ fg: theme.text }}>{props.question.question}</text>

      {/* Markdown body */}
      <Show when={props.question.markdown} keyed>
        {(markdown) => (
          <box marginTop={1} paddingRight={1}>
            <markdown content={markdown} syntaxStyle={markdownSyntaxStyle} />
          </box>
        )}
      </Show>

      {/* Options */}
      <Show when={hasOptions()}>
        <box flexDirection="column" marginTop={1}>
          <For each={options()}>
            {(opt, idx) => (
              <box flexDirection="row">
                <text style={{ fg: isFocused(idx()) ? theme.primary : theme.text }}>
                  {isFocused(idx()) ? "❯ " : "  "}
                  {isMultiple()
                    ? isSelected(opt.label)
                      ? "[x] "
                      : "[ ] "
                    : isSelected(opt.label)
                      ? "(•) "
                      : "( ) "}
                  {opt.label}
                </text>
                <Show when={opt.description !== undefined && opt.description.length > 0}>
                  <text style={{ fg: theme.textMuted }}> - {opt.description}</text>
                </Show>
              </box>
            )}
          </For>
        </box>
      </Show>

      {/* Freeform input */}
      <box flexDirection="row" marginTop={1}>
        <text style={{ fg: isFreeformFocused() ? theme.primary : theme.textMuted }}>
          {isFreeformFocused() ? "❯ " : "  "}Other:{" "}
        </text>
        <box flexGrow={1}>
          <input
            focused={isFreeformFocused()}
            onInput={setFreeformText}
            onSubmit={submitAnswer}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
          />
        </box>
      </box>

      {/* Hint */}
      <text style={{ fg: theme.textMuted, marginTop: 1 }}>
        {isMultiple()
          ? "↑↓ navigate • space select • enter submit"
          : "↑↓ navigate • space/enter select"}
      </text>
    </box>
  )
}
