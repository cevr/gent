/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { makeSideQuestionPane, SideQuestionPane } from "../src/extensions/builtins/btw.client"
import { renderFrame, renderWithProviders } from "./render-harness-boundary"
import { waitForRenderedFrame } from "./helpers-boundary"

/** Casts queue here so the test drains them inside its own Effect. */
const makeCastQueue = () => {
  const pending: Array<Effect.Effect<void>> = []
  return {
    cast: <A, E>(effect: Effect.Effect<A, E, never>): void => {
      pending.push(Effect.ignore(effect))
    },
    drain: Effect.suspend(() =>
      Effect.forEach(pending.splice(0), (effect) => effect, { discard: true }),
    ),
  }
}

describe("side question pane", () => {
  it.live("shows the pending question, then the answer, and keeps earlier turns", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const controller = makeSideQuestionPane(
        ({ question, previous }) =>
          Effect.succeed({ answer: `answer to ${question} after ${previous.length}` }),
        queue.cast,
      )
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SideQuestionPane open={true} onClose={() => {}} controller={controller} />
        )),
      )
      expect(renderFrame(setup)).toContain("side question")
      controller.ask("why?")
      expect(Option.isSome(controller.state().pending)).toBe(true)
      yield* queue.drain
      yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("answer to why? after 0"),
          "first answer",
        ),
      )
      controller.ask("and?")
      yield* queue.drain
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("after 1"), "second answer"),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("why?")
      expect(frame).toContain("and?")
      expect(Option.isNone(controller.state().pending)).toBe(true)
    }),
  )

  it.live("a failed ask leaves the error visible and the input ready", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const controller = makeSideQuestionPane(
        () => Effect.fail({ message: "model unavailable" }),
        queue.cast,
      )
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SideQuestionPane open={true} onClose={() => {}} controller={controller} />
        )),
      )
      controller.ask("why?")
      yield* queue.drain
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("model unavailable"), "error"),
      )
      expect(Option.isNone(controller.state().pending)).toBe(true)
      expect(controller.state().turns.length).toBe(0)
    }),
  )
})
