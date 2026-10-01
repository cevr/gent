import { describe, expect, it, test } from "effect-bun-test"
import { Deferred, Effect, Exit, Option, Scope } from "effect"
import { createMemo, createRoot, createSignal } from "solid-js"
import { BranchId, SessionId } from "@gent/core/protocol"
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
  test("cleanups fire in registration order", () => {
    const calls: string[] = []
    const cleanups: Array<() => void> = []
    const lifecycle = { addCleanup: (fn: () => void) => cleanups.push(fn) }
    lifecycle.addCleanup(() => calls.push("first"))
    lifecycle.addCleanup(() => calls.push("second"))
    lifecycle.addCleanup(() => calls.push("third"))
    for (const cleanup of cleanups) cleanup()
    expect(calls).toEqual(["first", "second", "third"])
  })
  it.live("a thrown cleanup does not block later cleanups", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const cleanups: Array<() => void> = []
      const lifecycle = { addCleanup: (fn: () => void) => cleanups.push(fn) }
      lifecycle.addCleanup(() => calls.push("before-throw"))
      lifecycle.addCleanup(throwCleanup)
      lifecycle.addCleanup(() => calls.push("after-throw"))
      yield* Effect.forEach(cleanups, (cleanup) => Effect.sync(cleanup).pipe(Effect.ignoreCause))
      expect(calls).toEqual(["before-throw", "after-throw"])
    }),
  )
  it.scopedLive(
    "closing the UI scope at shutdown runs extension cleanups before the runtime ends",
    () =>
      Effect.gen(function* () {
        const calls: string[] = []
        const registered = yield* Deferred.make<void>()
        const tracked = defineClientExtension("@test/cleanup-at-shutdown", {
          setup: Effect.gen(function* () {
            const { lifecycle } = yield* ClientContext
            lifecycle.addCleanup(() => calls.push("cleanup"))
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
        expect(calls).toEqual(["cleanup", "runtime"])
      }),
  )
})

// ── client session resource ─────────────────────────────────────────────────

type SessionIdentity = { readonly sessionId: SessionId; readonly branchId: BranchId }

const sessionId = SessionId.make("session-resource")
const branchId = BranchId.make("branch-resource")

/**
 * The provider's identity accessor, rebuilt here with the same equivalence: a
 * rename makes a new session record, and the identity a widget sees must not
 * move with it.
 */
const identityMemo = (record: () => { readonly name: string }) =>
  createMemo(
    (): Option.Option<SessionIdentity> => {
      // Track the record so a rename re-runs this body, exactly as the client does.
      record()
      return Option.some({ sessionId, branchId })
    },
    Option.none<SessionIdentity>(),
    {
      equals: Option.makeEquivalence<SessionIdentity>(
        (left, right) => left.sessionId === right.sessionId && left.branchId === right.branchId,
      ),
    },
  )

describe("sessionQuery", () => {
  it.scopedLive("keeps its value when the session is renamed", () =>
    Effect.gen(function* () {
      let renameTo: (name: string) => void = () => {}
      let fetches = 0

      const { identity, dispose } = createRoot((disposeRoot) => {
        const [record, setRecord] = createSignal({ name: "A" })
        renameTo = (name) => setRecord({ name })
        return { identity: identityMemo(record), dispose: disposeRoot }
      })
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

      yield* waitUntil(() => query.value() === 1, "first value").pipe(
        Effect.onError(() => Effect.sync(dispose)),
      )

      // The wake tray row and the goal border label are drawn from queries
      // like this one. A rename must not blank them for a round trip.
      renameTo("A better name")
      // gent/no-sleep: allow a real-clock gap so a refetch, if one starts, lands before the assertion
      yield* Effect.sleep("50 millis")

      expect(query.value()).toBe(1)
      expect(fetches).toBe(1)
      dispose()
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
          currentSession: () =>
            Option.some({ sessionId: SessionId.make(active()), branchId: BranchId.make("b") }),
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
          currentSession: () =>
            Option.some({ sessionId: SessionId.make(active()), branchId: BranchId.make("b") }),
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
})
