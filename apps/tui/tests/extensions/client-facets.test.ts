import { describe, expect, it, test } from "effect-bun-test"
import { Deferred, Effect, Exit, Fiber, Option, Schema, Scope } from "effect"
import { createRoot, createSignal } from "solid-js"
import { AgentName, BranchId, GentRpcError, ModelId, SessionId } from "@gent/core/protocol"
import { emptyQueueSnapshot } from "@gent/core/test-utils"
import { type ClientContextValue, useClient } from "../../src/client"
import { ref } from "@gent/core/extensions/api"
import { WakeRpc } from "@gent/extensions/client"
import {
  ClientContext,
  clientContributions,
  defineClientExtension,
  sessionQuery,
  widgetContribution,
} from "../../src/extensions/client-facets"
import { provideClientServices } from "../extension-test-harness-boundary"
import { renderScoped } from "../render-harness-boundary"
import { waitUntil } from "../helpers-boundary"

// ── contribution constructors ───────────────────────────────────────────────

describe("contribution constructors", () => {
  test("a widget takes no props: the constructor refuses a component that wants some", () => {
    const good = widgetContribution({
      id: "typed-widget",
      slot: "below-input",
      component: () => "typed",
    })

    widgetContribution({
      id: "bad-widget",
      slot: "below-input",
      // @ts-expect-error -- widgets receive no props
      component: (_props: { readonly open: boolean }) => "bad",
    })
    expect(good.widgets?.[0]?.id).toBe("typed-widget")
  })
})

// ── extension lifecycle ─────────────────────────────────────────────────────

/** A cleanup that throws, as a widget disposer can: reading an absent Option throws. */
const throwCleanup = (): never => Option.getOrThrow(Option.none())

describe("transport-only extension widgets", () => {
  // The host disposer runs cleanups in registration order; a cleanup that
  // throws stops neither the cleanups after it nor the runtime's end.
  it.scopedLive(
    "closing the UI scope runs every cleanup in order, past a throwing one, before the runtime ends",
    () =>
      Effect.gen(function* () {
        const calls: string[] = []
        const registered = yield* Deferred.make<void>()
        const tracked = defineClientExtension("@test/cleanup-at-shutdown", {
          setup: Effect.gen(function* () {
            const { lifecycle } = yield* ClientContext
            lifecycle.addCleanup(() => calls.push("cleanup"))
            lifecycle.addCleanup(throwCleanup)
            lifecycle.addCleanup(() => calls.push("after"))
            yield* lifecycle.scoped(
              Effect.addFinalizer(() => Effect.sync(() => calls.push("runtime"))),
            )
            yield* Deferred.done(registered, Exit.void)
            return clientContributions()
          }),
        })
        const uiScope = yield* Scope.make()
        yield* renderScoped(() => [], { builtins: [tracked], uiScope })
        yield* Deferred.await(registered).pipe(Effect.timeout("2 seconds"))
        yield* Scope.close(uiScope, Exit.void)
        expect(calls).toEqual(["cleanup", "after", "runtime"])
      }),
  )
})

// ── transport ───────────────────────────────────────────────────────────────

describe("transport", () => {
  // A session switch or a closed pane interrupts the read that asked; the RPC
  // must stop with it, or its reply still runs for a session nobody views.
  it.scopedLive("interrupting a request interrupts its RPC", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      yield* provideClientServices(
        Effect.gen(function* () {
          const { transport } = yield* ClientContext
          const fiber = yield* Effect.forkChild(transport.request(ref(WakeRpc.Pending), {}))
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
        }),
        {
          requestEffect: () =>
            Deferred.done(started, Exit.void).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.done(interrupted, Exit.void)),
            ),
        },
      )
      yield* Deferred.await(interrupted).pipe(Effect.timeout("2 seconds"))
    }),
  )

  // A pane draws a failed request's message: a refusal reads in the
  // extension's own words, not the transport's.
  it.scopedLive("an extension's refusal is the request's message", () =>
    Effect.gen(function* () {
      const refusal = yield* Schema.decodeEffect(GentRpcError)({
        _tag: "ExtensionProtocolError",
        extensionId: "@gent/wake",
        tag: "wake.pending",
        message: "no alarm is set",
      })
      const message = yield* provideClientServices(
        Effect.gen(function* () {
          const { transport } = yield* ClientContext
          return yield* transport.request(ref(WakeRpc.Pending), {}).pipe(
            Effect.flip,
            Effect.map((failure) => failure.message),
            Effect.orElseSucceed(() => "the request succeeded"),
          )
        }),
        { requestEffect: () => Effect.fail(refusal) },
      )
      expect(message).toBe("no alarm is set")
    }),
  )
})

// ── client session resource ─────────────────────────────────────────────────

describe("sessionQuery", () => {
  // The identity comes from the real ClientProvider, so a change to its
  // equivalence fails here.
  it.scopedLive("keeps its value when the session is renamed", () =>
    Effect.gen(function* () {
      let fetches = 0
      let ctx = Option.none<ClientContextValue>()
      yield* renderScoped(() => {
        ctx = Option.some(useClient())
        return []
      })
      const client = yield* Option.match(ctx, {
        onNone: () => Effect.die("client context not ready"),
        onSome: Effect.succeed,
      })
      const identity = client.sessionIdentity
      const renameTo = (name: string) => {
        const session = client.session()
        client.applySessionSnapshot({
          sessionId: session.sessionId,
          branchId: session.branchId,
          name,
          messages: [],
          // eslint-disable-next-line effect/noNullish -- JSON on the wire carries null here; the test hands it on as is.
          lastEventId: null,
          reasoningLevel: session.reasoningLevel,
          resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
          agent: AgentName.make("primary"),
          runtime: { _tag: "Idle", queue: emptyQueueSnapshot() },
          metrics: { turns: 0, durationMs: 0, costUsd: 0, lastInputTokens: 0 },
        })
      }
      const query = yield* provideClientServices(
        sessionQuery({
          initial: 0,
          follow: true,
          fetch: () =>
            Effect.sync(() => {
              fetches += 1
              return fetches
            }),
        }),
        { currentSession: identity },
      )

      yield* waitUntil(() => query.value() === 1, "first value")

      // The wake tray row and the goal border label are drawn from queries
      // like this one. A rename must not blank them for a round trip.
      renameTo("A better name")
      expect(client.session().name).toBe("A better name")
      // oxlint-disable-next-line effect/noFixedWaitInTests -- a real-clock gap so a refetch, if one starts, lands before the assertion
      yield* Effect.sleep("50 millis")

      expect(query.value()).toBe(1)
      expect(fetches).toBe(1)
    }),
  )

  it.scopedLive("a follow query blanks on a switch and reads the new session", () =>
    Effect.gen(function* () {
      const { active, setActive, dispose } = createRoot((disposeRoot) => {
        const [current, setCurrent] = createSignal("a")
        return { active: current, setActive: setCurrent, dispose: disposeRoot }
      })
      const query = yield* provideClientServices(
        sessionQuery({
          initial: "none",
          follow: true,
          fetch: (session) => Effect.succeed(String(session.sessionId)),
        }),
        {
          currentSession: () => ({
            sessionId: SessionId.make(active()),
            branchId: BranchId.make("b"),
          }),
        },
      )
      yield* waitUntil(() => query.value() === "a", "first session")
      setActive("z")
      yield* waitUntil(() => query.value() === "z", "second session")
      dispose()
    }),
  )

  // A switch that lands while a read runs queues one more read instead of
  // reading. The follow effect must keep its dependency on the session
  // through that, or it never fires again.
  it.scopedLive("a follow query keeps following after a switch lands during a read", () =>
    Effect.gen(function* () {
      const { active, setActive, dispose } = createRoot((disposeRoot) => {
        const [current, setCurrent] = createSignal("a")
        return { active: current, setActive: setCurrent, dispose: disposeRoot }
      })
      const reads: Array<string> = []
      const releaseA = yield* Deferred.make<void>()
      const query = yield* provideClientServices(
        sessionQuery({
          initial: "none",
          follow: true,
          fetch: (session) => {
            const id = String(session.sessionId)
            reads.push(id)
            if (id === "a") return Deferred.await(releaseA).pipe(Effect.as(id))
            return Effect.succeed(id)
          },
        }),
        {
          currentSession: () => ({
            sessionId: SessionId.make(active()),
            branchId: BranchId.make("b"),
          }),
        },
      )
      yield* waitUntil(() => reads.length === 1, "a's read started")
      setActive("b")
      yield* Deferred.done(releaseA, Exit.void)
      yield* waitUntil(() => query.value() === "b", "b read")
      setActive("c")
      yield* waitUntil(() => query.value() === "c", "c read").pipe(
        Effect.onError(() => Effect.sync(dispose)),
      )
      expect(reads).toEqual(["a", "b", "c"])
      dispose()
    }),
  )

  it.scopedLive("accepted sees each reply that becomes the value, and never a dropped one", () =>
    Effect.gen(function* () {
      let active = "a"
      const release = yield* Deferred.make<void>()
      const accepted: Array<string> = []
      const query = yield* provideClientServices(
        sessionQuery({
          initial: "none",
          follow: false,
          fetch: (session) => {
            const id = String(session.sessionId)
            if (id === "a") return Deferred.await(release).pipe(Effect.as(id))
            return Effect.succeed(id)
          },
          accepted: (value) => {
            accepted.push(value)
          },
        }),
        {
          currentSession: () => ({
            sessionId: SessionId.make(active),
            branchId: BranchId.make("b"),
          }),
        },
      )
      query.refresh()
      expect(query.loading()).toBe(true)
      // The shell leaves `a` while its read is out: that reply is dropped.
      active = "b"
      yield* Deferred.done(release, Exit.void)
      yield* waitUntil(() => !query.loading(), "a's reply lands")
      expect(accepted).toEqual([])
      query.refresh()
      yield* waitUntil(() => query.value() === "b", "b read")
      expect(accepted).toEqual(["b"])
    }),
  )
})
