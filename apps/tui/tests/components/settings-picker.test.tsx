/** @jsxImportSource @opentui/solid */
/**
 * The docked settings pane behind `/model` and `/think`.
 *
 * It lists rows, marks the one the next turn would use, narrows as the user
 * types, and hands the selected id back.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import { Model, ModelId, ProviderId } from "@gent/core/protocol"
import { DEFAULT_ROW_ID, modelRows, reasoningRows, SettingsPicker } from "../../src/pickers"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

const model = (id: string, name: string): Model =>
  new Model({ id: ModelId.make(id), name, provider: ProviderId.make("test") })

const catalogue = [
  model("anthropic/claude-sonnet-5", "Claude Sonnet 5"),
  model("anthropic/claude-opus-5", "Claude Opus 5"),
  model("openai/gpt-5.6-luna", "GPT-5.6 Luna"),
]

describe("Settings picker", () => {
  it.live("keeps typing from snapping the cursor back to the current row", () =>
    Effect.gen(function* () {
      // The pane preselects the row the next turn would use. That anchor has to
      // let go once the reader types: re-applying it on every narrowing drags
      // the cursor off whatever they were filtering for.
      const selected: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SettingsPicker
            open={true}
            title="Model"
            rows={modelRows([
              model("a/one", "Alpha One"),
              model("a/two", "Alpha Two"),
              model("a/three", "Alpha Three"),
            ])}
            current={Option.some("a/three")}
            onSelect={(id) => {
              selected.push(id)
            }}
            onClose={() => {}}
          />
        )),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Model · 3"), "picker"),
      )
      // Every row matches "a", so the list does not narrow; the cursor still
      // has to move to the top, the way a fresh query always does.
      setup.mockInput.pressKey("a")
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("› a"), "typed"),
      )
      setup.mockInput.pressEnter()
      expect(selected).toEqual(["a/one"])
    }),
  )

  it.live("marks the current model, filters on typing, and selects with enter", () =>
    Effect.gen(function* () {
      const selected: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SettingsPicker
            open={true}
            title="Model"
            rows={modelRows(catalogue)}
            current={Option.some("anthropic/claude-opus-5")}
            onSelect={(id) => {
              selected.push(id)
            }}
            onClose={() => {}}
          />
        )),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Model · 3"), "picker"),
      )
      expect(renderFrame(setup)).toContain("● Claude Opus 5")
      expect(renderFrame(setup)).toContain("  Claude Sonnet 5")

      setup.mockInput.pressKey("l")
      setup.mockInput.pressKey("u")
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Model · 1"), "filtered"),
      )
      expect(renderFrame(setup)).not.toContain("Claude Opus 5")
      setup.mockInput.pressEnter()
      expect(selected).toEqual(["openai/gpt-5.6-luna"])
    }),
  )

  it.live("lists default plus every reasoning level and marks the session override", () =>
    Effect.gen(function* () {
      const selected: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SettingsPicker
            open={true}
            title="Reasoning"
            rows={reasoningRows(Option.some("max"))}
            current={Option.some("high")}
            onSelect={(id) => {
              selected.push(id)
            }}
            onClose={() => {}}
          />
        )),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Reasoning · 8"), "pane"),
      )
      expect(renderFrame(setup)).toContain("agent or config default (max)")
      expect(renderFrame(setup)).toContain("● high")
      // The current row is preselected; the top row is `default`.
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressEnter()
      expect(selected).toEqual([DEFAULT_ROW_ID])
    }),
  )

  it.live("reopening after a filter shows every row again", () =>
    Effect.gen(function* () {
      // The pane holds the query and unmounts the list on close, so closing has
      // to tell the pane the query is gone. Otherwise `/model` reopens with an
      // empty input over rows the last filter is still hiding.
      const [open, setOpen] = createSignal(true)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SettingsPicker
            open={open()}
            title="Model"
            rows={modelRows(catalogue)}
            current={Option.some("anthropic/claude-opus-5")}
            onSelect={() => {}}
            onClose={() => setOpen(false)}
          />
        )),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Model · 3"), "picker"),
      )

      setup.mockInput.pressKey("l")
      setup.mockInput.pressKey("u")
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Model · 1"), "filtered"),
      )

      setup.mockInput.pressEscape()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => !renderFrame(setup).includes("Model ·"), "closed"),
      )

      setOpen(true)
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Model ·"), "reopened"),
      )
      // Every row is back, so the empty input matches the list under it.
      expect(renderFrame(setup)).toContain("Model · 3")
      expect(renderFrame(setup)).toContain("Claude Opus 5")
      expect(renderFrame(setup)).toContain("GPT-5.6 Luna")
    }),
  )
})
