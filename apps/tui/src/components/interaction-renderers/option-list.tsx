/**
 * Shared option-list UI for interaction renderers.
 * Renders a question with options, optional markdown, freeform input, and keyboard navigation.
 */

/** @jsxImportSource @opentui/solid */

import { createSignal, createUniqueId, Show, For, type JSX } from "solid-js"
import { SyntaxStyle, type ScrollBoxRenderable } from "@opentui/core"
import { Option } from "effect"
import type { QuestionOption } from "@gent/core-internal/domain/event.js"
import { useTheme } from "../../theme/index"
import { useScopedKeyboard } from "../../keyboard/context"
import { useTerminalDimensions } from "../../terminal-dimensions"
import { textWidth } from "../../platform/text-width-adapter"

const markdownSyntaxStyle = SyntaxStyle.create()

export interface OptionListProps {
  readonly header?: string
  readonly question: string
  readonly markdown?: string
  readonly options?: readonly QuestionOption[]
  readonly multiple?: boolean
  readonly progress?: string
  readonly onSubmit: (selections: readonly string[]) => void
  readonly onCancel: () => void
}

export function OptionList(props: OptionListProps): JSX.Element {
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
