import { createEffect, onCleanup, onMount, type Accessor } from "solid-js"
import { Effect } from "effect"
import type { TextareaRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useCommand } from "../command/index"
import { useClient } from "../client/index"
import { useEnv } from "../env/context"
import { useRuntime } from "../hooks/use-runtime"
import { usePromptHistory } from "../hooks/use-prompt-history"
import { useSkills } from "../hooks/use-skills"
import { useScopedKeyboard } from "../keyboard/context"
import { useWorkspace } from "../workspace/index"
import { executeSlashCommand, parseSlashCommand } from "../commands/slash-commands"
import type { UiError } from "../utils/format-error"
import { ClientError, formatError } from "../utils/format-error"
import { openExternalEditor, resolveEditor } from "../utils/external-editor"
import { expandFileRefs } from "../utils/file-refs"
import { expandSkillMentions } from "../utils/skill-expansion"
import { executeShell } from "../utils/shell"
import { clientLog } from "../utils/client-logger"
import type { AutocompleteState } from "./autocomplete-popup"
import type {
  ComposerInteractionEvent,
  ComposerInteractionState,
} from "./composer-interaction-state"
import type { ComposerEvent, ComposerState } from "./composer-state"
import type { InteractionEventTag, InteractionResolutionByTag } from "@gent/core/domain/event.js"

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

export interface ComposerControllerProps {
  onSubmit: (content: string, mode?: "queue" | "interject") => void
  onSlashCommand?: (cmd: string, args: string) => Effect.Effect<void, UiError>
  clearMessages?: () => void
  onRestoreQueue?: () => void
  suspended?: boolean
  interactionState: ComposerInteractionState
  onInteractionEvent: (event: ComposerInteractionEvent) => void
  composerState?: ComposerState
  dispatchComposer?: (event: ComposerEvent) => void
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
  readonly resolveInteraction: (
    tag: InteractionEventTag,
    result: InteractionResolutionByTag[InteractionEventTag],
  ) => void
  readonly cancelInteraction: () => void
  readonly handleAutocompleteSelect: (value: string) => void
  readonly handleAutocompleteClose: () => void
}

export function useComposerController(props: ComposerControllerProps): ComposerController {
  const workspace = useWorkspace()
  const command = useCommand()
  const client = useClient()
  const renderer = useRenderer()
  const env = useEnv()
  const { cast } = useRuntime(client.runtime)
  const history = usePromptHistory()
  const skillsHook = useSkills()
  const paste = createPasteManager()

  let inputRef: TextareaRenderable | null = null
  let submitMode: "queue" | "interject" = "queue"

  const autocomplete = () => props.interactionState.autocomplete
  const effectiveMode = (): "editing" | "shell" | "interaction" =>
    props.composerState?._tag === "interaction" ? "interaction" : props.interactionState.mode

  const clearInput = () => {
    if (inputRef !== null) inputRef.setText("")
    props.onInteractionEvent({ _tag: "ClearDraft" })
  }

  const clearAutocomplete = () => {
    props.onInteractionEvent({ _tag: "CloseAutocomplete" })
  }

  const focusTextarea = () => {
    inputRef?.focus()
  }

  const handleAutocompleteSelect = (value: string) => {
    const state = autocomplete()
    if (state === null || inputRef === null) return

    const beforeTrigger = inputRef.plainText.slice(0, state.triggerPos)
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

    const nextValue = beforeTrigger + insertion
    inputRef.replaceText(nextValue)
    inputRef.cursorOffset = nextValue.length
    props.onInteractionEvent({ _tag: "RestoreDraft", text: nextValue })
    focusTextarea()
  }

  const handleAutocompleteClose = () => {
    clearAutocomplete()
    focusTextarea()
  }

  const handleContentChange = () => {
    const value = inputRef?.plainText ?? ""
    const previousValue = props.interactionState.draft
    if (value.length > previousValue.length && inputRef !== null) {
      const inserted = value.slice(previousValue.length)
      if (isLargePaste(inserted)) {
        const placeholder = paste.createPlaceholder(inserted)
        const nextValue = previousValue + placeholder
        inputRef.replaceText(nextValue)
        inputRef.cursorOffset = nextValue.length
        props.onInteractionEvent({ _tag: "RestoreDraft", text: nextValue })
        return
      }
    }
    props.onInteractionEvent({ _tag: "DraftChanged", text: value })
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
            props.onInteractionEvent({ _tag: "ExitShell" })
            clearInput()
            props.onSubmit(userMessage)
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
    clientLog.info("slash-command", { cmd, hasCustomHandler: props.onSlashCommand !== undefined })
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
    return true
  }

  const submitMessage = (text: string, mode: "queue" | "interject") => {
    clientLog.info("composer.submit.requested", { contentLength: text.length, mode })
    history.add(text)
    cast(
      expandFileRefs(text, workspace.cwd).pipe(
        Effect.map((expanded) => {
          if (!expanded.includes("$")) return expanded
          const skills = skillsHook.skills()
          return expandSkillMentions(
            expanded,
            (name) => skillsHook.getContent(name),
            (name) => skills.find((skill) => skill.name === name)?.filePath ?? null,
          )
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
          props.onInteractionEvent({ _tag: "RestoreDraft", text: result.content })
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
      props.onInteractionEvent({ _tag: "EnterShell" })
      return true
    }

    if (effectiveMode() !== "shell") return false

    if (event.name === "escape") {
      props.onInteractionEvent({ _tag: "ExitShell" })
      clearAutocomplete()
      clearInput()
      return true
    }

    if (event.name === "backspace" && (inputRef?.cursorOffset ?? 0) <= 1) {
      props.onInteractionEvent({ _tag: "ExitShell" })
      clearAutocomplete()
      return true
    }

    return false
  }

  const handleSlashAutocompleteKey = (event: { readonly name?: string }): boolean => {
    if (
      event.name !== "/" ||
      inputRef?.cursorOffset !== 0 ||
      effectiveMode() !== "editing" ||
      autocomplete() !== null
    ) {
      return false
    }

    props.onInteractionEvent({
      _tag: "OpenAutocomplete",
      autocomplete: { type: "/", filter: "", triggerPos: 0 },
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
    props.onInteractionEvent({ _tag: "RestoreDraft", text: result.text })
    return true
  }

  useScopedKeyboard((event) => {
    if (props.suspended === true) return false

    if (handleExternalEditorKey(event)) return true

    if ((event.meta === true || event.super === true) && event.name === "up") {
      props.onRestoreQueue?.()
      return true
    }

    const autocompleteResult = handleAutocompleteKey(event)
    if (autocompleteResult !== undefined) return autocompleteResult
    if (handleShellModeKey(event)) return true
    if (handleSlashAutocompleteKey(event)) return true
    if (handlePromptHistoryKey(event)) return true
    return false
  })

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

    if (props.suspended === true || effectiveMode() === "interaction") {
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

  createEffect(() => {
    const draft = props.interactionState.draft
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
  })

  return {
    autocomplete,
    mode: effectiveMode,
    promptSymbol: () => (effectiveMode() === "shell" ? "$ " : "❯ "),
    inputFocused: () =>
      !command.paletteOpen() && props.suspended !== true && effectiveMode() !== "interaction",
    attachTextarea: (renderable) => {
      inputRef = renderable
      if (renderable !== null) {
        renderable.onContentChange = handleContentChange
      }
    },
    handleTextareaKeyDown,
    resolveInteraction: (
      tag: InteractionEventTag,
      result: InteractionResolutionByTag[InteractionEventTag],
    ) => {
      props.dispatchComposer?.({ _tag: "ResolveInteraction", tag, result })
    },
    cancelInteraction: () => {
      props.dispatchComposer?.({ _tag: "CancelInteraction" })
    },
    handleAutocompleteSelect,
    handleAutocompleteClose,
  }
}
