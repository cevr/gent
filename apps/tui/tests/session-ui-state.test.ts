import { describe, expect, test } from "bun:test"
import { nextDisclosure, SessionUiState, transitionSessionUi } from "../src/routes/session-ui-state"

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
