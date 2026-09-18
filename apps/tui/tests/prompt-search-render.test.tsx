/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Option } from "effect"
import { type PromptSearchEvent, PromptSearchPalette, PromptSearchState } from "../src/pickers"
import { renderFrame, renderWithProviders } from "./render-harness-boundary"
import { waitForRenderedFrame } from "./helpers-boundary"

const openPalette = (entries: readonly string[], onEvent: (event: PromptSearchEvent) => void) =>
  Effect.promise(() =>
    renderWithProviders(
      () => (
        <PromptSearchPalette
          state={PromptSearchState.open("draft")}
          entries={entries}
          onEvent={onEvent}
        />
      ),
      { width: 90, height: 28 },
    ),
  )

describe("PromptSearchPalette renderer", () => {
  it.live("renders matching prompts with selection and footer", () =>
    Effect.gen(function* () {
      const entries = [
        "fix the session queue bug",
        "fix prompt search enter behavior",
        "add tests for renderer",
      ]
      const events: Array<PromptSearchEvent> = []
      const setup = yield* openPalette(entries, (event) => events.push(event))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("add tests"), "open"),
      )
      setup.mockInput.pressKeys(["f", "i", "x"])
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => !frame.includes("add tests"), "narrowed"),
      )
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("Prompt Search")
      expect(frame).toContain("› fix")
      expect(frame).toContain("fix prompt search enter behavior")
      expect(frame).toContain("Type | Up/Down | Enter | Esc")
      // Typing and moving both report the entry under the cursor; the last
      // report is the second match in rank order.
      expect(events.at(-1)).toEqual({
        _tag: "Highlight",
        entry: Option.some("fix the session queue bug"),
      })
    }),
  )

  it.live("renders empty-state fallback when no items match", () =>
    Effect.gen(function* () {
      const events: Array<PromptSearchEvent> = []
      const setup = yield* openPalette(["first prompt", "second prompt"], (event) =>
        events.push(event),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("first prompt"), "open"),
      )
      setup.mockInput.pressKeys(["z", "z", "z"])
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("No prompt matches"), "empty"),
      )
      expect(events.at(-1)).toEqual({ _tag: "Highlight", entry: Option.none() })
    }),
  )

  it.live("keeps the draft until the reader moves, then wraps at both ends", () =>
    Effect.gen(function* () {
      const events: Array<PromptSearchEvent> = []
      const setup = yield* openPalette(["alpha", "beta", "gamma"], (event) => events.push(event))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("gamma"), "open"),
      )
      // The list sits on alpha, but nothing is reported until the reader acts.
      expect(events).toEqual([])

      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      expect(events.at(-1)).toEqual({ _tag: "Highlight", entry: Option.some("gamma") })

      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      expect(events.at(-1)).toEqual({ _tag: "Highlight", entry: Option.some("alpha") })

      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(events.at(-1)).toEqual({ _tag: "Accept" })
    }),
  )

  it.live("enter on an empty list still accepts, and escape cancels", () =>
    Effect.gen(function* () {
      const events: Array<PromptSearchEvent> = []
      const setup = yield* openPalette([], (event) => events.push(event))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("No prompt matches"), "open"),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() => setup.renderOnce())
      expect(events.at(-1)).toEqual({ _tag: "Accept" })
      setup.mockInput.pressEscape()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => events.at(-1)?._tag === "Cancel", "cancelled"),
      )
    }),
  )
})
