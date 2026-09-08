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

const acceptAsk = () => Effect.void

describe("side question pane", () => {
  it.live("shows the pending question, streamed text, then the answer, and keeps turns", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const controller = makeSideQuestionPane(acceptAsk, queue.cast)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SideQuestionPane open={true} onClose={() => {}} controller={controller} />
        )),
      )
      expect(renderFrame(setup)).toContain("side question")
      controller.ask("why?")
      yield* queue.drain
      expect(Option.isSome(controller.state().pending)).toBe(true)
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("thinking"), "thinking"),
      )
      controller.sync({ question: "why?", text: "because", done: false })
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("because"), "streamed text"),
      )
      controller.sync({ question: "why?", text: "because so", done: true, answer: "because so" })
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("because so"), "first answer"),
      )
      controller.ask("and?")
      yield* queue.drain
      controller.sync({ question: "and?", text: "", done: true, answer: "then that" })
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("then that"), "second answer"),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("why?")
      expect(frame).toContain("and?")
      expect(Option.isNone(controller.state().pending)).toBe(true)
    }),
  )

  it.live("a run that lands after escape reset the pane is discarded", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const controller = makeSideQuestionPane(acceptAsk, queue.cast)
      controller.ask("stale?")
      controller.reset()
      yield* queue.drain
      controller.sync({ question: "stale?", text: "", done: true, answer: "late" })
      expect(controller.state().turns.length).toBe(0)
      expect(Option.isNone(controller.state().pending)).toBe(true)
      controller.ask("fresh?")
      yield* queue.drain
      // A run for another question belongs to an earlier pane and is ignored.
      controller.sync({ question: "stale?", text: "", done: true, answer: "late" })
      expect(controller.state().turns.length).toBe(0)
      controller.sync({ question: "fresh?", text: "", done: true, answer: "now" })
      expect(controller.state().turns.map((turn) => turn.answer)).toEqual(["now"])
    }),
  )

  it.live("a refused ask leaves the error visible and the input ready", () =>
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

  it.live("a run that ends in an error shows the error", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const controller = makeSideQuestionPane(acceptAsk, queue.cast)
      controller.ask("why?")
      yield* queue.drain
      controller.sync({ question: "why?", text: "", done: true, error: "child failed" })
      expect(controller.state().error).toEqual(Option.some("child failed"))
      expect(Option.isNone(controller.state().pending)).toBe(true)
    }),
  )
})
