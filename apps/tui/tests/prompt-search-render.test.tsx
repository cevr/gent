/** @jsxImportSource @opentui/solid */

import { describe, test, expect } from "bun:test"
import { PromptSearchPalette } from "../src/components/prompt-search-palette"
import { PromptSearchState, transitionPromptSearch } from "../src/components/prompt-search-state"
import { renderFrame, renderWithProviders } from "./render-harness"

const buildOpenState = (draftBeforeOpen: string, entries: readonly string[]) => {
  let state = PromptSearchState.open(draftBeforeOpen)
  for (const event of [
    { _tag: "TypeChar", char: "f" } as const,
    { _tag: "TypeChar", char: "i" } as const,
    { _tag: "TypeChar", char: "x" } as const,
    { _tag: "MoveDown" } as const,
  ]) {
    state = transitionPromptSearch(state, event, entries).state
  }
  return state
}

describe("PromptSearchPalette renderer", () => {
  test("renders matching prompts with selection and footer", async () => {
    const entries = [
      "fix the session queue bug",
      "fix prompt search enter behavior",
      "add tests for renderer",
    ] as const
    const setup = await renderWithProviders(
      () => (
        <PromptSearchPalette
          state={buildOpenState("draft", entries)}
          entries={entries}
          onEvent={() => {}}
        />
      ),
      { width: 90, height: 28 },
    )

    const frame = renderFrame(setup)
    expect(frame).toContain("Prompt Search")
    expect(frame).toContain("› fix")
    expect(frame).toContain("fix prompt search enter behavior")
    expect(frame).toContain("Type | Up/Down | Enter | Esc")
  })

  test("renders empty-state fallback when no items match", async () => {
    const entries = ["first prompt", "second prompt"] as const
    const openState = transitionPromptSearch(
      PromptSearchState.open("draft"),
      { _tag: "TypeChar", char: "z" },
      entries,
    ).state
    const noMatchState = transitionPromptSearch(
      openState,
      { _tag: "TypeChar", char: "z" },
      entries,
    ).state
    const setup = await renderWithProviders(
      () => (
        <PromptSearchPalette
          state={
            transitionPromptSearch(noMatchState, { _tag: "TypeChar", char: "z" }, entries).state
          }
          entries={entries}
          onEvent={() => {}}
        />
      ),
      { width: 80, height: 24 },
    )

    expect(renderFrame(setup)).toContain("No prompt matches")
  })
})
