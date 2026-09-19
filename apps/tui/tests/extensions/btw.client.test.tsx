/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { BranchId, SessionId } from "@gent/core/extensions/api"
import type { ForkViewType } from "@gent/extensions/client.js"
import { ForkPane, makeForkPane } from "../../src/extensions/btw.client"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

// ── ../fork-pane.test ───────────────────────────────────────────────────────

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

const view = (turns: ForkViewType["turns"], replying: boolean): ForkViewType => ({
  sessionId: SessionId.make("fork"),
  branchId: BranchId.make("fork-branch"),
  name: "btw: why?",
  turns,
  replying,
})

/** A server whose fork holds one question and whose progress is whatever the test set last. */
const makeServer = () => {
  let current: Option.Option<ForkViewType> = Option.none()
  const forked: Array<string> = []
  const asked: Array<string> = []
  return {
    forked,
    asked,
    set: (next: Option.Option<ForkViewType>) => {
      current = next
    },
    actions: {
      fork: (question: string) =>
        Effect.sync(() => {
          forked.push(question)
          current = Option.some(view([{ question, answer: "" }], true))
        }),
      ask: (question: string) =>
        Effect.sync(() => {
          asked.push(question)
        }),
      progress: Effect.sync(() => current),
    },
  }
}

describe("fork pane", () => {
  it.live("the first ask forks, later asks go to the fork, and turns render as they land", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      const controller = makeForkPane(server.actions, queue.cast)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <ForkPane open={true} onClose={() => {}} onOpen={() => {}} controller={controller} />
        )),
      )
      expect(renderFrame(setup)).toContain("btw · fork")
      controller.ask("why?")
      expect(Option.isSome(controller.state().pending)).toBe(true)
      yield* queue.drain
      expect(server.forked).toEqual(["why?"])
      expect(Option.isNone(controller.state().pending)).toBe(true)
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("thinking"), "thinking"),
      )
      // A second ask while the fork replies is dropped on the client.
      controller.ask("too soon?")
      yield* queue.drain
      expect(server.asked).toEqual([])

      controller.sync(Option.some(view([{ question: "why?", answer: "because" }], false)))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("because"), "answer"),
      )
      controller.ask("and?")
      yield* queue.drain
      expect(server.asked).toEqual(["and?"])
      controller.sync(
        Option.some(
          view(
            [
              { question: "why?", answer: "because" },
              { question: "and?", answer: "then that" },
            ],
            false,
          ),
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("then that"), "second answer"),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("btw: why?")
      expect(frame).toContain("^o open")
    }),
  )

  it.live("a reply that lands after escape reset the pane is discarded", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      const controller = makeForkPane(server.actions, queue.cast)
      controller.ask("stale?")
      controller.reset()
      yield* queue.drain
      expect(Option.isNone(controller.state().fork)).toBe(true)
      expect(Option.isNone(controller.state().pending)).toBe(true)
    }),
  )

  it.live("a refused fork leaves the error visible and the input ready", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const controller = makeForkPane(
        {
          fork: () => Effect.fail({ message: "model unavailable" }),
          ask: () => Effect.void,
          progress: Effect.succeedNone,
        },
        queue.cast,
      )
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <ForkPane open={true} onClose={() => {}} onOpen={() => {}} controller={controller} />
        )),
      )
      controller.ask("why?")
      yield* queue.drain
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("model unavailable"), "error"),
      )
      expect(Option.isNone(controller.state().pending)).toBe(true)
      expect(Option.isNone(controller.state().fork)).toBe(true)
    }),
  )
})
