import { createEffect, onCleanup, onMount, type Accessor } from "solid-js"
import { Effect } from "effect"
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { useCommand } from "../command/index"
import { useClient } from "../client/index"
import { useEnv } from "../env/context"
import { useRuntime } from "../hooks/use-runtime"
import { usePromptHistory } from "../hooks/use-prompt-history"
import { useScopedKeyboard } from "../keyboard/context"
import { useWorkspace } from "../workspace/index"
import { useSessionController } from "../routes/session-controller"
import { executeSlashCommand, parseSlashCommand } from "../commands/slash-commands"
import { ClientError, formatError } from "../utils/format-error"
import { openExternalEditor, resolveEditor } from "../utils/external-editor"
import { expandFileRefs } from "../utils/file-refs"
import { executeShell } from "../utils/shell"
import type { AutocompleteState } from "./composer-interaction-state"
import type { ApprovalResult } from "@gent/core/domain/event.js"
import { useExtensionUI } from "../extensions/context"

const PASTE_THRESHOLD_LINES = 3
const PASTE_THRESHOLD_LENGTH = 150

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

export interface ComposerController {
  readonly autocomplete: Accessor<AutocompleteState | null>
  readonly mode: Accessor<"editing" | "shell" | "interaction">
  readonly promptSymbol: Accessor<string>
  readonly inputFocused: Accessor<boolean>
  readonly attachTextarea: (renderable: TextareaRenderable | null) => void
  readonly handleTextareaKeyDown: (event: {
    name?: string
    shift?: boolean
    ctrl?: boolean
    meta?: boolean
    super?: boolean
    preventDefault: () => void
  }) => void
  readonly handleSubmitFromTextarea: () => void
  readonly resolveInteraction: (result: ApprovalResult) => void
  readonly cancelInteraction: () => void
  readonly handleAutocompleteSelect: (value: string) => void
  readonly handleAutocompleteClose: () => void
}

export function useComposerController(): ComposerController {
  const sc = useSessionController()
  const workspace = useWorkspace()
  const { theme } = useTheme()
  const command = useCommand()
  const client = useClient()
  const renderer = useRenderer()
  const env = useEnv()
  const { cast } = useRuntime()
  const history = usePromptHistory()
  const paste = createPasteManager()
  const extensionUI = useExtensionUI()

  let inputRef: TextareaRenderable | null = null
  let submitMode: "queue" | "interject" = "queue"

  // Token highlighting — colors autocomplete-resolved tokens with theme.primary
  const tokenStyle = SyntaxStyle.create()
  let tokenStyleId: number | undefined
  const resolvedTokens: Array<string> = []

  const ensureStyleId = () => {
    if (tokenStyleId !== undefined) return tokenStyleId
    tokenStyleId = tokenStyle.registerStyle("token", { fg: theme.primary })
    return tokenStyleId
  }

  const applyTokenHighlights = () => {
    if (inputRef === null) return
    inputRef.clearAllHighlights()
    if (resolvedTokens.length === 0) return
    const text = inputRef.plainText
    const styleId = ensureStyleId()
    for (const tokenText of resolvedTokens) {
      let searchFrom = 0
      while (true) {
        const idx = text.indexOf(tokenText, searchFrom)
        if (idx === -1) break
        inputRef.addHighlightByCharRange({
          start: idx,
          end: idx + tokenText.length,
          styleId,
        })
        searchFrom = idx + tokenText.length
      }
    }
  }

  const autocomplete = () => sc.interactionState().autocomplete
  const effectiveMode = (): "editing" | "shell" | "interaction" =>
    sc.composerState()?._tag === "interaction" ? "interaction" : sc.interactionState().mode

  const clearInput = () => {
    if (inputRef !== null) inputRef.setText("")
    resolvedTokens.length = 0
    sc.onComposerInteraction({ _tag: "ClearDraft" })
  }

  const clearAutocomplete = () => {
    sc.onComposerInteraction({ _tag: "CloseAutocomplete" })
  }

  const focusTextarea = () => {
    inputRef?.focus()
  }

  const handleAutocompleteSelect = (value: string) => {
    const state = autocomplete()
    if (state === null || inputRef === null) return

    const beforeTrigger = inputRef.plainText.slice(0, state.triggerPos)
    const contribution = extensionUI.autocompleteItems().find((c) => c.prefix === state.type)
    const insertion = contribution?.formatInsertion
      ? contribution.formatInsertion(value)
      : `${state.type}${value} `

    // Track the inserted token for highlighting (trim trailing space)
    const tokenText = insertion.trimEnd()
    if (!resolvedTokens.includes(tokenText)) {
      resolvedTokens.push(tokenText)
    }

    const nextValue = beforeTrigger + insertion
    inputRef.replaceText(nextValue)
    inputRef.cursorOffset = nextValue.length
    sc.onComposerInteraction({ _tag: "RestoreDraft", text: nextValue })
    applyTokenHighlights()
    focusTextarea()
  }

  const handleAutocompleteClose = () => {
    clearAutocomplete()
    focusTextarea()
  }

  const handleContentChange = () => {
    const value = inputRef?.plainText ?? ""
    const previousValue = sc.interactionState().draft
    if (value.length > previousValue.length && inputRef !== null) {
      const inserted = value.slice(previousValue.length)
      if (isLargePaste(inserted)) {
        const placeholder = paste.createPlaceholder(inserted)
        const nextValue = previousValue + placeholder
        inputRef.replaceText(nextValue)
        inputRef.cursorOffset = nextValue.length
        sc.onComposerInteraction({ _tag: "RestoreDraft", text: nextValue })
        return
      }
    }
    sc.onComposerInteraction({ _tag: "DraftChanged", text: value })

    // Prune tokens that are no longer in the text, then re-apply highlights
    for (let i = resolvedTokens.length - 1; i >= 0; i--) {
      if (!value.includes(resolvedTokens[i] ?? "")) resolvedTokens.splice(i, 1)
    }
    applyTokenHighlights()
  }

  const submitShellCommand = (text: string) => {
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
            sc.onComposerInteraction({ _tag: "ExitShell" })
            clearInput()
            sc.onSubmit(userMessage)
          }),
        ),
        Effect.catchEager((error: unknown) =>
          Effect.sync(() => {
            const message =
              error !== null && typeof error === "object" && "message" in error
                ? String((error as { message: unknown }).message)
                : String(error)
            client.setError(message)
          }),
        ),
      ),
    )
  }

  const submitSlashCommand = (text: string) => {
    const parsed = parseSlashCommand(text)
    if (parsed === null) return false

    const [cmd, args] = parsed
    client.log.info("slash-command", { cmd, hasCustomHandler: sc.onSlashCommand !== undefined })
    clearInput()

    const commandEffect =
      sc.onSlashCommand !== undefined
        ? sc.onSlashCommand(cmd, args)
        : executeSlashCommand(cmd, args, {
            openPalette: () => command.openPalette(),
            clearMessages: sc.clearMessages ?? (() => {}),
            navigateToSessions: () => command.openPalette(),
            createBranch: Effect.void,
            openTree: () => {},
            openFork: () => {},
            setReasoningLevel: () => Effect.fail(ClientError("Think not available here")),
            openPermissions: () => {},
            openAuth: () => {},
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
    return true
  }

  const submitMessage = (text: string, mode: "queue" | "interject") => {
    client.log.info("composer.submit.requested", { contentLength: text.length, mode })
    history.add(text)
    cast(
      expandFileRefs(text, workspace.cwd).pipe(
        Effect.tap((expanded) =>
          Effect.sync(() => {
            clearInput()
            sc.onSubmit(expanded, mode)
          }),
        ),
      ),
    )
  }

  const handleSubmit = () => {
    const expandedValue = paste.expandPlaceholders(inputRef?.plainText ?? "")
    const text = expandedValue.trim()
    if (text.length === 0) return

    clearAutocomplete()
    history.reset()

    if (effectiveMode() === "shell") {
      submitShellCommand(text)
      submitMode = "queue"
      return
    }

    if (submitSlashCommand(text)) {
      submitMode = "queue"
      return
    }

    const mode = submitMode
    submitMode = "queue"
    submitMessage(text, mode)
  }

  const handleExternalEditorKey = (event: {
    readonly ctrl?: boolean
    readonly name?: string
  }): boolean => {
    if (!(event.ctrl === true && event.name === "g")) return false

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
          sc.onComposerInteraction({ _tag: "RestoreDraft", text: result.content })
          return
        }
        if (result._tag === "error") {
          client.setError(result.message)
        }
      })
      .catch((error: unknown) => {
        client.setError(`Editor error: ${error}`)
      })

    return true
  }

  const handleAutocompleteKey = (event: {
    readonly ctrl?: boolean
    readonly name?: string
  }): boolean | undefined => {
    if (autocomplete() === null) return undefined
    if (event.name === "escape") {
      clearAutocomplete()
      return true
    }
    if (["up", "down", "return", "tab"].includes(event.name ?? "")) {
      return false
    }
    if (event.ctrl === true && (event.name === "p" || event.name === "n")) {
      return false
    }
    return undefined
  }

  const handleShellModeKey = (event: { readonly name?: string }): boolean => {
    if (
      event.name === "!" &&
      inputRef?.cursorOffset === 0 &&
      effectiveMode() === "editing" &&
      autocomplete() === null
    ) {
      sc.onComposerInteraction({ _tag: "EnterShell" })
      return true
    }

    if (effectiveMode() !== "shell") return false

    if (event.name === "escape") {
      sc.onComposerInteraction({ _tag: "ExitShell" })
      clearAutocomplete()
      clearInput()
      return true
    }

    if (event.name === "backspace" && (inputRef?.cursorOffset ?? 0) <= 1) {
      sc.onComposerInteraction({ _tag: "ExitShell" })
      clearAutocomplete()
      return true
    }

    return false
  }

  const handleStartTriggerKey = (event: { readonly name?: string }): boolean => {
    if (
      event.name === undefined ||
      event.name.length !== 1 ||
      inputRef?.cursorOffset !== 0 ||
      effectiveMode() !== "editing" ||
      autocomplete() !== null
    ) {
      return false
    }

    // Check if any start-trigger contribution matches this key
    const match = extensionUI
      .autocompleteItems()
      .find((c) => c.trigger === "start" && c.prefix === event.name)
    if (match === undefined) return false

    sc.onComposerInteraction({
      _tag: "OpenAutocomplete",
      autocomplete: { type: match.prefix, filter: "", triggerPos: 0 },
    })
    return true
  }

  const handlePromptHistoryKey = (event: {
    readonly ctrl?: boolean
    readonly meta?: boolean
    readonly option?: boolean
    readonly shift?: boolean
    readonly name?: string
  }): boolean => {
    if (
      (event.name !== "up" && event.name !== "down") ||
      effectiveMode() !== "editing" ||
      autocomplete() !== null ||
      inputRef === null ||
      event.ctrl === true ||
      event.meta === true ||
      event.option === true ||
      event.shift === true
    ) {
      return false
    }

    const result = history.navigate(
      event.name,
      inputRef.plainText,
      inputRef.cursorOffset,
      inputRef.plainText.length,
    )
    if (!result.handled || result.text === undefined) return false

    inputRef.replaceText(result.text)
    inputRef.cursorOffset = result.cursor === "start" ? 0 : result.text.length
    sc.onComposerInteraction({ _tag: "RestoreDraft", text: result.text })
    return true
  }

  useScopedKeyboard((event) => {
    if (sc.promptSearchOpen() === true) return false

    // Shift+Tab toggles auto mode (opens goal overlay when inactive, cancels when active)
    const isShiftTab =
      (event.name === "tab" && event.shift === true) ||
      event.name === "backtab" ||
      event.sequence === "\x1b[Z" ||
      event.sequence === "\x1b[1;2Z"
    if (isShiftTab) {
      command.trigger("auto.toggle")
      return true
    }

    if (handleExternalEditorKey(event)) return true

    if ((event.meta === true || event.super === true) && event.name === "up") {
      sc.onRestoreQueue()
      return true
    }

    const autocompleteResult = handleAutocompleteKey(event)
    if (autocompleteResult !== undefined) return autocompleteResult
    if (handleShellModeKey(event)) return true
    if (handleStartTriggerKey(event)) return true
    if (handlePromptHistoryKey(event)) return true
    return false
  })

  /** Called by textarea onSubmit (keybinding: bare return → submit action). */
  const handleSubmitFromTextarea = () => {
    if (sc.promptSearchOpen() === true || effectiveMode() === "interaction") return
    if (autocomplete() !== null) return
    submitMode = "queue"
    handleSubmit()
  }

  /**
   * Handles only meta/super+Enter for interject mode.
   * All other Enter routing goes through textarea keybindings:
   *   bare return → submit (→ handleSubmitFromTextarea)
   *   shift/ctrl+return → newline
   */
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

    if (sc.promptSearchOpen() === true || effectiveMode() === "interaction") {
      event.preventDefault()
      return
    }

    // Meta/Super+Enter = interject (bypasses keybindings)
    if (event.meta === true || event.super === true) {
      event.preventDefault()
      if (autocomplete() !== null) return
      submitMode = "interject"
      handleSubmit()
      return
    }

    // Autocomplete open: swallow Enter so it doesn't submit
    if (autocomplete() !== null) {
      event.preventDefault()
      return
    }

    // All other Enter variants (bare, shift, ctrl) fall through to textarea keybindings
  }

  createEffect(() => {
    const draft = sc.interactionState().draft
    if (inputRef === null || inputRef.plainText === draft) return
    inputRef.replaceText(draft)
    inputRef.cursorOffset = draft.length
    clearAutocomplete()
    focusTextarea()
  })

  onMount(() => {
    focusTextarea()
  })

  onCleanup(() => {
    paste.clear()
    tokenStyle.destroy()
  })

  return {
    autocomplete,
    mode: effectiveMode,
    promptSymbol: () => (effectiveMode() === "shell" ? "$ " : "❯ "),
    inputFocused: () =>
      !command.paletteOpen() && sc.promptSearchOpen() !== true && effectiveMode() !== "interaction",
    attachTextarea: (renderable) => {
      inputRef = renderable
      if (renderable !== null) {
        renderable.onContentChange = handleContentChange
        renderable.syntaxStyle = tokenStyle
      }
    },
    handleTextareaKeyDown,
    handleSubmitFromTextarea,
    resolveInteraction: (result: ApprovalResult) => {
      sc.dispatchComposer({ _tag: "ResolveInteraction", result })
    },
    cancelInteraction: () => {
      sc.dispatchComposer({ _tag: "CancelInteraction" })
    },
    handleAutocompleteSelect,
    handleAutocompleteClose,
  }
}
