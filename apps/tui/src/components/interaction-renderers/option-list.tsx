/**
 * Shared option-list UI for interaction renderers.
 * Renders a question with options, optional markdown, freeform input, and keyboard navigation.
 */

/** @jsxImportSource @opentui/solid */

import { createSignal, Show, For, type JSX } from "solid-js"
import { SyntaxStyle } from "@opentui/core"
import { Option } from "effect"
import type { QuestionOption } from "@gent/core-internal/domain/event.js"
import { useTheme } from "../../theme/index"
import { useScopedKeyboard } from "../../keyboard/context"

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

  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [freeformText, setFreeformText] = createSignal("")
  const [focusIndex, setFocusIndex] = createSignal(0)

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

  useScopedKeyboard((e) => {
    if (e.name === "escape") {
      props.onCancel()
      return true
    }
    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      setFocusIndex((index) => (index - 1 + focusableCount()) % focusableCount())
      return true
    }
    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      setFocusIndex((index) => (index + 1) % focusableCount())
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
  const footer = () => {
    if (isMultiple()) return "up/down navigate - space select - enter submit - esc cancel"
    return "up/down navigate - space/enter select - esc cancel"
  }

  return (
    <box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Show when={Option.exists(Option.fromNullishOr(props.header), (header) => header.length > 0)}>
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

      <Show when={hasOptions()}>
        <box flexDirection="column" marginTop={1}>
          <For each={options()}>
            {(opt, idx) => (
              <box flexDirection="row">
                <text style={{ fg: optionColor(idx()) }}>
                  {optionPrefix(idx())}
                  {optionMarker(opt.label)}
                  {opt.label}
                </text>
                <Show
                  when={Option.exists(
                    Option.fromNullishOr(opt.description),
                    (description) => description.length > 0,
                  )}
                >
                  <text style={{ fg: theme.textMuted }}> - {opt.description}</text>
                </Show>
              </box>
            )}
          </For>
        </box>
      </Show>

      <box flexDirection="row" marginTop={1}>
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

      <text style={{ fg: theme.textMuted, marginTop: 1 }}>{footer()}</text>
    </box>
  )
}
