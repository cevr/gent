/** @jsxImportSource @opentui/solid */

import { describe, test, expect } from "bun:test"
import { PromptSearchPalette } from "../src/components/prompt-search-palette"
import { PromptSearchState } from "../src/components/prompt-search-state"
import { renderFrame, renderWithProviders } from "./render-harness"

describe("PromptSearchPalette renderer", () => {
  test("renders matching prompts with selection and footer", async () => {
    const setup = await renderWithProviders(
      () => (
        <PromptSearchPalette
          state={{
            ...PromptSearchState.open("draft"),
            query: "fix",
            selectedIndex: 1,
            hasInteracted: true,
          }}
          entries={[
            "fix the session queue bug",
            "fix prompt search enter behavior",
            "add tests for renderer",
          ]}
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
    const setup = await renderWithProviders(
      () => (
        <PromptSearchPalette
          state={{
            ...PromptSearchState.open("draft"),
            query: "zzz",
            selectedIndex: 0,
            hasInteracted: true,
          }}
          entries={["first prompt", "second prompt"]}
          onEvent={() => {}}
        />
      ),
      { width: 80, height: 24 },
    )

    expect(renderFrame(setup)).toContain("No prompt matches")
  })
})
