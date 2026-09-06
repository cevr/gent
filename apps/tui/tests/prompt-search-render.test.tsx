/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { PromptSearchPalette } from "../src/components/prompt-search-palette"
import {
  PromptSearchState,
  transitionPromptSearch,
  type PromptSearchEvent,
} from "../src/components/prompt-search-state"
import { renderFrame, renderWithProviders } from "./render-harness-boundary"
const buildOpenState = (draftBeforeOpen: string, entries: readonly string[]) => {
  let state = PromptSearchState.open(draftBeforeOpen)
  for (const event of [
    { _tag: "TypeChar", char: "f" },
    { _tag: "TypeChar", char: "i" },
    { _tag: "TypeChar", char: "x" },
    { _tag: "MoveDown" },
  ] satisfies ReadonlyArray<PromptSearchEvent>) {
    state = transitionPromptSearch(state, event, entries).state
  }
  return state
}
describe("PromptSearchPalette renderer", () => {
  it.live("renders matching prompts with selection and footer", () =>
    Effect.gen(function* () {
      const entries = [
        "fix the session queue bug",
        "fix prompt search enter behavior",
        "add tests for renderer",
      ]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <PromptSearchPalette
              state={buildOpenState("draft", entries)}
              entries={entries}
              onEvent={() => {}}
            />
          ),
          { width: 90, height: 28 },
        ),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("Prompt Search")
      expect(frame).toContain("› fix")
      expect(frame).toContain("fix prompt search enter behavior")
      expect(frame).toContain("Type | Up/Down | Enter | Esc")
    }),
  )
  it.live("renders empty-state fallback when no items match", () =>
    Effect.gen(function* () {
      const entries = ["first prompt", "second prompt"]
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
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
        ),
      )
      expect(renderFrame(setup)).toContain("No prompt matches")
    }),
  )
})
