import { type ProcessError, runProcess } from "@gent/core/extensions/api"
import { dataPaths } from "@gent/sdk"
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { homedir } from "os"
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import {
  type AutocompleteState,
  type StatusRowLabel,
  ComposerEvent,
  ComposerInteractionEvent,
  overlayHoldsComposer,
  useComposerRefusals,
  usePromptHistory,
  useSessionController,
} from "./session"
import { useTheme } from "./theme"
import { useScopedKeyboard, useTerminalDimensions } from "./terminal"
import { textWidth } from "./bun-adapter"
import {
  expandFileRefs,
  formatError,
  inlineHead,
  lostRequest,
  randomId,
  truncate,
  useRequiredContext,
} from "./utils"
import {
  keyHint,
  KeyHints,
  PickerFrame,
  PickerHost,
  selectable,
  SelectList,
  type SelectListApi,
  type SelectListRow,
  useDockSpacer,
  usePickerGeometry,
} from "./ui"
import { useExtensionUI } from "./extensions/host"
import { type SessionIdentity, useClient, useRuntime } from "./client"
import type {
  AutocompleteContribution,
  InteractionRendererComponent,
} from "./extensions/client-facets.js"
import { PromptRenderer } from "./interaction-renderers"
import {
  runAutocompleteContributions,
  type SourcedAutocompleteItem,
} from "./extensions/loader-boundary"
import { ghostCompletion } from "./autocomplete"
import {
  decodePasteBytes,
  type PasteEvent,
  stripAnsiSequences,
  SyntaxStyle,
  type TextareaRenderable,
} from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { isSlashCommandName, parseSlashCommand, useCommand } from "./commands"
import { useEnv } from "./workspace"
import { openExternalEditor, resolveEditor } from "./os"
import {
  type ActiveInteraction,
  type ApprovalResult,
  type GentClientRpcError,
  lineCount,
  splitLines,
} from "@gent/core/protocol"

// ── shell execution ─────────────────────────────────────────────────────────

/**
 * Shell execution utility with an inline output cap and a spill file.
 *
 * The composer's `!cmd` shell puts its output straight into a chat message, so
 * the inline copy has to stay small. A command that overruns the cap writes its
 * whole output under the gent data directory and the notice names that file, so
 * nothing the reader ran is lost to the cap.
 */

/**
 * Spill files live beside the rest of the gent data, not in a temp directory.
 * A run with its own `GENT_DATA_DIR` keeps them there, off the real home.
 */
const shellOutputDirectory = (): Effect.Effect<string> =>
  Effect.map(dataPaths(homedir()), ({ dataDir }) => `${dataDir}/shell-output`)

/**
 * Execute a shell command. The inline copy keeps the whole lines that fit the
 * `@file` cap (`inlineHead`). The caller sees `truncated` when the cap drops
 * output, and `savedPath` names the file holding the whole of it.
 */
export const executeShell = (command: string, cwd: string) =>
  Effect.gen(function* () {
    const { stdout, stderr } = yield* runCommand(command, cwd)
    let fullOutput = stdout
    if (stderr.length > 0) fullOutput = `${stdout}\n${stderr}`

    const lines = splitLines(fullOutput)
    const kept = inlineHead(lines)

    if (kept.length === lines.length) {
      return { output: fullOutput.trim(), truncated: false, savedPath: Option.none<string>() }
    }

    const savedPath = yield* saveFullOutput(command, fullOutput)
    return {
      output: kept.join("\n").trim(),
      truncated: true,
      savedPath,
    }
  })

/**
 * Writes the whole output beside the rest of the gent data. A write that fails
 * costs the reader the spill file, not the command they just ran, so the
 * failure reports as an absent path rather than a failed shell.
 */
const saveFullOutput = (
  command: string,
  output: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* shellOutputDirectory()
    yield* fs.makeDirectory(directory, { recursive: true })
    const now = yield* DateTime.nowAsDate
    const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-")
    const filePath = path.join(directory, `shell_${stamp}.txt`)
    const header = `# Command: ${command}\n# Timestamp: ${now.toISOString()}\n\n`
    yield* fs.writeFileString(filePath, header + output)
    return Option.some(filePath)
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("shell.spill-write-failed").pipe(
        Effect.annotateLogs({ cause: String(cause) }),
        Effect.as(Option.none<string>()),
      ),
    ),
  )

/**
 * A spawn that fails (the session's directory is gone, bash is missing) is a
 * typed failure: the submit restores the command and says why.
 */
const runCommand = (
  command: string,
  cwd: string,
): Effect.Effect<
  { stdout: string; stderr: string },
  ProcessError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  runProcess("bash", ["-c", command], { cwd, stdout: "pipe", stderr: "pipe" }).pipe(
    Effect.map((r) => ({ stdout: r.stdout, stderr: r.stderr })),
  )

// ── composer frame ──────────────────────────────────────────────────────────

interface StatusRowProps {
  labels: readonly StatusRowLabel[]
  /**
   * How many of `labels`, counted from the end, are laid out from the right
   * edge inward instead of after the left group.
   *
   * The reader glances at the right-hand labels (effort, context, cost)
   * without reading the row, so their position is fixed and the left group
   * is what gives way when the row runs out of columns.
   */
  rightLabels?: number
}

const SEPARATOR_WIDTH = 3

/** Joins labels with the separator, measuring the columns they occupy. */
const layout = (labels: readonly StatusRowLabel[], budget: number) => {
  const shown: StatusRowLabel[] = []
  let used = 0
  for (const label of labels) {
    if (label.text.length === 0) continue
    let separator = 0
    if (shown.length > 0) separator = SEPARATOR_WIDTH
    const remaining = budget - used - separator
    if (remaining <= 0) break
    const text = truncate(label.text, remaining)
    if (text.length === 0) break
    shown.push({ ...label, text })
    used += separator + textWidth(text)
    if (textWidth(label.text) > remaining) break
  }
  return { shown, used }
}

/**
 * The status row: the phase word, the cwd, the model and the extension
 * labels, with the context gauge and the cost anchored right. It sits right
 * under the input (the composer places it, `Composer`'s `statusRow`), and
 * every docked pane, the autocomplete popup and the palette included, docks
 * under it: the row never moves when a pane opens. The blank row above it is
 * a dock spacer.
 */
export function StatusRow(props: StatusRowProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const groups = createMemo(() => {
    const all = props.labels.filter((label) => label.text.length > 0)
    const reserved = Math.min(props.rightLabels ?? 0, all.length)
    const leftLabels = all.slice(0, all.length - reserved)
    const rightLabels = all.slice(all.length - reserved)
    const width = dimensions().width

    // The right group is laid out first and keeps its columns; the left group
    // spends what is left. A right group that cannot fit the row on its own
    // still truncates rather than pushing the left group to nothing.
    const right = layout(rightLabels, width)
    let rightGap = 0
    if (right.shown.length > 0) rightGap = SEPARATOR_WIDTH
    const leftBudget = Math.max(0, width - right.used - rightGap)
    const left = layout(leftLabels, leftBudget)
    const gap = Math.max(0, width - left.used - right.used)
    return { left: left.shown, right: right.shown, gap }
  })

  const aboveStatus = useDockSpacer()
  return (
    <box height={1} flexShrink={0} marginTop={aboveStatus()} overflow="hidden">
      <text wrapMode="none">
        <For each={groups().left}>
          {(label, index) => (
            <>
              <Show when={index() > 0}>
                <span style={{ fg: theme.textMuted }}> · </span>
              </Show>
              <span style={{ fg: label.color }}>{label.text}</span>
            </>
          )}
        </For>
        <Show when={groups().right.length > 0}>
          <span>{" ".repeat(groups().gap)}</span>
        </Show>
        <For each={groups().right}>
          {(label, index) => (
            <>
              <Show when={index() > 0}>
                <span style={{ fg: theme.textMuted }}> · </span>
              </Show>
              <span style={{ fg: label.color }}>{label.text}</span>
            </>
          )}
        </For>
      </text>
    </box>
  )
}

/**
 * The composer's frame. The composer keeps its rows. While its autocomplete
 * popup or command palette is open, that picker is the one child that gives
 * way on a short terminal, so the frame may shrink by the picker's rows
 * alone. Its blank rows (above the input, above the status row) give way
 * first, while a docked pane is short (`useDockSpacer`).
 */
export function ComposerFrame(props: { children: JSX.Element }) {
  const aboveInput = useDockSpacer()
  return (
    <PickerHost>
      {(hosting) => {
        const shrink = () => {
          if (hosting()) return 1
          return 0
        }
        return (
          <box flexDirection="column" flexShrink={shrink()} paddingTop={aboveInput()}>
            <box flexDirection="column" flexShrink={shrink()}>
              {props.children}
            </box>
          </box>
        )
      }}
    </PickerHost>
  )
}

// ── autocomplete popup ──────────────────────────────────────────────────────

/**
 * Autocomplete popup — generic, contribution-driven.
 *
 * Extensions register prefixes and item sources via autocompleteItems.
 * The popup looks up contributions by the active prefix, fetches items
 * via createResource, and renders them through the shared list.
 *
 * The popup sits under the composer and shares its keys with it: while it
 * has nothing to select, enter still sends the draft and the arrows still
 * move the caret. The list is open only while it has rows, which is what
 * binds and unbinds those keys; escape closes the popup either way.
 */

export type { AutocompleteState }

interface AutocompletePopupProps {
  state: AutocompleteState
  /**
   * Enter on the selected row. A slash command name completed this way runs;
   * see the composer controller for why the two keys differ.
   */
  onSelect: (pick: SourcedAutocompleteItem) => void
  /** Tab on the selected row: completes the text and stops there. */
  onComplete: (pick: SourcedAutocompleteItem) => void
  onClose: () => void
  /**
   * The completion the composer may offer as ghost text, or none.
   *
   * The popup reports it rather than the composer deriving it, because the
   * popup already holds the fetched and ranked rows. Deriving it a second time
   * would run every contribution again on each keystroke — a filesystem search,
   * for `@` — to learn something already known here.
   */
  onGhostChange: (ghost: Option.Option<string>) => void
}

export function AutocompletePopup(props: AutocompletePopupProps) {
  const { theme } = useTheme()
  const extensionUI = useExtensionUI()
  const { log } = useClient()

  // Find contributions matching the active prefix
  const contributions = createMemo((): AutocompleteContribution[] =>
    extensionUI.autocompleteItems().filter((c) => c.prefix === props.state.type),
  )

  // Autocomplete items return a sync array or an Effect. Both run through
  // `runAutocompleteContributions` (boundary helper), which merges every
  // contribution for the prefix, drops duplicate ids, and turns one
  // contribution's failure into no rows from it plus one log line.

  // The prefix this popup has opened on. A mount is an open, and so is a
  // switch to another prefix while mounted; each tells its contributions once,
  // before their first fetch.
  let openedOn = Option.none<string>()
  const openOn = (prefix: string) => {
    if (Option.contains(openedOn, prefix)) return
    openedOn = Option.some(prefix)
    for (const contribution of contributions()) contribution.onOpen?.()
  }

  // Fetch items from all contributions for this prefix, keyed on [prefix, filter]
  const [items] = createResource(
    (): readonly [string, string] => [props.state.type, props.state.filter],
    ([prefix, filter]): Promise<SourcedAutocompleteItem[]> => {
      openOn(prefix)
      return runAutocompleteContributions(
        contributions(),
        filter,
        extensionUI.clientRuntime,
        (failed, reason) => {
          log.error("autocomplete.contribution.failed", { prefix: failed, error: reason })
        },
      )
    },
  )

  // Use .latest for stale-while-revalidate: keeps showing previous results
  // during refetch instead of flashing "Loading..."
  const visibleItems = () => Option.getOrElse(Option.fromNullishOr(items.latest), () => [])
  const hasItems = () => visibleItems().length > 0

  /**
   * The ghost tracks the row under the cursor, which is the row Tab completes.
   * The list opens on the top row and reports every cursor move, so the offer
   * and the key never name two different rows.
   *
   * It is cleared when the popup unmounts — a ghost outliving its popup would
   * offer a completion the composer can no longer perform.
   */
  const [cursor, setCursor] = createSignal<Option.Option<SourcedAutocompleteItem>>(Option.none())
  createEffect(() => {
    const top = Option.fromNullishOr(visibleItems()[0])
    props.onGhostChange(
      ghostCompletion(
        Option.orElse(cursor(), () => top).pipe(Option.map((entry) => entry.item)),
        props.state.filter,
      ),
    )
  })

  onCleanup(() => {
    props.onGhostChange(Option.none())
  })

  // The composer owns the query, so the list never sees it typed. A new
  // query is a new list: the cursor goes back to the top match, as a query
  // typed into the list itself does.
  let list = Option.none<SelectListApi>()
  createEffect(
    on(
      () => props.state.filter,
      () => Option.map(list, (api) => api.reset()),
      { defer: true },
    ),
  )

  // The list binds escape only while it has rows; the popup closes on it always.
  useScopedKeyboard((e) => {
    if (e.name !== "escape") return false
    props.onClose()
    return true
  })

  const dimensions = useTerminalDimensions()

  // Title from the first matching contribution
  const title = () =>
    Option.getOrElse(Option.fromNullishOr(contributions()[0]), () => ({ title: props.state.type }))
      .title

  const loading = () => items.loading && !hasItems()
  const labelWidth = () => Math.max(8, Math.min(24, Math.floor(dimensions().width * 0.28)))
  // A row pads 1, gives the label labelWidth - 2 and a gap of 2: the description has the rest.
  const { rowWidth } = usePickerGeometry()
  const descriptionWidth = () => Math.max(0, rowWidth() - labelWidth() - 1)

  const keys = [KeyHints.move, KeyHints.select, keyHint("tab", "complete"), KeyHints.close]

  const rows = (): ReadonlyArray<SelectListRow<SourcedAutocompleteItem>> =>
    visibleItems().map((entry) =>
      selectable(entry, (isSelected, id) => {
        const item = entry.item
        const textColor = () => {
          if (isSelected()) return theme.primary
          return theme.text
        }
        const descriptionColor = () => {
          if (isSelected()) return theme.primary
          return theme.textMuted
        }
        const description = () => Option.fromNullishOr(item.description)
        return (
          <box id={id} paddingLeft={1} flexDirection="row" height={1} gap={2}>
            <text
              width={labelWidth() - 2}
              flexShrink={0}
              wrapMode="none"
              truncate
              style={{
                fg: textColor(),
              }}
            >
              <span style={{ bold: isSelected() }}>{truncate(item.label, labelWidth() - 2)}</span>
            </text>
            <text flexGrow={1} wrapMode="none" truncate style={{ fg: descriptionColor() }}>
              {/* Optional description is supplied by the external extension contribution. */}
              <Show when={Option.getOrUndefined(description())}>
                {(text) => (
                  <span
                    style={{
                      fg: descriptionColor(),
                      dim: !isSelected(),
                    }}
                  >
                    {truncate(text(), descriptionWidth())}
                  </span>
                )}
              </Show>
            </text>
          </box>
        )
      }),
    )

  const emptyRow = () => {
    let label = "No matches"
    if (loading()) label = "Loading…"
    return (
      <box paddingLeft={1}>
        <text style={{ fg: theme.textMuted }}>{label}</text>
      </box>
    )
  }

  return (
    <PickerFrame title={title()} keys={keys}>
      <SelectList
        id="autocomplete"
        // The composer owns the filter; the list draws it as its query row.
        queryRow={() => (
          <text style={{ fg: theme.textMuted }}>
            <Show when={props.state.filter.length > 0}>
              › <span style={{ fg: theme.text }}>{props.state.filter}</span>
            </Show>
          </text>
        )}
        open={hasItems()}
        rows={rows}
        rowKey={(entry) => entry.item.id}
        sticky={() => Option.some(0)}
        api={(api) => (list = Option.some(api))}
        empty={emptyRow}
        onCursor={setCursor}
        extraKeys={(event, selected) => {
          // Tab completes without running. The popup is the last place that
          // still knows which key arrived, so it is where the two intents part
          // company; downstream both look like "the reader chose this row".
          if (event.name !== "tab") return false
          Option.match(selected, {
            onNone: () => {},
            onSome: (entry) => props.onComplete(entry),
          })
          return true
        }}
        onSelect={(entry) => props.onSelect(entry)}
        onDismiss={props.onClose}
      />
    </PickerFrame>
  )
}

// ── composer controller ─────────────────────────────────────────────────────

const PASTE_THRESHOLD_LINES = 3
const PASTE_THRESHOLD_LENGTH = 150

export function isLargePaste(inserted: string): boolean {
  return lineCount(inserted) >= PASTE_THRESHOLD_LINES || inserted.length >= PASTE_THRESHOLD_LENGTH
}

/**
 * Per-controller: each composer owns its placeholder ids and store. A paste
 * stays stored while the textarea's undo history can bring its chip back; the
 * store clears only with that history, when the draft is reset.
 */
export function createPasteManager() {
  let idCounter = 0
  const store = new Map<string, string>()

  return {
    // A paste of several lines counts its lines; one long line counts its characters.
    createPlaceholder(text: string): string {
      const id = String(++idCounter)
      store.set(id, text)
      const lines = lineCount(text)
      if (lines > 1) return `[Pasted ${lines} lines #${id}]`
      return `[Pasted ${text.length} chars #${id}]`
    },
    expandPlaceholders(text: string): string {
      return text.replace(/\[Pasted \d+ (?:lines|chars) #(\d+)\]/g, (match, id) =>
        Option.getOrElse(Option.fromNullishOr(store.get(id)), () => match),
      )
    },
    /**
     * The chip that string index `index` stands inside or at the end of, and
     * that still holds its stored text.
     */
    chipAt(text: string, index: number): Option.Option<{ start: number; end: number }> {
      for (const match of text.matchAll(/\[Pasted \d+ (?:lines|chars) #(\d+)\]/g)) {
        const start = match.index
        const end = start + match[0].length
        if (start < index && index <= end && store.has(match[1] ?? "")) {
          return Option.some({ start, end })
        }
      }
      return Option.none()
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
    name?: string
    shift?: boolean
    ctrl?: boolean
    meta?: boolean
    super?: boolean
    preventDefault: () => void
  }) => void
  readonly handleSubmitFromTextarea: () => void
  readonly resolveInteraction: (result: ApprovalResult) => void
  /** Enter on a row: completes, and dispatches when the row names a command. */
  readonly handleAutocompleteSelect: (pick: SourcedAutocompleteItem) => void
  /** Tab on a row: completes only, never dispatches. */
  readonly handleAutocompleteComplete: (pick: SourcedAutocompleteItem) => void
  readonly handleAutocompleteClose: () => void
}

function useComposerController(): ComposerController {
  const sc = useSessionController()
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
    // setText drops the undo history, so no chip can come back for its paste.
    if (Option.isSome(inputRef)) inputRef.value.setText("")
    paste.clear()
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
  const completeAutocomplete = (pick: SourcedAutocompleteItem, dispatch: boolean) => {
    const state = autocompleteOption()
    if (Option.isNone(state) || Option.isNone(inputRef)) return

    // The row's own source records the pick (frecency) and formats its insertion.
    const value = pick.item.id
    const onSelect = Option.fromNullishOr(pick.source.onSelect)
    if (Option.isSome(onSelect)) onSelect.value(value, state.value.filter)
    const beforeTrigger = inputRef.value.plainText.slice(0, state.value.triggerPos)
    let insertion = `${state.value.type}${value} `
    const formatInsertion = Option.fromNullishOr(pick.source.formatInsertion)
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
      isSlashCommandName(value, extensionUI.commands())
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
    // An insertion that ends without a space is not finished (`@src/`): the
    // popup reopens on it instead of closing.
    if (insertion.endsWith(" ")) {
      sc.onComposerInteraction(
        ComposerInteractionEvent.cases.RestoreDraft.make({ text: nextValue }),
      )
    } else {
      sc.onComposerInteraction(
        ComposerInteractionEvent.cases.DraftChanged.make({ text: nextValue }),
      )
    }
    applyTokenHighlights()
    focusTextarea()
  }

  const handleAutocompleteSelect = (pick: SourcedAutocompleteItem) => {
    completeAutocomplete(pick, true)
  }

  const handleAutocompleteComplete = (pick: SourcedAutocompleteItem) => {
    completeAutocomplete(pick, false)
  }

  const handleAutocompleteClose = () => {
    clearAutocomplete()
    focusTextarea()
  }

  /**
   * A large paste becomes a placeholder at the caret. The paste event carries
   * the pasted text, and the textarea's own insert puts the placeholder where
   * the paste would have gone: at the caret, over any selection. Reading the
   * paste back from the changed draft cannot tell where it landed.
   *
   * The paste is where raw terminal bytes enter the draft. A terminal that
   * sends Enter as CR pastes CR line breaks, so they become `\n` here: the
   * chip counts the lines, the model reads them, and ↑ recalls text the
   * textarea holds unchanged.
   */
  const handlePaste = (event: PasteEvent) => {
    if (Option.isNone(inputRef)) return
    const pasted = stripAnsiSequences(decodePasteBytes(event.bytes)).replace(/\r\n?/g, "\n")
    if (!isLargePaste(pasted)) return
    event.preventDefault()
    inputRef.value.insertText(paste.createPlaceholder(pasted))
  }

  /**
   * A paste chip is one unit. Backspace or a word delete at its end or from
   * inside it removes the whole chip in one undo step; editing it a character
   * at a time would send the fragment and lose the paste. The stored text
   * stays, so an undo gives back a chip that still sends its paste.
   *
   * The textarea counts its caret in its own units, which a wide or
   * multi-byte character makes differ from string indices. The text before
   * the caret gives the caret's string index. A chip is all ASCII, one unit
   * per character in both counts, so the caret moves back by the part of the
   * chip before it.
   */
  const removeChipAtCaret = (event: {
    readonly name?: string
    readonly ctrl?: boolean
    readonly preventDefault: () => void
  }): boolean => {
    const deletesBack = event.name === "backspace" || (event.name === "w" && event.ctrl === true)
    if (!deletesBack || Option.isNone(inputRef) || inputRef.value.hasSelection()) return false
    const value = inputRef.value.plainText
    const caret = inputRef.value.cursorOffset
    const caretIndex = inputRef.value.getTextRange(0, caret).length
    const chip = paste.chipAt(value, caretIndex)
    if (Option.isNone(chip)) return false
    event.preventDefault()
    const next = value.slice(0, chip.value.start) + value.slice(chip.value.end)
    inputRef.value.replaceText(next)
    inputRef.value.cursorOffset = caret - (caretIndex - chip.value.start)
    sc.onComposerInteraction(ComposerInteractionEvent.cases.DraftChanged.make({ text: next }))
    return true
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
    sc.onComposerInteraction(ComposerInteractionEvent.cases.DraftChanged.make({ text: value }))

    // Prune tokens that are no longer in the text, then re-apply highlights
    for (let i = resolvedTokens.length - 1; i >= 0; i--) {
      const token = Option.fromNullishOr(resolvedTokens[i])
      if (Option.isNone(token) || !value.includes(token.value)) resolvedTokens.splice(i, 1)
    }
    applyTokenHighlights()
  }

  /**
   * A refused submission goes back to the draft of the branch it was sent
   * from, with its reason. The composer on screen for that branch takes both
   * now; a branch the reader has left keeps them for the return.
   */
  const refusals = useComposerRefusals()
  const writeDraft = (next: { readonly draft: string; readonly mode: "editing" | "shell" }) => {
    if (next.mode !== sc.interactionState().mode) {
      if (next.mode === "shell") {
        sc.onComposerInteraction(ComposerInteractionEvent.cases.EnterShell.make({}))
      } else sc.onComposerInteraction(ComposerInteractionEvent.cases.ExitShell.make({}))
    }
    if (Option.isSome(inputRef)) {
      inputRef.value.replaceText(next.draft)
      inputRef.value.cursorOffset = next.draft.length
    }
    sc.onComposerInteraction(ComposerInteractionEvent.cases.RestoreDraft.make({ text: next.draft }))
  }
  // The composer on screen takes refusals for the branch in view. The draft
  // is merged as it stands, paste placeholders included: a paste expands at
  // submit, never when a refusal lands.
  createEffect(() => {
    const identity = client.sessionIdentity()
    if (Option.isNone(identity)) return
    onCleanup(
      refusals.link(identity.value.branchId, {
        current: () => ({
          draft: Option.getOrElse(
            Option.map(inputRef, (renderable) => renderable.plainText),
            () => "",
          ),
          mode: sc.interactionState().mode,
        }),
        apply: writeDraft,
        // A refused message as large as a paste comes back as one: a placeholder
        // that expands at submit, not the whole text written into the draft.
        write: (text) => {
          if (isLargePaste(text)) return paste.createPlaceholder(text)
          return text
        },
      }),
    )
  })
  const shellRefusal = (error: ProcessError | GentClientRpcError): string => {
    if (error._tag === "ProcessError") return `Shell: ${error.message}`
    return formatError(error)
  }
  const refuse = (
    target: SessionIdentity,
    refused: Parameters<typeof refusals.refuse>[1],
    reason: string,
  ) => {
    client.setErrorIn(target, reason)
    refusals.refuse(target.branchId, refused)
  }

  /**
   * The session a draft was written in. A submission carries it to the end:
   * a switch while `@file` expands or `!cmd` runs does not move the message.
   */
  const draftedIn = (): Option.Option<SessionIdentity> => client.sessionIdentity()

  const submitShellCommand = (text: string) => {
    const drafted = draftedIn()
    if (Option.isNone(drafted)) return
    const target = drafted.value
    const order = refusals.nextOrder()
    refusals.submitted(target.branchId, text)
    // The command leaves the composer before it runs, so a second Enter
    // finds an empty draft instead of running it again.
    sc.onComposerInteraction(ComposerInteractionEvent.cases.ExitShell.make({}))
    clearInput()
    cast(
      client.cwdOf(target.sessionId).pipe(
        Effect.flatMap((cwd) => executeShell(text, cwd)),
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
        Effect.flatMap((userMessage) =>
          // The command has run, and its side effects are done. A refused send
          // gives back the output as a message, never the command to run again.
          randomId.pipe(
            Effect.flatMap((requestId) =>
              sc.onSubmit(userMessage, "queue", target, requestId).pipe(
                Effect.catchEager((error) =>
                  Effect.sync(() =>
                    refuse(
                      target,
                      {
                        order,
                        text: userMessage,
                        shell: false,
                        requestId: lostRequest(error, requestId),
                      },
                      `The command ran; its output was not sent. ${formatError(error)}`,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        // Nothing ran: the command comes back to run.
        Effect.catchEager((error) =>
          Effect.sync(() => {
            refuse(
              target,
              { order, text, shell: true, requestId: Option.none() },
              shellRefusal(error),
            )
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
    const order = refusals.nextOrder()
    const drafted = draftedIn()
    Option.map(drafted, (target) => refusals.submitted(target.branchId, text))
    clearInput()

    // A command nothing runs comes back to the draft it was written in.
    const refuseCommand = (reason: string) =>
      Option.match(drafted, {
        onNone: () => client.setError(reason),
        onSome: (target) =>
          refuse(target, { order, text, shell: false, requestId: Option.none() }, reason),
      })
    cast(client.surfaceError(sc.onSlashCommand(cmd, args, refuseCommand)))
    return true
  }

  const submitMessage = (text: string, mode: "queue" | "interject") => {
    const drafted = draftedIn()
    if (Option.isNone(drafted)) return
    const target = drafted.value
    client.log.info("composer.submit.requested", { contentLength: text.length, mode })
    history.add(text)
    const order = refusals.nextOrder()
    // A refused text sent again unchanged after a lost reply keeps its id.
    const reused = refusals.submitted(target.branchId, text)
    // The message leaves the composer before its `@file` refs expand, so a
    // second Enter finds an empty draft instead of sending it again.
    clearInput()
    cast(
      Option.match(reused, { onNone: () => randomId, onSome: Effect.succeed }).pipe(
        Effect.flatMap((requestId) =>
          client.cwdOf(target.sessionId).pipe(
            Effect.flatMap((cwd) => expandFileRefs(text, cwd)),
            // A send the server rejects comes back to the composer with the reason.
            Effect.flatMap((expanded) => sc.onSubmit(expanded, mode, target, requestId)),
            Effect.catchEager((error) =>
              Effect.sync(() =>
                refuse(
                  target,
                  { order, text, shell: false, requestId: lostRequest(error, requestId) },
                  formatError(error),
                ),
              ),
            ),
          ),
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
    // it, so an enter arriving here is one the popup declined for want of a
    // row to select, and it submits the draft (`/xyz` on zero rows). The
    // navigation keys stay claimed: while a popup is open the cursor is its
    // business, rows or no rows.
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

    // Esc on a shell draft arms its clear as on any draft (the session's
    // ladder); Esc on an empty shell draft leaves shell mode at once.
    if (event.name === "escape") {
      if (sc.interactionState().draft.length > 0) return false
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

  /**
   * A session pane (a picker, prompt search) holds the composer: no composer
   * key acts behind it, and Enter does not submit.
   */
  const holdsComposer = () => overlayHoldsComposer(sc.uiState().overlay)

  const inputFocused = () =>
    !command.paletteOpen() && effectiveMode() !== "interaction" && !holdsComposer()

  useScopedKeyboard((event) => {
    if (holdsComposer()) return false

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
    if (holdsComposer() || effectiveMode() === "interaction") return
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
    if (removeChipAtCaret(event)) return
    const isEnterKey = event.name === "return" || event.name === "linefeed"
    if (!isEnterKey) return

    if (holdsComposer() || effectiveMode() === "interaction") {
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
    // A prompt-search preview writes the draft while the palette holds the
    // composer: focus stays with the palette, or a paste would land here.
    if (inputFocused()) focusTextarea()
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
    inputFocused,
    attachTextarea: (renderable) => {
      inputRef = Option.fromNullishOr(renderable)
      if (Option.isSome(inputRef)) {
        inputRef.value.onContentChange = handleContentChange
        inputRef.value.onPaste = handlePaste
        inputRef.value.syntaxStyle = tokenStyle
      }
    },
    handleTextareaKeyDown,
    handleSubmitFromTextarea,
    resolveInteraction: (result: ApprovalResult) => {
      sc.dispatchComposer(ComposerEvent.cases.ResolveInteraction.make({ result }))
    },
    handleAutocompleteSelect,
    handleAutocompleteComplete,
    handleAutocompleteClose,
  }
}

// ── composer surface ────────────────────────────────────────────────────────

/**
 * Unified composer with autocomplete, interaction renderers, and submit flows.
 */

interface ComposerContextValue {
  // eslint-disable-next-line effect/noNullish -- AutocompletePopup uses null for its closed Solid state.
  autocomplete: Accessor<AutocompleteState | null>
  handleAutocompleteSelect: (pick: SourcedAutocompleteItem) => void
  handleAutocompleteComplete: (pick: SourcedAutocompleteItem) => void
  handleAutocompleteClose: () => void
  setGhost: (ghost: Option.Option<string>) => void
}

const ComposerContext = createContext<ComposerContextValue>()

/**
 * The ghost line. It offers the completion the popup's cursor row already
 * shows, so it is a spacer to the dock: it gives way with the blank rows when
 * the popup is short of rows, and comes back only once they all fit.
 */
function GhostLine(props: { completion: string }) {
  const { theme } = useTheme()
  const row = useDockSpacer()
  return (
    <Show when={row() > 0}>
      <box flexShrink={0} height={1} paddingLeft={2} overflow="hidden">
        <text style={{ fg: theme.textMuted }} wrapMode="none">
          {props.completion} <span style={{ fg: theme.textMuted }}>⇥</span>
        </text>
      </box>
    </Show>
  )
}

interface ComposerProps {
  /** The status row, drawn under the input and above the docked pickers. */
  statusRow?: JSX.Element
  children?: JSX.Element
}

export function Composer(props: ComposerProps) {
  const { theme } = useTheme()
  const sc = useSessionController()
  const controller = useComposerController()
  const ext = useExtensionUI()
  const dimensions = useTerminalDimensions()
  const [pickerHeight, setPickerHeight] = createSignal(0)
  // Keep one transcript row and the composer's spacing/status rows visible.
  const editorHeight = () => Math.max(1, Math.min(8, dimensions().height - pickerHeight() - 4))
  const decodeMetadata = Schema.decodeUnknownOption(Schema.JsonObject)
  const decodeString = Schema.decodeUnknownOption(Schema.String)
  const promptColor = () => {
    if (controller.mode() === "shell") return theme.warning
    return theme.primary
  }

  /**
   * The completion the popup's top row offers, or none.
   *
   * It is drawn as a muted line under the input rather than as text inside it.
   * The buffer's own virtual-text facility (`extmarks`) cannot draw it: marks
   * created with `virtual: true` are stored and returned by `getVirtual()` but
   * never reach the screen, and holding one across an edit breaks undo. Drawing
   * beside the textarea fails differently — a shrink-to-fit input hands the
   * ghost whatever columns are left on each wrapped row, so a long draft splits
   * the ghost mid-word across lines. A row of its own is the one placement that
   * survives wrapping, and it keeps the draft literally what the reader typed:
   * the ghost is never in the buffer, so Enter can never submit it.
   */
  const [ghost, setGhost] = createSignal(Option.none<string>())

  const contextValue: ComposerContextValue = {
    autocomplete: controller.autocomplete,
    handleAutocompleteSelect: controller.handleAutocompleteSelect,
    handleAutocompleteComplete: controller.handleAutocompleteComplete,
    handleAutocompleteClose: controller.handleAutocompleteClose,
    setGhost,
  }

  /** The ghost is only an offer while there is an open popup to complete from. */
  const visibleGhost = (): Option.Option<string> => {
    if (Option.isNone(Option.fromNullishOr(controller.autocomplete()))) return Option.none()
    if (controller.mode() !== "editing") return Option.none()
    return ghost()
  }

  /**
   * The interaction to draw. It waits for the client extensions: a renderer
   * chosen before they load would be the fallback for good.
   */
  const activeInteraction = (): Option.Option<ActiveInteraction> => {
    const cs = sc.composerState()
    if (cs._tag !== "interaction" || !ext.loaded()) return Option.none()
    return Option.some(cs.interaction)
  }

  /** The renderer for `metadata.type`; the host's `PromptRenderer` draws the rest. */
  const interactionRenderer = (interaction: ActiveInteraction): InteractionRendererComponent =>
    decodeMetadata(interaction.metadata).pipe(
      Option.flatMap((metadata) => decodeString(metadata["type"])),
      Option.flatMap((type) => Option.fromNullishOr(ext.interactionRenderers().get(type))),
      Option.getOrElse(() => PromptRenderer),
    )

  return (
    <ComposerContext.Provider value={contextValue}>
      <Show when={Option.getOrUndefined(activeInteraction())} keyed>
        {(interaction) => {
          const Renderer = interactionRenderer(interaction)
          return Renderer({
            event: interaction,
            resolve: (result: ApprovalResult) => {
              controller.resolveInteraction(result)
            },
          })
        }}
      </Show>

      <Show when={controller.mode() !== "interaction"}>
        <box
          flexShrink={0}
          flexDirection="row"
          border={["left"]}
          borderStyle="heavy"
          borderColor={promptColor()}
          paddingLeft={1}
        >
          <Show when={controller.mode() === "shell"}>
            <text style={{ fg: promptColor() }}>$ </text>
          </Show>
          <box flexGrow={1}>
            <textarea
              ref={controller.attachTextarea}
              focused={controller.inputFocused()}
              onKeyDown={controller.handleTextareaKeyDown}
              onSubmit={controller.handleSubmitFromTextarea}
              wrapMode="word"
              minHeight={1}
              maxHeight={editorHeight()}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "return", shift: true, action: "newline" },
                { name: "return", ctrl: true, action: "newline" },
                { name: "linefeed", action: "newline" },
                { name: "linefeed", shift: true, action: "newline" },
                // The kitty keyboard protocol spells ctrl+j as j with ctrl, not as linefeed.
                { name: "j", ctrl: true, action: "newline" },
                { name: "backspace", meta: true, action: "delete-word-backward" },
              ]}
              backgroundColor="transparent"
              focusedBackgroundColor="transparent"
            />
          </box>
        </box>
      </Show>

      {/* The ghost line: what Tab would complete, muted, on a row of its own. */}
      <Show when={Option.getOrUndefined(visibleGhost())}>
        {(completion) => <GhostLine completion={completion()} />}
      </Show>

      {props.statusRow}

      <box
        flexDirection="column"
        flexShrink={1}
        onSizeChange={function () {
          setPickerHeight(this.height)
        }}
      >
        {props.children}
      </box>
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
          onComplete={ctx.handleAutocompleteComplete}
          onClose={ctx.handleAutocompleteClose}
          onGhostChange={ctx.setGhost}
        />
      )}
    </Show>
  )
}
