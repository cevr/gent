/**
 * Unified input component with autocomplete support
 */

import {
  createEffect,
  createSignal,
  createContext,
  useContext,
  onMount,
  onCleanup,
  Show,
  For,
  type JSX,
  type Accessor,
} from "solid-js"
import { Effect } from "effect"
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import type { Question } from "@gent/core/domain/event.js"
import { useRenderer } from "@opentui/solid"
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
import { tuiEvent } from "../utils/unified-tracer"
import { openExternalEditor, resolveEditor } from "../utils/external-editor"
import { useEnv } from "../env/context"
import { expandSkillMentions } from "../utils/skill-expansion"
import { usePromptHistory } from "../hooks/use-prompt-history"
import { useSkills } from "../hooks/use-skills"
import type { InputState, InputEvent, InputEffect } from "./input-state"
import { useScopedKeyboard } from "../keyboard/context"

interface InputContextValue {
  autocomplete: Accessor<AutocompleteState | null>
  handleAutocompleteSelect: (value: string) => void
  handleAutocompleteClose: () => void
}

const InputContext = createContext<InputContextValue>()

// Paste placeholder management
const PASTE_THRESHOLD_LINES = 3
const PASTE_THRESHOLD_LENGTH = 150
const markdownSyntaxStyle = SyntaxStyle.create()

function countLines(text: string): number {
  return text.split("\n").length
}

function isLargePaste(inserted: string): boolean {
  return countLines(inserted) >= PASTE_THRESHOLD_LINES || inserted.length >= PASTE_THRESHOLD_LENGTH
}

function createPasteManager() {
  let idCounter = 0
  const store = new Map<string, string>()

  return {
    createPlaceholder(text: string): string {
      const id = `paste-${++idCounter}`
      store.set(id, text)
      const lines = countLines(text)
      return `[Pasted ~${lines} lines #${id}]`
    },
    expandPlaceholders(text: string): string {
      return text.replace(/\[Pasted ~\d+ lines #(paste-\d+)\]/g, (match, id) => {
        const content = store.get(id)
        if (content !== undefined) {
          store.delete(id)
          return content
        }
        return match
      })
    },
    clear() {
      store.clear()
    },
  }
}

export interface InputProps {
  onSubmit: (content: string, mode?: "queue" | "interject") => void
  onSlashCommand?: (cmd: string, args: string) => Effect.Effect<void, UiError>
  clearMessages?: () => void
  onRestoreQueue?: () => void
  suspended?: boolean
  onTextChange?: (text: string) => void
  restoreTextRequest?: { token: number; text: string }
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
  const renderer = useRenderer()
  const env = useEnv()
  const { cast } = useRuntime(client.client.services)
  const paste = createPasteManager()
  const history = usePromptHistory()
  const skillsHook = useSkills()

  let inputRef: TextareaRenderable | null = null

  // Internal state for uncontrolled mode (when inputState prop not provided)
  type InternalState =
    | { _tag: "normal"; autocomplete: AutocompleteState | null }
    | { _tag: "shell" }
  const [internalState, setInternalState] = createSignal<InternalState>({
    _tag: "normal",
    autocomplete: null,
  })
  const autocomplete = () => {
    const current = internalState()
    return current._tag === "normal" ? current.autocomplete : null
  }
  const setAutocomplete = (next: AutocompleteState | null) => {
    setInternalState((current) =>
      current._tag === "normal" ? { ...current, autocomplete: next } : current,
    )
  }
  let submitMode: "queue" | "interject" = "queue"
  let previousValue = ""

  // Effective mode from props or internal state
  const effectiveMode = (): "normal" | "shell" | "prompt" => {
    if (props.inputState !== undefined) {
      return props.inputState._tag
    }
    return internalState()._tag
  }

  // Handle autocomplete selection
  const handleAutocompleteSelect = (value: string) => {
    const state = autocomplete()
    if (state === null || inputRef === null) return

    const currentValue = inputRef.plainText
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

    const newValue = beforeTrigger + insertion
    inputRef.replaceText(newValue)
    inputRef.cursorOffset = newValue.length
    setAutocomplete(null)
  }

  // Handle autocomplete close
  const handleAutocompleteClose = () => {
    setAutocomplete(null)
    inputRef?.focus()
  }

  // Handle content changes for autocomplete detection and paste detection
  const handleContentChange = () => {
    const value = inputRef?.plainText ?? ""
    // Detect large pastes by comparing with previous value
    // If value grew significantly, check if it's a paste
    if (value.length > previousValue.length && inputRef !== null) {
      const inserted = value.slice(previousValue.length)
      if (isLargePaste(inserted)) {
        // Replace the pasted content with a placeholder
        const placeholder = paste.createPlaceholder(inserted)
        const newValue = previousValue + placeholder
        inputRef.replaceText(newValue)
        inputRef.cursorOffset = newValue.length
        previousValue = newValue
        setAutocomplete(null)
        return
      }
    }
    previousValue = value
    props.onTextChange?.(value)

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

  const handleTextareaKeyDown = (event: {
    name?: string
    shift?: boolean
    ctrl?: boolean
    meta?: boolean
    super?: boolean
    preventDefault: () => void
  }) => {
    const isEnterKey = event.name === "return" || event.name === "linefeed"
    if (!isEnterKey) return

    if (props.suspended === true || effectiveMode() === "prompt") {
      event.preventDefault()
      return
    }

    if (event.shift === true || event.ctrl === true) return

    if (autocomplete() !== null) {
      event.preventDefault()
      return
    }

    event.preventDefault()
    submitMode = event.super === true || event.meta === true ? "interject" : "queue"
    handleSubmit()
  }

  useScopedKeyboard((e) => {
    if (props.suspended === true) return false

    const isShiftTab =
      (e.name === "tab" && e.shift === true) ||
      e.name === "backtab" ||
      e.sequence === "\x1b[Z" ||
      e.sequence === "\x1b[1;2Z"
    if (isShiftTab) {
      const nextAgent = client.agent() === "deepwork" ? "cowork" : "deepwork"
      client.steer({ _tag: "SwitchAgent", agent: nextAgent })
      return true
    }

    // Ctrl+G: open external editor
    if (e.ctrl === true && e.name === "g") {
      const currentContent = inputRef?.plainText ?? ""
      const editor = resolveEditor(env.visual, env.editor)
      openExternalEditor(
        currentContent,
        () => renderer.suspend(),
        () => renderer.resume(),
        editor,
      )
        .then((result) => {
          if (result._tag === "applied" && inputRef !== null) {
            inputRef.replaceText(result.content)
            inputRef.cursorOffset = result.content.length
            previousValue = result.content
          } else if (result._tag === "error") {
            client.setError(result.message)
          }
        })
        .catch((err: unknown) => {
          client.setError(`Editor error: ${err}`)
        })
      return true
    }

    if ((e.meta === true || e.super === true) && e.name === "up") {
      props.onRestoreQueue?.()
      return true
    }

    // Handle autocomplete keyboard first
    if (autocomplete() !== null) {
      if (e.name === "escape") {
        setAutocomplete(null)
        return true
      }
      // Let autocomplete popup handle up/down/enter/tab
      if (["up", "down", "return", "tab"].includes(e.name)) {
        return false
      }
      if (e.ctrl === true && (e.name === "p" || e.name === "n")) {
        return false
      }
    }

    // Shell mode: ! at position 0 enters shell mode
    if (
      e.name === "!" &&
      inputRef?.cursorOffset === 0 &&
      effectiveMode() === "normal" &&
      autocomplete() === null
    ) {
      setInternalState({ _tag: "shell" })
      return true
    }

    // Exit shell mode on ESC or backspace at position 0
    if (effectiveMode() === "shell") {
      if (e.name === "escape") {
        setInternalState({ _tag: "normal", autocomplete: null })
        if (inputRef !== null) inputRef.setText("")
        return true
      }
      // Backspace at position 0 or 1 exits shell mode (like deleting the implicit !)
      if (e.name === "backspace" && (inputRef?.cursorOffset ?? 0) <= 1) {
        setInternalState({ _tag: "normal", autocomplete: null })
        return true
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
      return true
    }

    // Prompt history: up/down at cursor boundaries (normal mode only)
    if (
      (e.name === "up" || e.name === "down") &&
      effectiveMode() === "normal" &&
      autocomplete() === null &&
      inputRef !== null &&
      !e.ctrl &&
      !e.meta &&
      !e.option &&
      !e.shift
    ) {
      const cursorPos = inputRef.cursorOffset
      const textLength = inputRef.plainText.length
      const result = history.navigate(e.name, inputRef.plainText, cursorPos, textLength)
      if (result.handled && result.text !== undefined) {
        inputRef.replaceText(result.text)
        inputRef.cursorOffset = result.cursor === "start" ? 0 : result.text.length
        previousValue = result.text
        return true
      }
    }
    return false
  })

  const handleSubmit = () => {
    const value = inputRef?.plainText ?? ""
    // Expand paste placeholders before processing
    const expanded = paste.expandPlaceholders(value)
    const text = expanded.trim()
    if (text.length === 0) return

    // Close autocomplete
    setAutocomplete(null)
    history.reset()

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
              setInternalState({ _tag: "normal", autocomplete: null })
              clearInput()
              props.onSubmit(userMessage)
            }),
          ),
          Effect.catchEager((error: unknown) =>
            Effect.sync(() => {
              const msg =
                error !== null && typeof error === "object" && "message" in error
                  ? String((error as { message: unknown }).message)
                  : String(error)
              client.setError(msg)
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
      tuiEvent("slash-command", { cmd, hasCustomHandler: props.onSlashCommand !== undefined })
      clearInput()

      const commandEffect =
        props.onSlashCommand !== undefined
          ? props.onSlashCommand(cmd, args)
          : executeSlashCommand(cmd, args, {
              openPalette: () => command.openPalette(),
              clearMessages: props.clearMessages ?? (() => {}),
              navigateToSessions: () => command.openPalette(),
              createBranch: Effect.void,
              openTree: () => {},
              openFork: () => {},
              toggleBypass: Effect.fail(ClientError("Bypass not implemented yet")),
              setReasoningLevel: () => Effect.fail(ClientError("Think not available here")),
              openPermissions: () => {},
              openAuth: () => {},
              sendMessage: (content: string) => client.sendMessage(content),
              newSession: () => Effect.fail(ClientError("New session not available here")),
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
          Effect.catchEager((error) =>
            Effect.sync(() => {
              client.setError(formatError(error))
            }),
          ),
        ),
      )
      submitMode = "queue"
      return
    }

    // 3. Normal message (may contain @file refs and $skill mentions)
    history.add(text)
    const mode = submitMode
    submitMode = "queue"

    cast(
      expandFileRefs(text, workspace.cwd).pipe(
        Effect.map((expanded) => {
          // Expand $skill-name tokens with preloaded skill content
          if (expanded.includes("$")) {
            const skills = skillsHook.skills()
            return expandSkillMentions(
              expanded,
              (name) => skillsHook.getContent(name),
              (name) => skills.find((s) => s.name === name)?.filePath ?? null,
            )
          }
          return expanded
        }),
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
    if (inputRef !== null) inputRef.setText("")
    previousValue = ""
    props.onTextChange?.("")
  }

  createEffect(() => {
    const request = props.restoreTextRequest
    if (request === undefined || inputRef === null) return
    inputRef.replaceText(request.text)
    inputRef.cursorOffset = request.text.length
    previousValue = request.text
    props.onTextChange?.(request.text)
    setAutocomplete(null)
    inputRef.focus()
  })

  // Focus input on mount
  onMount(() => {
    inputRef?.focus()
  })

  onCleanup(() => {
    paste.clear()
  })

  // Prompt symbol based on input mode
  const promptSymbol = () => (effectiveMode() === "shell" ? "$ " : "❯ ")

  // Input stays focused unless command palette is open or in prompt mode
  const inputFocused = () =>
    !command.paletteOpen() && props.suspended !== true && effectiveMode() !== "prompt"

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
        <box flexShrink={0} flexDirection="row">
          <text style={{ fg: effectiveMode() === "shell" ? theme.warning : theme.primary }}>
            {promptSymbol()}
          </text>
          <box flexGrow={1}>
            <textarea
              ref={(r) => {
                inputRef = r
                if (r !== null) {
                  r.onContentChange = handleContentChange
                }
              }}
              focused={inputFocused()}
              onKeyDown={handleTextareaKeyDown}
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

  useScopedKeyboard((e) => {
    // Navigation
    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      setFocusIndex((i) => (i - 1 + focusableCount()) % focusableCount())
      return true
    }
    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      setFocusIndex((i) => (i + 1) % focusableCount())
      return true
    }

    // Selection with space (when focused on option)
    if (e.name === "space" && focusIndex() < options().length) {
      const opt = options()[focusIndex()]
      if (opt === undefined) return true
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
      return true
    }

    // Submit with Enter
    if (e.name === "return") {
      submitAnswer()
      return true
    }
    return false
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
            <markdown syntaxStyle={markdownSyntaxStyle} content={markdown} />
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
