/** @jsxImportSource @opentui/solid */
/**
 * The model picker behind `/model`.
 *
 * It lists the registry catalogue, marks the model the next turn would use,
 * narrows as the user types, and hands the selected id back.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { Model, ModelId, ProviderId } from "@gent/core/protocol"
import { ModelPicker } from "../../src/components/model-picker"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

const model = (id: string, name: string): Model =>
  new Model({ id: ModelId.make(id), name, provider: ProviderId.make("test") })

const catalogue = [
  model("anthropic/claude-sonnet-5", "Claude Sonnet 5"),
  model("anthropic/claude-opus-5", "Claude Opus 5"),
  model("openai/gpt-5.6-luna", "GPT-5.6 Luna"),
]

describe("Model picker", () => {
  it.live("marks the current model, filters on typing, and selects with enter", () =>
    Effect.gen(function* () {
      const selected: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <ModelPicker
            open={true}
            models={catalogue}
            current={Option.some(ModelId.make("anthropic/claude-opus-5"))}
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
})
