/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, createUniqueId, For, type JSX, Show } from "solid-js"
import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core"
import { Effect, Option, Schema } from "effect"
import { useTheme } from "./theme"
import {
  pastedLine,
  type ScopedKeyboardEvent,
  typedKey,
  useScopedKeyboard,
  useTerminalDimensions,
} from "./terminal"
import { keyHint, keyHintsLine, KeyHints, lineEdit, useInPickerFrame, usePickerBody } from "./ui"
import type { InteractionRendererProps } from "./extensions/client-facets.js"
import { useRenderer } from "@opentui/solid"
import { useEnv } from "./workspace"
import { useClient, useRuntime } from "./client"
import { openExternalEditor, resolveEditor } from "./os"

// ── option list ─────────────────────────────────────────────────────────────

/**
 * Shared option-list UI for interaction renderers, the host's and a client
 * extension's. Renders a question with options, optional markdown, freeform
 * input, and keyboard navigation.
 *
 * The free-text row is a field the list reads through its keyboard scope, as
 * every docked field does (`typedKey`): typed text and a paste go to it from
 * any row, so the list works docked under a composer that keeps the focus.
 * In a `PickerFrame` the list fits the rows the frame gives it and leaves the
 * title and the key hints to the frame; out of one it sizes itself from the
 * terminal and draws its own hint row.
 */

const markdownSyntaxStyle = SyntaxStyle.create()

/** One pick of an option list. */
interface OptionListChoice {
  readonly label: string
  readonly description?: string
}

interface OptionListProps {
  readonly header?: string
  readonly question: string
  readonly markdown?: string
  readonly options?: readonly OptionListChoice[]
  readonly multiple?: boolean
  readonly progress?: string
  /** The row the cursor starts on; the free-text row is `options.length`. */
  readonly initialFocus?: number
  /** The pane's own keys, read before the list's (as `SelectList`'s `extraKeys`). */
  readonly extraKeys?: (event: ScopedKeyboardEvent) => boolean
  readonly onSubmit: (selections: readonly string[]) => void
  readonly onCancel: () => void
}

export function OptionList(props: OptionListProps): JSX.Element {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const framed = useInPickerFrame()

  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [freeformText, setFreeformText] = createSignal("")
  const [focusIndex, setFocusIndex] = createSignal(props.initialFocus ?? 0)
  const [documentHeight, setDocumentHeight] = createSignal(1)
  const [controlsChromeHeight, setControlsChromeHeight] = createSignal(0)
  const [optionsHeight, setOptionsHeight] = createSignal(0)
  const optionId = createUniqueId()
  let documentViewport: Option.Option<ScrollBoxRenderable> = Option.none()
  let optionsViewport: Option.Option<ScrollBoxRenderable> = Option.none()
  // In a frame the list reports every row it draws: the question, the
  // options and the free-text row. The frame caps them and gives back its rows.
  const frameRows = usePickerBody(() => ({
    rows: documentHeight() + optionsHeight() + 1,
    query: 0,
    dressed: 2,
    required: 1,
  }))
  const sectionSpacing = () => {
    if (framed || dimensions().height < 18) return 0
    return 1
  }
  const contentRows = () => {
    if (framed) {
      const rows = Option.getOrElse(frameRows(), () => documentHeight() + optionsHeight() + 1)
      return Math.max(2, rows - controlsChromeHeight())
    }
    return Math.max(2, dimensions().height - controlsChromeHeight() - 4 - sectionSpacing() * 3)
  }
  // A frame's few rows go to the options first; the question keeps one and scrolls.
  const optionsRows = () => {
    if (framed) return Math.min(optionsHeight(), Math.max(1, contentRows() - 1))
    return Math.min(optionsHeight(), Math.max(1, Math.floor(contentRows() / 2)))
  }
  const optionsScrollable = () => optionsHeight() > optionsRows()
  // Reserve the answer controls, panel padding, composer status, and one transcript row.
  const documentRows = () => Math.max(1, contentRows() - optionsRows())
  const documentScrollable = () => documentHeight() > documentRows()

  const options = () => Option.getOrElse(Option.fromNullishOr(props.options), () => [])
  const hasOptions = () => options().length > 0
  const isMultiple = () => props.multiple === true
  const focusableCount = () => options().length + 1
  const focusFreeform = () => {
    if (focusIndex() !== options().length) moveFocus(options().length - focusIndex())
  }

  const toggleFocusedOption = (): boolean => {
    const option = Option.fromNullishOr(options()[focusIndex()])
    if (Option.isNone(option)) return true
    const label = option.value.label

    if (isMultiple()) {
      setSelected((previous) => {
        const next = new Set(previous)
        if (next.has(label)) {
          next.delete(label)
        } else {
          next.add(label)
        }
        return next
      })
    } else {
      setSelected(new Set([label]))
    }
    return true
  }

  const scrollDocument = (pages: number) => {
    if (Option.isNone(documentViewport)) return false
    documentViewport.value.scrollBy(pages * documentViewport.value.height)
    return true
  }

  const scrollPage = (pages: number, question: boolean) => {
    if (!question && optionsScrollable() && Option.isSome(optionsViewport)) {
      optionsViewport.value.scrollBy(pages * optionsViewport.value.height)
      return true
    }
    return scrollDocument(pages)
  }

  const moveFocus = (direction: number) => {
    const index = (focusIndex() + direction + focusableCount()) % focusableCount()
    setFocusIndex(index)
    if (Option.isSome(optionsViewport)) {
      optionsViewport.value.scrollChildIntoView(`${optionId}-${index}`)
    }
  }

  useScopedKeyboard(
    (e) => {
      if (props.extraKeys && props.extraKeys(e)) return true
      return listKey(e)
    },
    {
      // A paste is free text: it goes to the free-text row, on one line.
      paste: (text) => {
        focusFreeform()
        setFreeformText((current) => current + pastedLine(text, " "))
        return true
      },
    },
  )

  const listKey = (e: ScopedKeyboardEvent): boolean => {
    if (e.name === "pageup") return scrollPage(-1, e.shift === true)
    if (e.name === "pagedown") return scrollPage(1, e.shift === true)
    if (e.name === "escape") {
      props.onCancel()
      return true
    }
    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      moveFocus(-1)
      return true
    }
    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      moveFocus(1)
      return true
    }

    if (e.name === "space" && focusIndex() < options().length) {
      return toggleFocusedOption()
    }

    if (e.name === "return") {
      // Single-select: Enter on a focused option selects + submits it
      if (!isMultiple() && focusIndex() < options().length) {
        const option = Option.fromNullishOr(options()[focusIndex()])
        if (Option.isSome(option) && selected().size === 0) {
          props.onSubmit([option.value.label])
          return true
        }
      }
      submitAnswer()
      return true
    }
    // Typed text is a free answer from any row; an erase key edits it.
    const edit = lineEdit(e)
    if (Option.isSome(edit)) {
      setFreeformText(edit.value)
      return true
    }
    const typed = typedKey(e)
    if (Option.isNone(typed)) return false
    focusFreeform()
    setFreeformText((current) => current + typed.value)
    return true
  }

  const submitAnswer = () => {
    const selections: string[] = [...selected()]
    const freeform = freeformText().trim()
    if (freeform.length > 0) {
      selections.push(freeform)
    }
    if (selections.length === 0 && focusIndex() < options().length) {
      const option = Option.fromNullishOr(options()[focusIndex()])
      if (Option.isSome(option)) {
        selections.push(option.value.label)
      }
    }
    // An empty Other row with nothing picked answers nothing; Esc declines.
    if (selections.length === 0) return
    props.onSubmit(selections)
  }

  const isSelected = (label: string) => selected().has(label)
  const isFocused = (index: number) => focusIndex() === index
  const isFreeformFocused = () => focusIndex() === options().length
  const optionMarker = (label: string): string => {
    if (isMultiple()) {
      if (isSelected(label)) return "[x] "
      return "[ ] "
    }
    if (isSelected(label)) return "(+) "
    return "( ) "
  }
  const optionColor = (index: number) => {
    if (isFocused(index)) return theme.primary
    return theme.text
  }
  const optionPrefix = (index: number) => {
    if (isFocused(index)) return "> "
    return "  "
  }
  const freeformColor = () => {
    if (isFreeformFocused()) return theme.primary
    return theme.textMuted
  }
  const freeformPrefix = () => {
    if (isFreeformFocused()) return "> "
    return "  "
  }
  // The docked panes' key vocabulary. Enter picks the focused option of a
  // single choice; a multiple choice toggles with space and sends with Enter.
  // Esc declines the ask, so it says cancel, not close. PgUp/PgDn scroll the
  // choices when they overflow, else the question; with both too long, Shift
  // turns them to the question.
  const footer = () => {
    let keys = [KeyHints.move, KeyHints.select]
    if (isMultiple()) keys = [KeyHints.move, keyHint("space", "toggle"), KeyHints.submit]
    if (optionsScrollable() || documentScrollable()) keys.push(keyHint("pgup/pgdn", "scroll"))
    if (optionsScrollable() && documentScrollable()) {
      keys.push(keyHint("shift+pgup/pgdn", "scroll question"))
    }
    return keyHintsLine([...keys, KeyHints.cancel], dimensions().width - 2)
  }

  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingTop={sectionSpacing()}
      paddingBottom={sectionSpacing()}
    >
      <scrollbox
        ref={(value) => {
          documentViewport = Option.some(value)
        }}
        height={Math.min(documentHeight(), documentRows())}
        flexShrink={0}
        overflow="hidden"
        viewportOptions={{ overflow: "scroll" }}
        contentOptions={{ minHeight: 0 }}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
        focusable={false}
      >
        <box
          flexDirection="column"
          flexShrink={0}
          onSizeChange={function () {
            setDocumentHeight(this.height)
          }}
        >
          <Show
            when={Option.exists(Option.fromNullishOr(props.header), (header) => header.length > 0)}
          >
            <text style={{ fg: theme.textMuted }}>
              <b>
                {props.header}
                {Option.match(Option.fromNullishOr(props.progress), {
                  onNone: () => "",
                  onSome: (progress) => ` ${progress}`,
                })}
              </b>
            </text>
          </Show>

          <text style={{ fg: theme.text }}>{props.question}</text>

          <Show when={Option.getOrUndefined(Option.fromNullishOr(props.markdown))} keyed>
            {(markdown) => (
              <box marginTop={1} paddingRight={1}>
                <markdown
                  syntaxStyle={markdownSyntaxStyle}
                  content={markdown}
                  internalBlockMode="top-level"
                />
              </box>
            )}
          </Show>
        </box>
      </scrollbox>
      <box flexDirection="column" flexShrink={0}>
        <Show when={hasOptions()}>
          <scrollbox
            ref={(value) => {
              optionsViewport = Option.some(value)
            }}
            height={optionsRows()}
            marginTop={sectionSpacing()}
            flexShrink={0}
            overflow="hidden"
            viewportOptions={{ overflow: "scroll" }}
            contentOptions={{ minHeight: 0 }}
            verticalScrollbarOptions={{ visible: false }}
            horizontalScrollbarOptions={{ visible: false }}
            focusable={false}
          >
            <box
              flexDirection="column"
              flexShrink={0}
              onSizeChange={function () {
                setOptionsHeight(this.height)
              }}
            >
              <For each={options()}>
                {(opt, idx) => (
                  <box id={`${optionId}-${idx()}`} flexDirection="column">
                    <text style={{ fg: optionColor(idx()) }}>
                      {optionPrefix(idx())}
                      {optionMarker(opt.label)}
                      {opt.label}
                      <Show
                        when={Option.exists(
                          Option.fromNullishOr(opt.description),
                          (description) => description.length > 0,
                        )}
                      >
                        <span style={{ fg: theme.textMuted }}> - {opt.description}</span>
                      </Show>
                    </text>
                  </box>
                )}
              </For>
            </box>
          </scrollbox>
        </Show>

        <box
          flexDirection="column"
          flexShrink={0}
          onSizeChange={function () {
            setControlsChromeHeight(this.height)
          }}
        >
          <text wrapMode="none" marginTop={sectionSpacing()} style={{ fg: freeformColor() }}>
            {freeformPrefix()}Other: <span style={{ fg: theme.text }}>{freeformText()}</span>
            <Show when={isFreeformFocused()}>
              <span style={{ fg: theme.primary }}>│</span>
            </Show>
          </text>

          <Show when={!framed}>
            <text style={{ fg: theme.textMuted, marginTop: sectionSpacing() }}>{footer()}</text>
          </Show>
        </box>
      </box>
    </box>
  )
}

// ── yes/no answer ───────────────────────────────────────────────────────────

type InteractionAnswer = Parameters<InteractionRendererProps["resolve"]>[0]

/** The first choice, lower-cased; none when nothing was chosen. */
const firstChoice = (selections: readonly string[]): Option.Option<string> =>
  Option.map(Option.fromNullishOr(selections[0]), (value) => value.toLowerCase())

/**
 * A yes/no pick: approved only on "yes". The first selection that is none of
 * the list's own labels is free text the reader typed, and it goes as notes.
 */
export const yesNoAnswer = (
  selections: readonly string[],
  labels: readonly string[],
): InteractionAnswer => {
  const approved = Option.contains(firstChoice(selections), "yes")
  const notes = Option.fromNullishOr(
    selections.find((value) => !labels.includes(value.toLowerCase())),
  )
  return Option.match(notes, {
    onNone: () => ({ approved }),
    onSome: (value) => ({ approved, notes: value }),
  })
}

// ── prompt renderer ─────────────────────────────────────────────────────────

const decodePromptMetadata = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("prompt"),
    mode: Schema.optional(Schema.Literals(["present", "confirm", "review"])),
    title: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
  }),
)

export function PromptRenderer(props: InteractionRendererProps) {
  const renderer = useRenderer()
  const env = useEnv()
  const runtime = useRuntime()
  const { theme } = useTheme()
  const [editing, setEditing] = createSignal(false)
  const [editorError, setEditorError] = createSignal("")
  const meta = () => decodePromptMetadata(props.event.metadata)
  const mode = () =>
    Option.getOrElse(
      Option.flatMap(meta(), (value) => Option.fromNullishOr(value.mode)),
      () => "confirm",
    )
  const title = () =>
    Option.getOrElse(
      Option.flatMap(meta(), (value) => Option.fromNullishOr(value.title)),
      () => "Prompt",
    )

  createEffect(() => {
    if (!editing()) return
    runtime.call(
      openExternalEditor(
        props.event.text,
        () => renderer.suspend(),
        () => renderer.resume(),
        resolveEditor(env.visual, env.editor),
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result._tag === "applied") {
              props.resolve({ approved: true, notes: "edit", editedContent: result.content })
            } else if (result._tag === "error") {
              setEditorError(result.message)
            }
            setEditing(false)
          }),
        ),
      ),
    )
  })

  const options = () => {
    if (mode() === "review") {
      return [{ label: "Yes" }, { label: "No" }, { label: "Edit" }]
    }
    return [{ label: "Yes" }, { label: "No" }]
  }

  return (
    <>
      <Show when={editorError().length > 0}>
        <text style={{ fg: theme.error }}>{editorError()}</text>
      </Show>
      <Show
        when={!editing()}
        fallback={<text style={{ fg: theme.textMuted }}>Opening editor…</text>}
      >
        <OptionList
          header={title()}
          question={props.event.text}
          options={options()}
          onSubmit={(selections) => {
            if (Option.contains(firstChoice(selections), "edit") && mode() === "review") {
              setEditorError("")
              setEditing(true)
              return
            }
            props.resolve(yesNoAnswer(selections, ["yes", "no", "edit"]))
          }}
          onCancel={() => props.resolve({ approved: false })}
        />
      </Show>
    </>
  )
}

// ── handoff renderer ────────────────────────────────────────────────────────

/** Confirms a handoff. A confirmed one opens the new session seeded with the summary. */
export function HandoffRenderer(props: InteractionRendererProps) {
  const client = useClient()
  const resolve = (result: InteractionAnswer) => {
    props.resolve(result)
    if (!result.approved) return
    // `openHandoffSession` activates the new session on the client, and the
    // shell mounts whatever that says. Nothing left to navigate.
    client.openHandoffSession(props.event.text)
  }
  return (
    <OptionList
      header="Handoff"
      question={props.event.text}
      options={[{ label: "Yes" }, { label: "No" }]}
      onSubmit={(selections) => resolve(yesNoAnswer(selections, ["yes", "no"]))}
      onCancel={() => resolve({ approved: false })}
    />
  )
}
