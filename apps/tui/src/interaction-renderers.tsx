/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, createUniqueId, For, type JSX, Show } from "solid-js"
import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core"
import { Effect, Option, Schema } from "effect"
import { type QuestionOption, QuestionSchema } from "@gent/core/protocol"
import { useTheme } from "./theme"
import { useScopedKeyboard, useTerminalDimensions } from "./terminal"
import { textWidth } from "./text-width-adapter"
import type { InteractionRendererProps } from "./extensions/client-facets.js"
import { useRenderer } from "@opentui/solid"
import { useEnv } from "./workspace"
import { useClient, useRuntime } from "./client"
import { openExternalEditor, resolveEditor } from "./os"

// ── option list ─────────────────────────────────────────────────────────────

/**
 * Shared option-list UI for interaction renderers.
 * Renders a question with options, optional markdown, freeform input, and keyboard navigation.
 */

const markdownSyntaxStyle = SyntaxStyle.create()

interface OptionListProps {
  readonly header?: string
  readonly question: string
  readonly markdown?: string
  readonly options?: readonly QuestionOption[]
  readonly multiple?: boolean
  readonly progress?: string
  readonly onSubmit: (selections: readonly string[]) => void
  readonly onCancel: () => void
}

function OptionList(props: OptionListProps): JSX.Element {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [freeformText, setFreeformText] = createSignal("")
  const [focusIndex, setFocusIndex] = createSignal(0)
  const [documentHeight, setDocumentHeight] = createSignal(1)
  const [controlsChromeHeight, setControlsChromeHeight] = createSignal(0)
  const [optionsHeight, setOptionsHeight] = createSignal(0)
  const optionId = createUniqueId()
  let documentViewport: Option.Option<ScrollBoxRenderable> = Option.none()
  let optionsViewport: Option.Option<ScrollBoxRenderable> = Option.none()
  const sectionSpacing = () => {
    if (dimensions().height < 18) return 0
    return 1
  }
  const contentRows = () =>
    Math.max(2, dimensions().height - controlsChromeHeight() - 4 - sectionSpacing() * 3)
  const optionsRows = () => Math.min(optionsHeight(), Math.max(1, Math.floor(contentRows() / 2)))
  const optionsScrollable = () => optionsHeight() > optionsRows()
  // Reserve the answer controls, panel padding, composer status, and one transcript row.
  const documentRows = () => Math.max(1, contentRows() - optionsRows())
  const documentScrollable = () => documentHeight() > documentRows()

  const options = () => Option.getOrElse(Option.fromNullishOr(props.options), () => [])
  const hasOptions = () => options().length > 0
  const isMultiple = () => props.multiple === true
  const focusableCount = () => options().length + 1

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

  useScopedKeyboard((e) => {
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
    return false
  })

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
    if (selections.length === 0) {
      selections.push("Other")
    }
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
  const compactSelectionHint = () => {
    if (isMultiple()) return "Space select"
    return "↑↓ move"
  }
  const footer = () => {
    const hints = [
      "↑↓ move · Space select · Enter submit · Esc cancel",
      `${compactSelectionHint()} · Enter submit · Esc cancel`,
    ]
    return (
      hints.find((hint) => textWidth(hint) <= dimensions().width - 2) ?? "Enter submit · Esc cancel"
    )
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
                <markdown syntaxStyle={markdownSyntaxStyle} content={markdown} />
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
          <box flexDirection="row" marginTop={sectionSpacing()}>
            <text style={{ fg: freeformColor() }}>{freeformPrefix()}Other: </text>
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

          <text style={{ fg: theme.textMuted, marginTop: sectionSpacing() }}>{footer()}</text>
          <Show when={optionsScrollable()}>
            <text style={{ fg: theme.textMuted }}>PgUp/PgDn scroll choices</text>
          </Show>
          <Show when={documentScrollable()}>
            <text style={{ fg: theme.textMuted }}>
              <Show when={optionsScrollable()}>Shift+</Show>PgUp/PgDn scroll question
            </text>
          </Show>
        </box>
      </box>
    </box>
  )
}

// ── ask user renderer ───────────────────────────────────────────────────────

const decodeAskUserMetadata = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("ask-user"), questions: Schema.Array(QuestionSchema) }),
)
const encodeAnswers = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))),
)

type AskUserMetadata = InteractionRendererProps["event"]["metadata"]
const parseAskUserMetadata = (metadata: AskUserMetadata) => decodeAskUserMetadata(metadata)

export function AskUserRenderer(props: InteractionRendererProps) {
  const meta = () => parseAskUserMetadata(props.event.metadata)
  const questions = () =>
    Option.getOrElse(
      Option.map(meta(), (metadata) => metadata.questions),
      () => [],
    )
  const [questionIndex, setQuestionIndex] = createSignal(0)
  const [answers, setAnswers] = createSignal<string[][]>([])

  const currentQuestion = () => Option.fromNullishOr(questions()[questionIndex()])

  const handleSubmit = (selections: readonly string[]) => {
    const nextAnswers = [...answers(), [...selections]]
    setAnswers(nextAnswers)

    if (questionIndex() < questions().length - 1) {
      setQuestionIndex((i) => i + 1)
    } else {
      // All questions answered — encode as JSON for structured roundtrip
      props.resolve({ approved: true, notes: encodeAnswers(nextAnswers) })
    }
  }

  const progress = () => {
    if (questions().length <= 1) return Option.none<string>()
    return Option.some(`(${questionIndex() + 1}/${questions().length})`)
  }

  return (
    <Show
      when={Option.getOrUndefined(currentQuestion())}
      keyed
      fallback={
        <OptionList
          header="Question"
          question={props.event.text}
          options={[{ label: "Yes" }, { label: "No" }]}
          onSubmit={(selections) => {
            const selection = Option.map(Option.fromNullishOr(selections[0]), (value) =>
              value.toLowerCase(),
            )
            const selected = Option.getOrElse(selection, () => "no")
            const freeform = Option.fromNullishOr(
              selections.find((value) => !["yes", "no"].includes(value.toLowerCase())),
            )
            if (Option.isSome(freeform)) {
              props.resolve({ approved: selected === "yes", notes: freeform.value })
              return
            }
            props.resolve({ approved: selected === "yes" })
          }}
          onCancel={() => props.resolve({ approved: false })}
        />
      }
    >
      {(q) => (
        <OptionList
          header={q.header}
          question={q.question}
          markdown={q.markdown}
          options={Option.getOrUndefined(
            Option.map(Option.fromNullishOr(q.options), (options) => [...options]),
          )}
          multiple={q.multiple}
          progress={Option.getOrUndefined(progress())}
          onSubmit={handleSubmit}
          onCancel={() => props.resolve({ approved: false })}
        />
      )}
    </Show>
  )
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

type PromptMetadata = InteractionRendererProps["event"]["metadata"]
const parsePromptMetadata = (metadata: PromptMetadata) =>
  Option.getOrUndefined(decodePromptMetadata(metadata))

export function PromptRenderer(props: InteractionRendererProps) {
  const renderer = useRenderer()
  const env = useEnv()
  const runtime = useRuntime()
  const { theme } = useTheme()
  const [editing, setEditing] = createSignal(false)
  const [editorError, setEditorError] = createSignal("")
  const meta = () => parsePromptMetadata(props.event.metadata)
  const mode = () => meta()?.mode ?? "confirm"
  const title = () => meta()?.title

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
          header={title() ?? "Prompt"}
          question={props.event.text}
          options={options()}
          onSubmit={(selections) => {
            const sel = Option.fromNullishOr(selections[0]).pipe(
              Option.map((value) => value.toLowerCase()),
              Option.getOrElse(() => "no"),
            )
            if (sel === "edit" && mode() === "review") {
              setEditorError("")
              setEditing(true)
              return
            }
            const freeform = Option.fromNullishOr(
              selections.find((value) => !["yes", "no", "edit"].includes(value.toLowerCase())),
            )
            if (Option.isSome(freeform)) {
              props.resolve({ approved: sel === "yes", notes: freeform.value })
              return
            }
            props.resolve({ approved: sel === "yes" })
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
  const resolve = (result: Parameters<InteractionRendererProps["resolve"]>[0]) => {
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
      onSubmit={(selections) => {
        const sel = Option.fromNullishOr(selections[0]).pipe(
          Option.map((value) => value.toLowerCase()),
          Option.getOrElse(() => "no"),
        )
        const freeform = Option.fromNullishOr(
          selections.find((value) => !["yes", "no"].includes(value.toLowerCase())),
        )
        if (Option.isSome(freeform)) {
          resolve({ approved: sel === "yes", notes: freeform.value })
          return
        }
        resolve({ approved: sel === "yes" })
      }}
      onCancel={() => resolve({ approved: false })}
    />
  )
}
