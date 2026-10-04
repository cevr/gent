/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Option, Schema } from "effect"
import { createRoot, createSignal } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import { BranchId, MessageId, SessionId } from "@gent/core/extensions/api"
import {
  BTW_MERGE_TYPE,
  ForkMergeDetails,
  forkMergeText,
  type ForkViewType,
} from "@gent/extensions/client"
import { QueueWidget } from "../../src/app"
import btwExtension, { ForkMergeRow, ForkPane, makeForkPane } from "../../src/extensions/btw.client"
import { createMockClient, renderFrame, renderScoped } from "../render-harness-boundary"
import { waitForFrame, waitUntil } from "../helpers-boundary"
import {
  makeClientExtensionRuntime,
  makeClientTestTransport,
  provideClientServices,
  runClientExtensionSetup,
} from "../extension-test-harness-boundary"

// ── fork pane ───────────────────────────────────────────────────────────────

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
  const merges: Array<string> = []
  let mergeOutcome: Effect.Effect<{ readonly merged: boolean }, { readonly message: string }> =
    Effect.succeed({ merged: true })
  return {
    forked,
    asked,
    merges,
    mergeWith: (outcome: typeof mergeOutcome) => {
      mergeOutcome = outcome
    },
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
      merge: (session: { readonly sessionId: string }) =>
        Effect.suspend(() => {
          merges.push(session.sessionId)
          return mergeOutcome
        }),
    },
  }
}

const onSession = {
  currentSession: () => ({ sessionId: SessionId.make("s"), branchId: BranchId.make("s-branch") }),
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
        const setup = yield* renderScoped(() => (
          <ForkPane
            open={true}
            onClose={() => {}}
            onOpen={() => {}}
            onMerge={() => {}}
            controller={controller}
          />
        ))
        expect(renderFrame(setup)).toContain("btw · fork")
        controller.ask("why?")
        expect(Option.isSome(controller.pending())).toBe(true)
        yield* queue.drain
        expect(server.forked).toEqual(["why?"])
        expect(Option.isNone(controller.pending())).toBe(true)
        yield* waitForFrame(setup, (frame) => frame.includes("thinking"), "thinking")
        // The title is the fork's own name, with no second `btw` before it.
        expect(renderFrame(setup)).toContain("btw: why?")
        expect(renderFrame(setup)).not.toContain("btw · btw")
        // A second ask while the fork replies is dropped on the client.
        controller.ask("too soon?")
        yield* queue.drain
        expect(server.asked).toEqual([])

        server.set(Option.some(view([{ question: "why?", answer: "because" }], false)))
        controller.refresh()
        yield* queue.drain
        yield* waitForFrame(setup, (frame) => frame.includes("because"), "answer")
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
        yield* waitForFrame(setup, (frame) => frame.includes("then that"), "second answer")
        const frame = renderFrame(setup)
        expect(frame).toContain("btw: why?")
        expect(frame).toContain("enter open · ctrl+s merge · esc close")
      }),
  )

  // A question belongs to the session it was asked in. When a read is out,
  // the read that sends the question runs after it, and a switch in between
  // makes that read the new session's; the question still goes to its own.
  it.scopedLive("a question asked before a switch goes to the session it was asked in", () =>
    Effect.gen(function* () {
      const first = { sessionId: SessionId.make("s1"), branchId: BranchId.make("s1-branch") }
      const second = { sessionId: SessionId.make("s2"), branchId: BranchId.make("s2-branch") }
      const [current, setCurrent] = createSignal(first)
      const hold = yield* Deferred.make<void>()
      const sent = yield* Deferred.make<string>()
      const record = (session: { readonly sessionId: string }) =>
        Deferred.succeed(sent, session.sessionId).pipe(Effect.asVoid)
      const controller = yield* provideClientServices(
        makeForkPane({
          fork: (_question, session) => record(session),
          ask: (_question, session) => record(session),
          // The first read (the pane following its session) stays out.
          progress: () => Deferred.await(hold).pipe(Effect.as(Option.none())),
          merge: () => Effect.succeed({ merged: true }),
        }),
        { currentSession: () => current() },
      )
      controller.ask("why?")
      setCurrent(second)
      yield* Deferred.succeed(hold, void 0)
      expect(yield* Deferred.await(sent).pipe(Effect.timeout("5 seconds"))).toBe("s1")
    }),
  )

  // The question rides a read queued behind one still out, and the reader
  // switches before it runs: the read is the new session's. The first
  // session's failure is said out loud and is not the new session's error.
  it.scopedLive(
    "a question that fails in the session the reader left is not the new pane's error",
    () =>
      Effect.gen(function* () {
        const first = { sessionId: SessionId.make("s1"), branchId: BranchId.make("s1-branch") }
        const second = { sessionId: SessionId.make("s2"), branchId: BranchId.make("s2-branch") }
        const [current, setCurrent] = createSignal(first)
        const hold = yield* Deferred.make<void>()
        const readSecond = yield* Deferred.make<void>()
        const notices: Array<string> = []
        const controller = yield* provideClientServices(
          makeForkPane({
            fork: () => Effect.fail({ message: "model unavailable" }),
            ask: () => Effect.void,
            progress: (session) =>
              Effect.suspend(() => {
                if (session.sessionId === second.sessionId) {
                  return Deferred.succeed(readSecond, void 0)
                }
                return Deferred.await(hold)
              }).pipe(Effect.as(Option.none())),
            merge: () => Effect.succeed({ merged: true }),
          }),
          {
            currentSession: () => current(),
            shell: { notify: (message) => notices.push(message) },
          },
        )
        controller.ask("why?")
        setCurrent(second)
        yield* Deferred.succeed(hold, void 0)
        yield* Deferred.await(readSecond).pipe(Effect.timeout("2 seconds"))
        yield* Effect.yieldNow
        expect(notices.some((notice) => notice.includes("why?"))).toBe(true)
        expect(Option.isNone(controller.error())).toBe(true)
      }),
  )

  // Two asks before the first goes out: the second is refused with a notice
  // instead of replacing the first, and nothing is dropped silently.
  it.scopedLive("an ask while another waits or the fork replies is refused out loud", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      const notices: Array<string> = []
      const controller = yield* provideClientServices(makeForkPane(server.actions), {
        ...onSession,
        shell: { cast: queue.cast, notify: (message) => notices.push(message) },
      })
      yield* queue.drain
      controller.ask("first?")
      controller.ask("second?")
      yield* queue.drain
      expect(server.forked).toEqual(["first?"])
      expect(notices).toHaveLength(1)
      // The fork is replying now: a question for it is refused the same way.
      controller.ask("third?")
      yield* queue.drain
      expect(server.asked).toEqual([])
      expect(notices).toHaveLength(2)
    }),
  )

  // Enter means "go there" on an empty line, as on an agents row; ctrl+o
  // keeps its one meaning, the transcript's detail level.
  it.scopedLive("enter on an empty ask line opens the fork, and ctrl+o does not", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      server.set(Option.some(view([{ question: "why?", answer: "because" }], false)))
      const controller = yield* provideClientServices(makeForkPane(server.actions), {
        ...onSession,
        shell: { cast: queue.cast },
      })
      yield* queue.drain
      let opened = 0
      const setup = yield* renderScoped(() => (
        <ForkPane
          open={true}
          onClose={() => {}}
          onOpen={() => (opened += 1)}
          onMerge={() => {}}
          controller={controller}
        />
      ))
      yield* waitForFrame(setup, (frame) => frame.includes("enter open"), "fork view")
      setup.mockInput.pressKey("o", { ctrl: true })
      yield* Effect.promise(() => setup.mockInput.typeText("x"))
      yield* waitForFrame(setup, (frame) => frame.includes("enter submit"), "a draft")
      expect(opened).toBe(0)
      setup.mockInput.pressBackspace()
      yield* waitForFrame(setup, (frame) => frame.includes("enter open"), "the draft gone")
      setup.mockInput.pressEnter()
      yield* waitUntil(() => opened === 1, "the fork opened")
      yield* queue.drain
      expect(server.asked).toEqual([])
    }).pipe(Effect.timeout("4 seconds")),
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
      const setup = yield* renderScoped(() => (
        <ForkPane
          open={true}
          onClose={() => {}}
          onOpen={() => {}}
          onMerge={() => {}}
          controller={controller}
        />
      ))
      yield* waitForFrame(setup, (frame) => frame.includes("because"), "fork view")
      yield* Effect.promise(() => setup.mockInput.typeText("and then?"))
      yield* waitForFrame(setup, (frame) => frame.includes("ask › and then?"), "draft")
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
      const setup = yield* renderScoped(() => (
        <box flexDirection="column">
          <textarea focused ref={(node: TextareaRenderable) => (composer = Option.some(node))} />
          <ForkPane
            open={true}
            onClose={() => {}}
            onOpen={() => {}}
            onMerge={() => {}}
            controller={controller}
          />
        </box>
      ))
      yield* waitForFrame(setup, (frame) => frame.includes("because"), "fork view")
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText("pasted\nquestion"))
      yield* waitForFrame(setup, (frame) => frame.includes("ask › pasted question"), "draft")
      expect(Option.map(composer, (node) => node.plainText)).toEqual(Option.some(""))
      setup.mockInput.pressEnter()
      yield* queue.drain
      expect(server.asked).toEqual(["pasted question"])
    }),
  )

  it.scopedLive("a key held with super or hyper types nothing into the ask line", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      server.set(Option.some(view([{ question: "why?", answer: "because" }], false)))
      const controller = yield* provideClientServices(makeForkPane(server.actions), {
        ...onSession,
        shell: { cast: queue.cast },
      })
      yield* queue.drain
      const setup = yield* renderScoped(
        () => (
          <ForkPane
            open={true}
            onClose={() => {}}
            onOpen={() => {}}
            onMerge={() => {}}
            controller={controller}
          />
        ),
        { kittyKeyboard: true },
      )
      yield* waitForFrame(setup, (frame) => frame.includes("because"), "fork view")
      setup.mockInput.pressKey("a", { super: true })
      setup.mockInput.pressKey("b", { hyper: true })
      setup.mockInput.pressKey("x")
      yield* waitForFrame(setup, (frame) => frame.includes("ask › x"), "the typed key")
      setup.mockInput.pressEnter()
      yield* queue.drain
      expect(server.asked).toEqual(["x"])
    }),
  )

  it.scopedLive("backspace takes the last whole character off the ask line", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      server.set(Option.some(view([{ question: "why?", answer: "because" }], false)))
      const controller = yield* provideClientServices(makeForkPane(server.actions), {
        ...onSession,
        shell: { cast: queue.cast },
      })
      yield* queue.drain
      const setup = yield* renderScoped(() => (
        <ForkPane
          open={true}
          onClose={() => {}}
          onOpen={() => {}}
          onMerge={() => {}}
          controller={controller}
        />
      ))
      yield* waitForFrame(setup, (frame) => frame.includes("because"), "fork view")
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText("ok 👍🏽🇺🇸"))
      yield* waitForFrame(setup, (frame) => frame.includes("ask › ok"), "draft")
      // A flag is two code points and a toned thumb two: each goes in one press.
      setup.mockInput.pressBackspace()
      setup.mockInput.pressBackspace()
      yield* Effect.promise(() => setup.mockInput.typeText("!"))
      yield* waitForFrame(setup, (frame) => frame.includes("ask › ok !"), "two characters gone")
      setup.mockInput.pressEnter()
      yield* queue.drain
      expect(server.asked).toEqual(["ok !"])
    }),
  )

  // The ask line edits as the composer and a list's filter do.
  it.scopedLive("ctrl+w takes the last word off the ask line and ctrl+u the whole line", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      server.set(Option.some(view([{ question: "why?", answer: "because" }], false)))
      const controller = yield* provideClientServices(makeForkPane(server.actions), {
        ...onSession,
        shell: { cast: queue.cast },
      })
      yield* queue.drain
      const setup = yield* renderScoped(() => (
        <ForkPane
          open={true}
          onClose={() => {}}
          onOpen={() => {}}
          onMerge={() => {}}
          controller={controller}
        />
      ))
      yield* waitForFrame(setup, (frame) => frame.includes("because"), "fork view")
      yield* Effect.promise(() => setup.mockInput.typeText("foo bar"))
      yield* waitForFrame(setup, (frame) => frame.includes("ask › foo bar"), "draft")
      setup.mockInput.pressKey("w", { ctrl: true })
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("ask › foo") && !frame.includes("foo bar"),
        "the last word gone",
      )
      setup.mockInput.pressKey("u", { ctrl: true })
      yield* waitForFrame(setup, (frame) => !frame.includes("ask › foo"), "the line gone")
      yield* Effect.promise(() => setup.mockInput.typeText("baz"))
      setup.mockInput.pressEnter()
      yield* queue.drain
      expect(server.asked).toEqual(["baz"])
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
          merge: () => Effect.succeed({ merged: true }),
        }),
        { ...onSession, shell: { cast: queue.cast } },
      )
      yield* queue.drain
      const setup = yield* renderScoped(() => (
        <ForkPane
          open={true}
          onClose={() => {}}
          onOpen={() => {}}
          onMerge={() => {}}
          controller={controller}
        />
      ))
      controller.ask("why?")
      yield* queue.drain
      yield* waitForFrame(setup, (frame) => frame.includes("model unavailable"), "error")
      expect(Option.isNone(controller.pending())).toBe(true)
      expect(Option.isNone(controller.fork())).toBe(true)
    }),
  )

  // The reader switched away while the question went out. The pane of the
  // session in view cannot show the failure, so the shell says it out loud,
  // with the question, and nothing is dropped silently.
  it.scopedLive("an ask that fails after a switch is reported with its question", () =>
    Effect.gen(function* () {
      const first = { sessionId: SessionId.make("s1"), branchId: BranchId.make("s1-branch") }
      const second = { sessionId: SessionId.make("s2"), branchId: BranchId.make("s2-branch") }
      const [current, setCurrent] = createSignal(first)
      const queue = makeCastQueue()
      const notices: Array<string> = []
      const controller = yield* provideClientServices(
        makeForkPane({
          fork: () => Effect.fail({ message: "model unavailable" }),
          ask: () => Effect.void,
          progress: () => Effect.succeedNone,
          merge: () => Effect.succeed({ merged: true }),
        }),
        {
          currentSession: () => current(),
          shell: { cast: queue.cast, notify: (message) => notices.push(message) },
        },
      )
      yield* queue.drain
      controller.ask("why is the sky blue?")
      setCurrent(second)
      yield* queue.drain
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain("why is the sky blue?")
      expect(notices[0]).toContain("model unavailable")
    }),
  )
})

// ── merge ───────────────────────────────────────────────────────────────────

const answered = () => view([{ question: "why?", answer: "because" }], false)

const mergeDetails = {
  fork: { sessionId: "fork", branchId: "fork-branch", name: "btw: why?" },
  fromMessageId: "m-1",
  replyId: "m-2",
  turns: 1,
  question: "What bird is that?",
  reply: "A grey heron.",
}

describe("fork merge", () => {
  // The merge key shows only when a merge can land: the fork answered and
  // nothing is on its way to it.
  it.scopedLive("the pane offers ctrl+s merge only once the fork has answered", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      server.set(Option.some(view([{ question: "why?", answer: "" }], true)))
      const controller = yield* provideClientServices(makeForkPane(server.actions), {
        ...onSession,
        shell: { cast: queue.cast },
      })
      yield* queue.drain
      const setup = yield* renderScoped(
        () => (
          <ForkPane
            open={true}
            onClose={() => {}}
            onOpen={() => {}}
            onMerge={() => {}}
            controller={controller}
          />
        ),
        { width: 60 },
      )
      yield* waitForFrame(setup, (frame) => frame.includes("thinking"), "replying")
      expect(renderFrame(setup)).not.toContain("merge")
      server.set(Option.some(answered()))
      controller.refresh()
      yield* queue.drain
      const frame = yield* waitForFrame(setup, (f) => f.includes("because"), "answered")
      expect(frame).toContain("enter open · ctrl+s merge · esc close")
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("ctrl+s in the pane merges, and a key it does not own types nothing", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      server.set(Option.some(answered()))
      const controller = yield* provideClientServices(makeForkPane(server.actions), {
        ...onSession,
        shell: { cast: queue.cast },
      })
      yield* queue.drain
      let merged = 0
      const setup = yield* renderScoped(() => (
        <ForkPane
          open={true}
          onClose={() => {}}
          onOpen={() => {}}
          onMerge={() => (merged += 1)}
          controller={controller}
        />
      ))
      yield* waitForFrame(setup, (frame) => frame.includes("ctrl+s merge"), "mergeable")
      setup.mockInput.pressKey("s", { ctrl: true })
      yield* waitUntil(() => merged === 1, "the merge")
      expect(renderFrame(setup)).toContain("ask › ")
      expect(renderFrame(setup)).not.toContain("ask › s")
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a merge sends once for the session in view and then closes the pane", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      server.set(Option.some(answered()))
      const notices: Array<string> = []
      const controller = yield* provideClientServices(makeForkPane(server.actions), {
        ...onSession,
        shell: { cast: queue.cast, notify: (message) => notices.push(message) },
      })
      yield* queue.drain
      let closed = 0
      controller.merge(() => (closed += 1))
      yield* queue.drain
      expect(server.merges).toEqual(["s"])
      expect(closed).toBe(1)
      expect(notices).toEqual([])
      // The same reply again: the server posts nothing and the reader is told.
      server.mergeWith(Effect.succeed({ merged: false }))
      controller.merge(() => (closed += 1))
      yield* queue.drain
      expect(closed).toBe(2)
      expect(notices).toEqual(["btw: this reply is already merged"])
      // A refusal keeps the pane open and says why.
      server.mergeWith(Effect.fail({ message: "The fork is still answering" }))
      controller.merge(() => (closed += 1))
      yield* queue.drain
      expect(closed).toBe(2)
      expect(notices.at(-1)).toBe("btw: not merged: The fork is still answering")
    }),
  )

  it.scopedLive("a merge with no fork, no reply, or a reply on its way is refused here", () =>
    Effect.gen(function* () {
      const queue = makeCastQueue()
      const server = makeServer()
      const notices: Array<string> = []
      const controller = yield* provideClientServices(makeForkPane(server.actions), {
        ...onSession,
        shell: { cast: queue.cast, notify: (message) => notices.push(message) },
      })
      yield* queue.drain
      controller.merge(() => {})
      server.set(Option.some(view([], false)))
      controller.refresh()
      yield* queue.drain
      controller.merge(() => {})
      server.set(Option.some(view([{ question: "why?", answer: "bec" }], true)))
      controller.refresh()
      yield* queue.drain
      controller.merge(() => {})
      yield* queue.drain
      expect(server.merges).toEqual([])
      expect(notices).toEqual([
        "btw: no fork to merge",
        "btw: the fork has no reply to merge yet",
        "btw: the fork is still answering; merge when it is done",
      ])
    }),
  )
})

describe("ForkMergeRow", () => {
  it.scopedLive("a merge draws one collapsed row: the question and the reply it merged", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => <ForkMergeRow details={mergeDetails} />, {
        width: 120,
        height: 4,
      })
      const frame = yield* waitForFrame(setup, (f) => f.includes("merged"), "the row")
      expect(frame).toContain("↳ merged btw · What bird is that? → A grey heron.")
      // The ids the model reads stay out of the row.
      expect(frame).not.toContain("m-2")
    }).pipe(Effect.timeout("6 seconds")),
  )

  it.scopedLive("a narrow row keeps one line and cuts its end", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => <ForkMergeRow details={mergeDetails} />, {
        width: 30,
        height: 4,
      })
      const frame = yield* waitForFrame(setup, (f) => f.includes("merged"), "the row")
      const lines = frame.split("\n").filter((line) => line.includes("merged"))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("…")
      expect(frame).not.toContain("heron")
    }).pipe(Effect.timeout("6 seconds")),
  )

  it.scopedLive("details it cannot read draw the plain row", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => <ForkMergeRow details={{ other: 1 }} />, {
        width: 60,
        height: 4,
      })
      const frame = yield* waitForFrame(setup, (f) => f.includes("merged"), "the row")
      expect(frame).toContain("↳ merged a btw fork")
    }).pipe(Effect.timeout("6 seconds")),
  )

  it.scopedLive("a merge waiting for the turn shows in the queue as the question it merges", () =>
    Effect.gen(function* () {
      const runtime = makeClientExtensionRuntime({
        transport: { ...makeClientTestTransport(), client: createMockClient() },
      })
      const contributions = yield* runClientExtensionSetup(runtime, btwExtension)
      const renderers = new Map(
        (contributions.messageRenderers ?? []).map((entry) => [entry.customType, entry]),
      )
      const setup = yield* renderScoped(
        () => (
          <QueueWidget
            steerMessages={[
              {
                _tag: "Steering",
                id: MessageId.make("merge-1"),
                content: "The user merged a /btw fork back into this session: …",
                createdAt: 0,
                metadata: { customType: BTW_MERGE_TYPE, details: mergeDetails },
              },
            ]}
            queuedMessages={[]}
            messageRenderers={renderers}
          />
        ),
        { width: 120, height: 6 },
      )
      const frame = yield* waitForFrame(setup, (f) => f.includes("[steer 1]"), "the queue")
      expect(frame).toContain("[steer 1] ↳ btw merge · What bird is that?")
      expect(frame).not.toContain("The user merged")
      yield* Effect.promise(() => runtime.dispose())
    }).pipe(Effect.timeout("6 seconds")),
  )

  // The merge is the reader's own message: the transcript pins what they
  // did, not the ids the model reads.
  it.scopedLive("the pinned prompt of a merge names the fork, not the text the model reads", () =>
    Effect.gen(function* () {
      const runtime = makeClientExtensionRuntime({
        transport: { ...makeClientTestTransport(), client: createMockClient() },
      })
      const contributions = yield* runClientExtensionSetup(runtime, btwExtension)
      const merge = contributions.messageRenderers?.find(
        (entry) => entry.customType === BTW_MERGE_TYPE,
      )
      const text = forkMergeText(yield* Schema.decodeEffect(ForkMergeDetails)(mergeDetails))
      expect(merge?.prompt?.(text)).toBe("merged btw: why?")
      expect(merge?.prompt?.("plain")).toBe("plain")
      yield* Effect.promise(() => runtime.dispose())
    }).pipe(Effect.timeout("6 seconds")),
  )
})

describe("fork pane across a session switch", () => {
  it.scopedLive(
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
          ...makeClientTestTransport({ currentSession: () => current() }),
          client,
        }
        const runtime = makeClientExtensionRuntime({ transport })
        const contributions = yield* runClientExtensionSetup(runtime, btwExtension)
        const btw = Option.getOrThrow(
          Option.fromUndefinedOr(contributions.commands?.find((command) => command.id === "btw")),
        )
        const slash = Option.getOrThrow(Option.fromUndefinedOr(btw.onSlash))
        const pane = Option.getOrThrow(Option.fromUndefinedOr(contributions.widgets?.[0]))
        const setup = yield* renderScoped(() => pane.component())

        slash("why?")
        yield* Deferred.await(progressAsked).pipe(Effect.timeout("2 seconds"))
        yield* waitForFrame(setup, (frame) => frame.includes("forking"), "question out")
        setCurrent(sessionB)
        yield* Deferred.succeed(progressA, true)
        yield* waitForFrame(setup, (frame) => !frame.includes("forking"), "question settled")

        // B has no fork, so the next question must fork B, not ask A's fork.
        slash("and here?")
        const asksOfB = () =>
          sent.filter((entry) => entry.endsWith("@b") && entry !== "btw.progress@b")
        yield* waitForFrame(setup, () => asksOfB().length > 0, "question sent from B")
        expect(asksOfB()).toEqual(["btw.fork@b"])
        yield* Effect.promise(() => runtime.dispose())
      }),
  )
})
