import { describe, expect, test } from "bun:test"
import { HomeState, transitionHome } from "../src/routes/home-state"

describe("transitionHome", () => {
  test("opens prompt search without previewing immediately", () => {
    const result = transitionHome(HomeState.idle(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "draft" },
      entries: ["older prompt"],
    })

    expect(result.state.promptSearch).toEqual({
      _tag: "open",
      draftBeforeOpen: "draft",
      query: "",
      selectedIndex: 0,
      hasInteracted: false,
    })
    expect(result.effects).toEqual([])
  })

  test("creates a session when submitting a prompt", () => {
    const result = transitionHome(HomeState.idle(true), {
      _tag: "SubmitPrompt",
      prompt: "ship it",
    })

    expect(result.state).toEqual(HomeState.pending("ship it", true, { _tag: "closed" }))
    expect(result.effects).toEqual([{ _tag: "CreateSession" }])
  })

  test("navigates when pending session activates", () => {
    const state = HomeState.pending("ship it", false, { _tag: "closed" })
    const result = transitionHome(state, {
      _tag: "SessionActivated",
      sessionId: "session_123" as never,
      branchId: "branch_123" as never,
    })

    expect(result.state).toEqual(HomeState.idle(false, { _tag: "closed" }))
    expect(result.effects).toEqual([
      {
        _tag: "NavigateToSession",
        sessionId: "session_123",
        branchId: "branch_123",
        prompt: "ship it",
      },
    ])
  })
})
