/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Option } from "effect"
import { createRoot, createSignal } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import { BranchId, SessionId } from "@gent/core/extensions/api"
import type { ForkViewType } from "@gent/extensions/client"
import btwExtension, { ForkPane, makeForkPane } from "../../src/extensions/btw.client"
import { createMockClient, renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"
import {
  makeClientExtensionRuntime,
  makeClientTestTransport,
  provideClientServices,
  runClientExtensionSetup,
} from "../extension-test-harness-boundary"

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
      progress: () => Effect.sync(() => current),
    },
  }
}

const onSession = {
  currentSession: () =>
    Option.some({ sessionId: SessionId.make("s"), branchId: BranchId.make("s-branch") }),
}

describe("fork pane", () => {
  it.scopedLive(
    "the first ask forks, later asks go to the fork, and turns render as they land",
    () =>
      Effect.gen(function* () {
        const queue = makeCastQueue()
        const server = makeServer()
        const controller = yield* provideClientServices(makeForkPane(server.actions), {
          ...onSession,
          shell: { cast: queue.cast },
        })
        yield* queue.drain
        const setup = yield* Effect.promise(() =>
          renderWithProviders(() => (
            <ForkPane open={true} onClose={() => {}} onOpen={() => {}} controller={controller} />
          )),
        )
        expect(renderFrame(setup)).toContain("btw · fork")
        controller.ask("why?")
        expect(Option.isSome(controller.pending())).toBe(true)
        yield* queue.drain
        expect(server.forked).toEqual(["why?"])
        expect(Option.isNone(controller.pending())).toBe(true)
        yield* Effect.promise(() =>
          waitForRenderedFrame(setup, (frame) => frame.includes("thinking"), "thinking"),
        )
        // A second ask while the fork replies is dropped on the client.
        controller.ask("too soon?")
        yield* queue.drain
        expect(server.asked).toEqual([])

        server.set(Option.some(view([{ question: "why?", answer: "because" }], false)))
        controller.refresh()
        yield* queue.drain
        yield* Effect.promise(() =>
          waitForRenderedFrame(setup, (frame) => frame.includes("because"), "answer"),
        )
        controller.ask("and?")
        yield* queue.drain
        expect(server.asked).toEqual(["and?"])
        server.set(
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
        controller.refresh()
        yield* queue.drain
        yield* Effect.promise(() =>
          waitForRenderedFrame(setup, (frame) => frame.includes("then that"), "second answer"),
        )
        const frame = renderFrame(setup)
        expect(frame).toContain("btw: why?")
        expect(frame).toContain("^o open")
      }),
  )

  it.scopedLive("keys typed into the docked pane fill its ask line and enter sends them", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      server.set(Option.some(view([{ question: "why?", answer: "because" }], false)))
      const controller = yield* provideClientServices(makeForkPane(server.actions), {
        ...onSession,
        shell: { cast: queue.cast },
      })
      yield* queue.drain
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <ForkPane open={true} onClose={() => {}} onOpen={() => {}} controller={controller} />
        )),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("because"), "fork view"),
      )
      yield* Effect.promise(() => setup.mockInput.typeText("and then?"))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("ask › and then?"), "draft"),
      )
      setup.mockInput.pressEnter()
      yield* queue.drain
      expect(server.asked).toEqual(["and then?"])
    }),
  )

  it.scopedLive("a paste while the pane is open fills its ask line, not the composer", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      server.set(Option.some(view([{ question: "why?", answer: "because" }], false)))
      const controller = yield* provideClientServices(makeForkPane(server.actions), {
        ...onSession,
        shell: { cast: queue.cast },
      })
      yield* queue.drain
      let composer = Option.none<TextareaRenderable>()
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <box flexDirection="column">
            <textarea focused ref={(node: TextareaRenderable) => (composer = Option.some(node))} />
            <ForkPane open={true} onClose={() => {}} onOpen={() => {}} controller={controller} />
          </box>
        )),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("because"), "fork view"),
      )
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText("pasted\nquestion"))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("ask › pasted question"), "draft"),
      )
      expect(Option.map(composer, (node) => node.plainText)).toEqual(Option.some(""))
      setup.mockInput.pressEnter()
      yield* queue.drain
      expect(server.asked).toEqual(["pasted question"])
    }),
  )

  it.scopedLive("a refused fork leaves the error visible and the input ready", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const controller = yield* provideClientServices(
        makeForkPane({
          fork: () => Effect.fail({ message: "model unavailable" }),
          ask: () => Effect.void,
          progress: () => Effect.succeedNone,
        }),
        { ...onSession, shell: { cast: queue.cast } },
      )
      yield* queue.drain
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
      expect(Option.isNone(controller.pending())).toBe(true)
      expect(Option.isNone(controller.fork())).toBe(true)
    }),
  )
})

describe("fork pane across a session switch", () => {
  it.live(
    "a fork reply that lands after the shell moved never becomes the new session's fork",
    () =>
      Effect.gen(function* () {
        const sessionA = { sessionId: SessionId.make("a"), branchId: BranchId.make("a-branch") }
        const sessionB = { sessionId: SessionId.make("b"), branchId: BranchId.make("b-branch") }
        const [current, setCurrent] = createRoot(() => createSignal(sessionA))
        let forkedA = false
        const sent: Array<string> = []
        const progressA = yield* Deferred.make<boolean>()
        const progressAsked = yield* Deferred.make<boolean>()
        const forkOfA = view([{ question: "why?", answer: "because" }], false)
        const client = createMockClient({
          extension: {
            request: (input: { sessionId: string; capabilityId: string }) =>
              Effect.gen(function* () {
                sent.push(`${input.capabilityId}@${input.sessionId}`)
                if (input.capabilityId === "btw.fork") {
                  forkedA = true
                  return { sessionId: forkOfA.sessionId, branchId: forkOfA.branchId }
                }
                if (input.capabilityId === "btw.ask") return { asked: true }
                if (input.sessionId !== "a" || !forkedA) return {}
                // A's read of its new fork stays out until the shell has moved to B.
                yield* Deferred.succeed(progressAsked, true)
                yield* Deferred.await(progressA)
                return { fork: forkOfA }
              }),
          },
        })
        const transport = {
          ...makeClientTestTransport({ currentSession: () => Option.some(current()) }),
          client,
        }
        const runtime = makeClientExtensionRuntime({ transport })
        const contributions = yield* runClientExtensionSetup(runtime, btwExtension)
        const btw = Option.getOrThrow(
          Option.fromUndefinedOr(contributions.commands?.find((command) => command.id === "btw")),
        )
        const slash = Option.getOrThrow(Option.fromUndefinedOr(btw.onSlash))
        const pane = Option.getOrThrow(Option.fromUndefinedOr(contributions.widgets?.[0]))
        const setup = yield* Effect.promise(() => renderWithProviders(() => pane.component()))

        slash("why?")
        yield* Deferred.await(progressAsked).pipe(Effect.timeout("2 seconds"))
        yield* Effect.promise(() =>
          waitForRenderedFrame(setup, (frame) => frame.includes("forking"), "question out"),
        )
        setCurrent(sessionB)
        yield* Deferred.succeed(progressA, true)
        yield* Effect.promise(() =>
          waitForRenderedFrame(setup, (frame) => !frame.includes("forking"), "question settled"),
        )

        // B has no fork, so the next question must fork B, not ask A's fork.
        slash("and here?")
        const asksOfB = () =>
          sent.filter((entry) => entry.endsWith("@b") && entry !== "btw.progress@b")
        yield* Effect.promise(() =>
          waitForRenderedFrame(setup, () => asksOfB().length > 0, "question sent from B"),
        )
        expect(asksOfB()).toEqual(["btw.fork@b"])
        yield* Effect.promise(() => runtime.dispose())
      }),
  )
})
