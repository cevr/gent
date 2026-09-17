import { createEffect, onCleanup, onMount, type Accessor } from "solid-js"
import { Effect, Option, Schema } from "effect"
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { useCommand } from "../command/context"
import { useClient } from "../client/index"
import { useEnv } from "../env/context"
import { useRuntime } from "../hooks/use-runtime"
import { usePromptHistory } from "../hooks/use-prompt-history"
import { useScopedKeyboard } from "../keyboard/context"
import { useWorkspace } from "../workspace/context"
import { useSessionController } from "../routes/session-controller"
import { isSlashCommandName, parseSlashCommand } from "../commands/slash-commands"
import { openExternalEditor, resolveEditor } from "../utils/external-editor"
import { expandFileRefs } from "../utils/file-refs"
import { executeShell } from "../utils/shell"
import { ComposerInteractionEvent, type AutocompleteState } from "./composer-interaction-state"
import { ComposerEvent } from "./composer-state"
import type { ApprovalResult } from "@gent/core/protocol"
import { useExtensionUI } from "../extensions/context"

const PASTE_THRESHOLD_LINES = 3
const PASTE_THRESHOLD_LENGTH = 150

export function countLines(text: string): number {
  return text.split("\n").length
}

export function isLargePaste(inserted: string): boolean {
  return countLines(inserted) >= PASTE_THRESHOLD_LINES || inserted.length >= PASTE_THRESHOLD_LENGTH
}

/** Per-controller: each composer owns its placeholder ids and store. */
export function createPasteManager() {
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
        const content = Option.fromNullishOr(store.get(id))
        if (Option.isSome(content)) {
          store.delete(id)
          return content.value
        }
        return match
      })
    },
    clear() {
      store.clear()
    },
  }
}

interface ComposerController {
  // eslint-disable-next-line effect/noNullish -- Solid autocomplete accessors use null while closed.
  readonly autocomplete: Accessor<AutocompleteState | null>
  readonly mode: Accessor<"editing" | "shell" | "interaction">
  readonly inputFocused: Accessor<boolean>
  // eslint-disable-next-line effect/noNullish -- OpenTUI refs pass null before attachment and on cleanup.
  readonly attachTextarea: (renderable: TextareaRenderable | null) => void
  readonly handleTextareaKeyDown: (event: {
    // eslint-disable-next-line effect/noNullish -- OpenTUI keyboard events omit these modifier fields.
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
  /** Enter on a row: completes, and dispatches when the row names a command. */
  readonly handleAutocompleteSelect: (value: string) => void
  /** Tab on a row: completes only, never dispatches. */
  readonly handleAutocompleteComplete: (value: string) => void
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

  let inputRef = Option.none<TextareaRenderable>()
  let submitMode: "queue" | "interject" = "queue"

  // Token highlighting — colors autocomplete-resolved tokens with theme.primary
  const tokenStyle = SyntaxStyle.create()
  let tokenStyleId = Option.none<number>()
  const resolvedTokens: Array<string> = []

  const ensureStyleId = () => {
    if (Option.isSome(tokenStyleId)) return tokenStyleId.value
    const styleId = tokenStyle.registerStyle("token", { fg: theme.primary })
    tokenStyleId = Option.some(styleId)
    return styleId
  }

  const applyTokenHighlights = () => {
    if (Option.isNone(inputRef)) return
    inputRef.value.clearAllHighlights()
    if (resolvedTokens.length === 0) return
    const text = inputRef.value.plainText
    const styleId = ensureStyleId()
    for (const tokenText of resolvedTokens) {
      let searchFrom = 0
      while (true) {
        const idx = text.indexOf(tokenText, searchFrom)
        if (idx === -1) break
        inputRef.value.addHighlightByCharRange({
          start: idx,
          end: idx + tokenText.length,
          styleId,
        })
        searchFrom = idx + tokenText.length
      }
    }
  }

  const autocompleteOption = () => sc.interactionState().autocomplete
  const autocomplete = () => Option.getOrNull(autocompleteOption())
  const effectiveMode = (): "editing" | "shell" | "interaction" => {
    if (sc.composerState()._tag === "interaction") return "interaction"
    return sc.interactionState().mode
  }

  const clearInput = () => {
    if (Option.isSome(inputRef)) inputRef.value.setText("")
    resolvedTokens.length = 0
    sc.onComposerInteraction(ComposerInteractionEvent.cases.ClearDraft.make({}))
  }

  const clearAutocomplete = () => {
    sc.onComposerInteraction(ComposerInteractionEvent.cases.CloseAutocomplete.make({}))
  }

  const focusTextarea = () => {
    if (Option.isSome(inputRef)) inputRef.value.focus()
  }

  /**
   * Completes the open popup's row into the draft.
   *
   * Two keys reach this: enter and tab. They agree on everything the reader
   * can see — the same row, the same text, the same trailing space — and
   * disagree on one thing only, which is whether naming a slash command is
   * also a reason to run it. `dispatch` is that disagreement, and it is the
   * whole reason the two keys are not one function.
   *
   * Enter completes and runs, because a reader who pressed enter on `/agents`
   * asked for the agents pane. Tab completes and stops, because tab is how a
   * reader builds `/model sonnet`: it puts `/model ` in the draft and hands
   * the caret back so the argument can be typed. A tab that dispatched would
   * leave no way to reach an argument at all.
   */
  const completeAutocomplete = (value: string, dispatch: boolean) => {
    const state = autocompleteOption()
    if (Option.isNone(state) || Option.isNone(inputRef)) return

    const contribution = Option.fromNullishOr(
      extensionUI.autocompleteItems().find((c) => c.prefix === state.value.type),
    )
    // Notify contribution of selection (frecency tracking, etc.)
    if (Option.isSome(contribution)) {
      const onSelect = Option.fromNullishOr(contribution.value.onSelect)
      if (Option.isSome(onSelect)) onSelect.value(value, state.value.filter)
    }
    const beforeTrigger = inputRef.value.plainText.slice(0, state.value.triggerPos)
    let insertion = `${state.value.type}${value} `
    const formatInsertion = Option.flatMap(contribution, (c) =>
      Option.fromNullishOr(c.formatInsertion),
    )
    if (Option.isSome(formatInsertion)) insertion = formatInsertion.value(value)

    // Completing a slash command name runs it, rather than parking it in the
    // composer behind a second Enter. Every slash command treats an empty arg
    // as "open my picker" or "show usage", so the name alone is a full
    // invocation. Only the bare `/name` completion dispatches: a typed
    // argument (`/model sonnet`) leaves `beforeTrigger` non-empty or is
    // carried by the submit path instead. An extension that supplies
    // `formatInsertion` for `/` keeps its own insertion semantics.
    if (
      dispatch &&
      state.value.type === "/" &&
      Option.isNone(formatInsertion) &&
      beforeTrigger.length === 0 &&
      isSlashCommandName(value, command.commands())
    ) {
      clearAutocomplete()
      submitSlashCommand(`/${value}`)
      return
    }

    // Track the inserted token for highlighting (trim trailing space)
    const tokenText = insertion.trimEnd()
    if (!resolvedTokens.includes(tokenText)) {
      resolvedTokens.push(tokenText)
    }

    const nextValue = beforeTrigger + insertion
    inputRef.value.replaceText(nextValue)
    inputRef.value.cursorOffset = nextValue.length
    sc.onComposerInteraction(ComposerInteractionEvent.cases.RestoreDraft.make({ text: nextValue }))
    applyTokenHighlights()
    focusTextarea()
  }

  const handleAutocompleteSelect = (value: string) => {
    completeAutocomplete(value, true)
  }

  const handleAutocompleteComplete = (value: string) => {
    completeAutocomplete(value, false)
  }

  const handleAutocompleteClose = () => {
    clearAutocomplete()
    focusTextarea()
  }

  const handleContentChange = () => {
    const value = Option.getOrElse(
      Option.map(inputRef, (renderable) => renderable.plainText),
      () => "",
    )
    const previousValue = sc.interactionState().draft
    // Skip if text matches current draft — avoids re-deriving autocomplete
    // after RestoreDraft (e.g. autocomplete selection triggers replaceText
    // which fires onContentChange, but we already closed autocomplete)
    if (value === previousValue) return
    if (value.length > previousValue.length && Option.isSome(inputRef)) {
      const inserted = value.slice(previousValue.length)
      if (isLargePaste(inserted)) {
        const placeholder = paste.createPlaceholder(inserted)
        const nextValue = previousValue + placeholder
        inputRef.value.replaceText(nextValue)
        inputRef.value.cursorOffset = nextValue.length
        sc.onComposerInteraction(
          ComposerInteractionEvent.cases.RestoreDraft.make({ text: nextValue }),
        )
        return
      }
    }
    sc.onComposerInteraction(ComposerInteractionEvent.cases.DraftChanged.make({ text: value }))

    // Prune tokens that are no longer in the text, then re-apply highlights
    for (let i = resolvedTokens.length - 1; i >= 0; i--) {
      const token = Option.fromNullishOr(resolvedTokens[i])
      if (Option.isNone(token) || !value.includes(token.value)) resolvedTokens.splice(i, 1)
    }
    applyTokenHighlights()
  }

  const submitShellCommand = (text: string) => {
    cast(
      executeShell(text, workspace.cwd).pipe(
        Effect.map(({ output, truncated, savedPath }) => {
          let userMessage = `$ ${text}\n\n${output}`
          if (!truncated) return userMessage
          // The notice names the spill file, so the rest stays reachable.
          userMessage += Option.match(savedPath, {
            onNone: () => `\n\n[output truncated]`,
            onSome: (path) => `\n\n[output truncated; full output saved to ${path}]`,
          })
          return userMessage
        }),
        Effect.tap((userMessage) =>
          Effect.sync(() => {
            sc.onComposerInteraction(ComposerInteractionEvent.cases.ExitShell.make({}))
            clearInput()
            sc.onSubmit(userMessage)
          }),
        ),
        // eslint-disable-next-line effect/noUnknownParameters -- shell failures cross the process boundary.
        Effect.catchEager((error: unknown) =>
          Effect.sync(() => {
            const decoded = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(
              error,
            )
            const message = Option.match(decoded, {
              onNone: () => String(error),
              onSome: (value) => value.message,
            })
            client.setError(message)
          }),
        ),
      ),
    )
  }

  const submitSlashCommand = (text: string) => {
    const parsed = Option.fromNullishOr(parseSlashCommand(text))
    if (Option.isNone(parsed)) return false

    const [cmd, args] = parsed.value
    client.log.info("slash-command", { cmd })
    clearInput()

    cast(client.surfaceError(sc.onSlashCommand(cmd, args)))
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
    const expandedValue = paste.expandPlaceholders(
      Option.getOrElse(
        Option.map(inputRef, (renderable) => renderable.plainText),
        () => "",
      ),
    )
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

    const currentContent = Option.getOrElse(
      Option.map(inputRef, (renderable) => renderable.plainText),
      () => "",
    )
    const editor = resolveEditor(env.visual, env.editor)
    cast(
      openExternalEditor(
        currentContent,
        () => renderer.suspend(),
        () => renderer.resume(),
        editor,
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result._tag === "applied" && Option.isSome(inputRef)) {
              inputRef.value.replaceText(result.content)
              inputRef.value.cursorOffset = result.content.length
              sc.onComposerInteraction(
                ComposerInteractionEvent.cases.RestoreDraft.make({ text: result.content }),
              )
              return
            }
            if (result._tag === "error") {
              client.setError(result.message)
            }
          }),
        ),
      ),
    )

    return true
  }

  const handleAutocompleteKey = (event: {
    readonly ctrl?: boolean
    readonly name?: string
  }): Option.Option<boolean> => {
    if (Option.isNone(autocompleteOption())) return Option.none()
    if (event.name === "escape") {
      clearAutocomplete()
      return Option.some(true)
    }
    const keyName = Option.getOrElse(Option.fromNullishOr(event.name), () => "")
    // Enter is deliberately absent from this list. A popup holding rows binds
    // its keys after this handler and consumes enter before the composer sees
    // it, so an enter arriving here is one the popup already declined for want
    // of a row to select. Claiming it anyway is what swallowed `/xyz`: the
    // popup opened on zero rows, so nothing selected the key and nothing
    // submitted the draft. The navigation keys stay claimed — while a popup is
    // open the cursor is its business, rows or no rows.
    if (["up", "down", "tab"].includes(keyName)) {
      return Option.some(false)
    }
    if (event.ctrl === true && (event.name === "p" || event.name === "n")) {
      return Option.some(false)
    }
    return Option.none()
  }

  const handleShellModeKey = (event: { readonly name?: string }): boolean => {
    if (
      event.name === "!" &&
      Option.isSome(inputRef) &&
      inputRef.value.cursorOffset === 0 &&
      effectiveMode() === "editing" &&
      Option.isNone(autocompleteOption())
    ) {
      sc.onComposerInteraction(ComposerInteractionEvent.cases.EnterShell.make({}))
      return true
    }

    if (effectiveMode() !== "shell") return false

    if (event.name === "escape") {
      sc.onComposerInteraction(ComposerInteractionEvent.cases.ExitShell.make({}))
      clearAutocomplete()
      clearInput()
      return true
    }

    const cursorOffset = Option.getOrElse(
      Option.map(inputRef, (renderable) => renderable.cursorOffset),
      () => 0,
    )
    if (event.name === "backspace" && cursorOffset <= 1) {
      sc.onComposerInteraction(ComposerInteractionEvent.cases.ExitShell.make({}))
      clearAutocomplete()
      return true
    }

    return false
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
      Option.isSome(autocompleteOption()) ||
      Option.isNone(inputRef) ||
      event.ctrl === true ||
      event.meta === true ||
      event.option === true ||
      event.shift === true
    ) {
      return false
    }

    const result = history.navigate(
      event.name,
      inputRef.value.plainText,
      inputRef.value.cursorOffset,
      inputRef.value.plainText.length,
    )
    const text = Option.fromNullishOr(result.text)
    if (!result.handled || Option.isNone(text)) return false

    inputRef.value.replaceText(text.value)
    if (result.cursor === "start") inputRef.value.cursorOffset = 0
    else inputRef.value.cursorOffset = text.value.length
    sc.onComposerInteraction(ComposerInteractionEvent.cases.RestoreDraft.make({ text: text.value }))
    return true
  }

  useScopedKeyboard((event) => {
    if (sc.promptSearch.isOpen()) return false

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
    if (Option.isSome(autocompleteResult)) return autocompleteResult.value
    if (handleShellModeKey(event)) return true
    if (handlePromptHistoryKey(event)) return true
    return false
  })

  /**
   * Called by textarea onSubmit (keybinding: bare return → submit action).
   *
   * An open popup is not consulted. A popup with rows never lets enter reach
   * the textarea, so reaching here means the draft is the only thing the key
   * can act on.
   */
  const handleSubmitFromTextarea = () => {
    if (sc.promptSearch.isOpen() || effectiveMode() === "interaction") return
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

    if (sc.promptSearch.isOpen() || effectiveMode() === "interaction") {
      event.preventDefault()
      return
    }

    // Meta/Super+Enter = interject (bypasses keybindings)
    if (event.meta === true || event.super === true) {
      event.preventDefault()
      submitMode = "interject"
      handleSubmit()
      return
    }

    // An open popup is not a reason to swallow enter. A popup with rows has
    // already consumed the key through its own list; one without rows has
    // nothing to select, and the draft underneath is what the reader meant to
    // send. Both cases fall through to the textarea keybindings below.
    // All other Enter variants (bare, shift, ctrl) fall through to textarea keybindings
  }

  createEffect(() => {
    const draft = sc.interactionState().draft
    if (Option.isNone(inputRef) || inputRef.value.plainText === draft) return
    inputRef.value.replaceText(draft)
    inputRef.value.cursorOffset = draft.length
    clearAutocomplete()
    focusTextarea()
  })

  onMount(() => {
    focusTextarea()
  })

  onCleanup(() => {
    const state = sc.interactionState()
    sc.saveDraft({ draft: paste.expandPlaceholders(state.draft), mode: state.mode })
    paste.clear()
    tokenStyle.destroy()
  })

  return {
    autocomplete,
    mode: effectiveMode,
    inputFocused: () =>
      !command.paletteOpen() &&
      !sc.promptSearch.isOpen() &&
      effectiveMode() !== "interaction" &&
      sc.uiState().overlay._tag === "none",
    attachTextarea: (renderable) => {
      inputRef = Option.fromNullishOr(renderable)
      if (Option.isSome(inputRef)) {
        inputRef.value.onContentChange = handleContentChange
        inputRef.value.syntaxStyle = tokenStyle
      }
    },
    handleTextareaKeyDown,
    handleSubmitFromTextarea,
    resolveInteraction: (result: ApprovalResult) => {
      sc.dispatchComposer(ComposerEvent.cases.ResolveInteraction.make({ result }))
    },
    cancelInteraction: () => {
      sc.dispatchComposer(ComposerEvent.cases.CancelInteraction.make({}))
    },
    handleAutocompleteSelect,
    handleAutocompleteComplete,
    handleAutocompleteClose,
  }
}
