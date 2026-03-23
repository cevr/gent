import { createSignal, Show, For } from "solid-js"
import { SyntaxStyle } from "@opentui/core"
import type { Question } from "@gent/core/domain/event.js"
import { useTheme } from "../theme/index"
import { useScopedKeyboard } from "../keyboard/context"

const markdownSyntaxStyle = SyntaxStyle.create()

interface ComposerPromptProps {
  question: Question
  onSubmit: (selections: readonly string[]) => void
}

export function ComposerPrompt(props: ComposerPromptProps) {
  const { theme } = useTheme()

  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [freeformText, setFreeformText] = createSignal("")
  const [focusIndex, setFocusIndex] = createSignal(0)

  const options = () => props.question.options ?? []
  const hasOptions = () => options().length > 0
  const isMultiple = () => props.question.multiple === true
  const focusableCount = () => options().length + 1

  useScopedKeyboard((e) => {
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
    return isSelected(label) ? "(•) " : "( ) "
  }

  return (
    <box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1}>
      <Show when={props.question.header !== undefined && props.question.header.length > 0}>
        <text style={{ fg: theme.textMuted }}>
          <b>{props.question.header}</b>
        </text>
      </Show>

      <text style={{ fg: theme.text }}>{props.question.question}</text>

      <Show when={props.question.markdown} keyed>
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
                  {isFocused(idx()) ? "❯ " : "  "}
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

      <text style={{ fg: theme.textMuted, marginTop: 1 }}>
        {isMultiple()
          ? "↑↓ navigate • space select • enter submit"
          : "↑↓ navigate • space/enter select"}
      </text>
    </box>
  )
}
