import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { nextDisclosure, SessionUiState, transitionSessionUi } from "../src/session"

describe("transcript disclosure", () => {
  test("a fresh session starts collapsed", () => {
    expect(SessionUiState.initial().disclosure).toBe("collapsed")
  })

  test("ctrl+o walks collapsed, preview, full, then wraps", () => {
    expect(nextDisclosure("collapsed")).toBe("preview")
    expect(nextDisclosure("preview")).toBe("full")
    expect(nextDisclosure("full")).toBe("collapsed")
    const once = transitionSessionUi(SessionUiState.initial(), { _tag: "CycleDisclosure" })
    const twice = transitionSessionUi(once.state, { _tag: "CycleDisclosure" })
    expect(once.state.disclosure).toBe("preview")
    expect(twice.state.disclosure).toBe("full")
  })

  test("escape returns any level to collapsed without touching the transcript view", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), { _tag: "ToggleTranscript" })
    const full = transitionSessionUi(
      transitionSessionUi(opened.state, { _tag: "CycleDisclosure" }).state,
      { _tag: "CycleDisclosure" },
    )
    const collapsed = transitionSessionUi(full.state, { _tag: "CollapseDisclosure" })
    expect(collapsed.state.disclosure).toBe("collapsed")
    expect(collapsed.state.transcriptExpanded).toBe(true)
  })

  test("clearing the display keeps the chosen level", () => {
    const preview = transitionSessionUi(SessionUiState.initial(), { _tag: "CycleDisclosure" })
    const cleared = transitionSessionUi(preview.state, { _tag: "ClearDisplay" })
    expect(cleared.state.disclosure).toBe("preview")
  })
})

describe("settings picker overlay", () => {
  test("/model and /think open their pane and escape closes it", () => {
    const model = transitionSessionUi(SessionUiState.initial(), {
      _tag: "OpenSettingsPicker",
      picker: "model",
    })
    expect(model.state.overlay).toEqual({ _tag: "model" })
    const reasoning = transitionSessionUi(model.state, {
      _tag: "OpenSettingsPicker",
      picker: "reasoning",
    })
    expect(reasoning.state.overlay).toEqual({ _tag: "reasoning" })
    const closed = transitionSessionUi(reasoning.state, { _tag: "CloseOverlay" })
    expect(closed.state.overlay).toEqual({ _tag: "none" })
  })
})

describe("prompt search overlay", () => {
  test("opening docks the palette over the draft", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "draft" },
    })
    expect(opened.state.overlay).toEqual({
      _tag: "prompt-search",
      state: { _tag: "open", draftBeforeOpen: "draft", highlighted: Option.none() },
    })
    expect(opened.effects).toEqual([])
  })

  test("accepting a highlighted entry restores it to the composer and closes the palette", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "draft" },
    })
    const moved = transitionSessionUi(opened.state, {
      _tag: "PromptSearch",
      event: { _tag: "Highlight", entry: Option.some("second") },
    })
    expect(moved.effects).toEqual([{ _tag: "RestoreComposer", text: "second" }])
    const accepted = transitionSessionUi(moved.state, {
      _tag: "PromptSearch",
      event: { _tag: "Accept" },
    })
    expect(accepted.state.overlay).toEqual({ _tag: "none" })
    expect(accepted.effects).toEqual([{ _tag: "RestoreComposer", text: "second" }])
  })

  test("a list that emptied previews the draft, and accepting before a move keeps it", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "draft" },
    })
    const emptied = transitionSessionUi(opened.state, {
      _tag: "PromptSearch",
      event: { _tag: "Highlight", entry: Option.none() },
    })
    expect(emptied.effects).toEqual([{ _tag: "RestoreComposer", text: "draft" }])
    const accepted = transitionSessionUi(opened.state, {
      _tag: "PromptSearch",
      event: { _tag: "Accept" },
    })
    expect(accepted.state.overlay).toEqual({ _tag: "none" })
    expect(accepted.effects).toEqual([{ _tag: "RestoreComposer", text: "draft" }])
  })

  test("cancelling restores the draft the palette opened over", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "draft" },
    })
    const cancelled = transitionSessionUi(opened.state, {
      _tag: "PromptSearch",
      event: { _tag: "Cancel" },
    })
    expect(cancelled.state.overlay).toEqual({ _tag: "none" })
    expect(cancelled.effects).toEqual([{ _tag: "RestoreComposer", text: "draft" }])
  })
})
