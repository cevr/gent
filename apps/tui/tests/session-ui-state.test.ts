import { describe, expect, test } from "bun:test"
import {
  SessionUiState,
  transitionSessionUi,
  getPromptSearchState,
} from "../src/routes/session-ui-state"

describe("transitionSessionUi", () => {
  test("toggles tool expansion", () => {
    const first = transitionSessionUi(SessionUiState.initial(), { _tag: "ToggleTools" })
    const second = transitionSessionUi(first.state, { _tag: "ToggleTools" })

    expect(first.state.toolsExpanded).toBe(true)
    expect(second.state.toolsExpanded).toBe(false)
  })

  test("opens prompt search and restores composer through effects", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "draft" },
      entries: ["older prompt"],
    })

    expect(getPromptSearchState(opened.state)).toEqual({
      _tag: "open",
      draftBeforeOpen: "draft",
      query: "",
      selectedIndex: 0,
      hasInteracted: false,
    })
    expect(opened.effects).toEqual([])

    const moved = transitionSessionUi(opened.state, {
      _tag: "PromptSearch",
      event: { _tag: "MoveDown" },
      entries: ["older prompt", "newer prompt"],
    })

    expect(moved.effects).toEqual([{ _tag: "RestoreComposer", text: "newer prompt" }])
  })

  test("closing prompt search clears overlay", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "draft" },
      entries: [],
    })
    const closed = transitionSessionUi(opened.state, {
      _tag: "PromptSearch",
      event: { _tag: "Cancel" },
      entries: [],
    })

    expect(closed.state.overlay).toEqual({ _tag: "none" })
    expect(closed.effects).toEqual([{ _tag: "RestoreComposer", text: "draft" }])
  })
})
