/**
 * Shared option-list UI for interaction renderers.
 * Renders a question with options, optional markdown, freeform input, and keyboard navigation.
 */

/** @jsxImportSource @opentui/solid */

import { createSignal, Show, For, type JSX } from "solid-js"
import { SyntaxStyle } from "@opentui/core"
import type { QuestionOption } from "@gent/core/domain/event.js"
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

  const options = () => props.options ?? []
  const hasOptions = () => options().length > 0
  const isMultiple = () => props.multiple === true
  const focusableCount = () => options().length + 1

  useScopedKeyboard((e) => {
    if (e.name === "escape") {
      props.onCancel()
      return true
    }
    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      setFocusIndex((i) => (i - 1 + focusableCount()) % focusableCount())
      return true
    }
    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      setFocusIndex((i) => (i + 1) % focusableCount())
      return true
    }

    if (e.name === "space" && focusIndex() < options().length) {
      const opt = options()[focusIndex()]
      if (opt === undefined) return true
      const label = opt.label

      if (isMultiple()) {
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
        setSelected(new Set([label]))
      }
      return true
    }

    if (e.name === "return") {
      // Single-select: Enter on a focused option selects + submits it
      if (!isMultiple() && focusIndex() < options().length) {
        const opt = options()[focusIndex()]
        if (opt !== undefined && selected().size === 0) {
          props.onSubmit([opt.label])
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
      const opt = options()[focusIndex()]
      if (opt !== undefined) {
        selections.push(opt.label)
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
      return isSelected(label) ? "[x] " : "[ ] "
    }
    return isSelected(label) ? "(+) " : "( ) "
  }

  return (
    <box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Show when={props.header !== undefined && props.header.length > 0}>
        <text style={{ fg: theme.textMuted }}>
          <b>
            {props.header}
            {props.progress !== undefined ? ` ${props.progress}` : ""}
          </b>
        </text>
      </Show>

      <text style={{ fg: theme.text }}>{props.question}</text>

      <Show when={props.markdown} keyed>
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
                <text style={{ fg: isFocused(idx()) ? theme.primary : theme.text }}>
                  {isFocused(idx()) ? "> " : "  "}
                  {optionMarker(opt.label)}
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

      <box flexDirection="row" marginTop={1}>
        <text style={{ fg: isFreeformFocused() ? theme.primary : theme.textMuted }}>
          {isFreeformFocused() ? "> " : "  "}Other:{" "}
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

      <text style={{ fg: theme.textMuted, marginTop: 1 }}>
        {isMultiple()
          ? "up/down navigate - space select - enter submit - esc cancel"
          : "up/down navigate - space/enter select - esc cancel"}
      </text>
    </box>
  )
}
