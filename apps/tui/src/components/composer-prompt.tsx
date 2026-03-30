/**
 * Fallback interaction renderer — temporary bridge until Batch 8 replaces
 * this with per-tag builtin extension renderers.
 *
 * Converts raw ActiveInteraction events back to Question-shaped options
 * for the existing option-list UI.
 */

import { createSignal, Show, For } from "solid-js"
import { SyntaxStyle } from "@opentui/core"
import type {
  ActiveInteraction,
  InteractionEventTag,
  InteractionResolutionByTag,
  Question,
} from "@gent/core/domain/event.js"
import { useTheme } from "../theme/index"
import { useScopedKeyboard } from "../keyboard/context"

const markdownSyntaxStyle = SyntaxStyle.create()

interface ComposerPromptProps {
  interaction: ActiveInteraction
  onResolve: (
    tag: InteractionEventTag,
    result: InteractionResolutionByTag[InteractionEventTag],
  ) => void
  onCancel: () => void
}

// Convert interaction events to the Question shape for rendering

function interactionToQuestion(interaction: ActiveInteraction): Question {
  switch (interaction._tag) {
    case "QuestionsAsked":
      // For multi-question, just show the first one (old behavior)
      return interaction.questions[0] ?? { question: "" }
    case "PermissionRequested": {
      const summary = summarizeInput(interaction.input)
      const question =
        summary.length > 0
          ? `Allow ${interaction.toolName} (${summary})?`
          : `Allow ${interaction.toolName}?`
      return {
        question,
        header: "Permission",
        options: [
          { label: "Allow" },
          { label: "Always Allow" },
          { label: "Deny" },
          { label: "Always Deny" },
        ],
        multiple: false,
      }
    }
    case "PromptPresented": {
      const title =
        interaction.title ??
        (interaction.path !== undefined ? `Review: ${interaction.path}` : "Review")
      const options =
        interaction.mode === "review"
          ? [{ label: "Yes" }, { label: "No" }, { label: "Edit" }]
          : [{ label: "Yes" }, { label: "No" }]
      return {
        question: title,
        header: "Prompt",
        ...(interaction.content !== undefined && interaction.content.length > 0
          ? { markdown: interaction.content }
          : {}),
        options,
        multiple: false,
      }
    }
    case "HandoffPresented": {
      const reason =
        interaction.reason !== undefined && interaction.reason.length > 0
          ? ` (${interaction.reason})`
          : ""
      const summary =
        interaction.summary.length > 200
          ? interaction.summary.slice(0, 200) + "..."
          : interaction.summary
      return {
        question: `Handoff to new session?${reason}`,
        header: "Handoff",
        markdown: summary,
        options: [{ label: "Yes" }, { label: "No" }],
        multiple: false,
      }
    }
  }
}

function selectionsToResolution(
  interaction: ActiveInteraction,
  selections: readonly string[],
): { tag: InteractionEventTag; result: InteractionResolutionByTag[InteractionEventTag] } {
  switch (interaction._tag) {
    case "QuestionsAsked":
      return {
        tag: "QuestionsAsked",
        result: { _tag: "answered", answers: [selections] },
      }
    case "PermissionRequested": {
      const sel = selections[0]?.toLowerCase() ?? "deny"
      if (sel === "always allow")
        return { tag: "PermissionRequested", result: { _tag: "allow", persist: true } }
      if (sel === "always deny")
        return { tag: "PermissionRequested", result: { _tag: "deny", persist: true } }
      if (sel === "allow")
        return { tag: "PermissionRequested", result: { _tag: "allow", persist: false } }
      return { tag: "PermissionRequested", result: { _tag: "deny", persist: false } }
    }
    case "PromptPresented": {
      const sel = selections[0]?.toLowerCase() ?? "no"
      if (sel === "yes") return { tag: "PromptPresented", result: { _tag: "yes" } }
      if (sel === "edit") return { tag: "PromptPresented", result: { _tag: "edit" } }
      return { tag: "PromptPresented", result: { _tag: "no" } }
    }
    case "HandoffPresented": {
      const sel = selections[0]?.toLowerCase() ?? "no"
      if (sel === "yes") return { tag: "HandoffPresented", result: { _tag: "confirm" } }
      return { tag: "HandoffPresented", result: { _tag: "reject" } }
    }
  }
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return ""
  const raw = typeof input === "string" ? input : JSON.stringify(input)
  return raw.length > 120 ? raw.slice(0, 120) + "..." : raw
}

export function ComposerPrompt(props: ComposerPromptProps) {
  const { theme } = useTheme()
  const question = () => interactionToQuestion(props.interaction)

  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [freeformText, setFreeformText] = createSignal("")
  const [focusIndex, setFocusIndex] = createSignal(0)

  const options = () => question().options ?? []
  const hasOptions = () => options().length > 0
  const isMultiple = () => question().multiple === true
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
    const { tag, result } = selectionsToResolution(props.interaction, selections)
    props.onResolve(tag, result)
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
      <Show when={question().header !== undefined && (question().header?.length ?? 0) > 0}>
        <text style={{ fg: theme.textMuted }}>
          <b>{question().header}</b>
        </text>
      </Show>

      <text style={{ fg: theme.text }}>{question().question}</text>

      <Show when={question().markdown} keyed>
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
          ? "↑↓ navigate • space select • enter submit • esc cancel"
          : "↑↓ navigate • space/enter select • esc cancel"}
      </text>
    </box>
  )
}
