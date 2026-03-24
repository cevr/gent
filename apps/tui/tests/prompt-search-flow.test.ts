import { describe, expect, test } from "bun:test"
import { PromptSearchState } from "../src/components/prompt-search-state"
import { transitionPromptSearchRoute } from "../src/routes/prompt-search-flow"

describe("transitionPromptSearchRoute", () => {
  test("opens without preview effects", () => {
    const result = transitionPromptSearchRoute(
      PromptSearchState.closed(),
      { _tag: "Open", draftBeforeOpen: "draft" },
      ["older prompt"],
    )

    expect(result.state).toEqual(PromptSearchState.open("draft"))
    expect(result.effects).toEqual([])
  })

  test("maps preview effects to restore-composer effects", () => {
    const opened = PromptSearchState.open("draft")
    const result = transitionPromptSearchRoute(opened, { _tag: "MoveDown" }, [
      "older prompt",
      "newer prompt",
    ])

    expect(result.effects).toEqual([{ _tag: "RestoreComposer", text: "newer prompt" }])
  })
})
