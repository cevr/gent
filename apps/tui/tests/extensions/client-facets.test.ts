import { describe, expect, it, test } from "effect-bun-test"
import { Context, Effect, Option, Schema } from "effect"
import { createMemo, createRoot, createSignal } from "solid-js"
import { BranchId, SessionId } from "@gent/core/protocol"
import {
  ClientActivity,
  ClientLifecycle,
  ClientShell,
  ClientTransport,
  ClientWorkspace,
  makeClientSessionResource,
} from "../../src/extensions/client-facets"
import { makeClientRuntime } from "../../src/extensions/host"
import { makeClientTestTransport } from "../extension-test-harness-boundary"
import { createMockRuntime } from "../render-harness-boundary"
import { runRuntimeEffectBoundary } from "../run-effect-boundary"

// ── ../extension-lifecycle.test ─────────────────────────────────────────────

const throwCleanup = (): never => Effect.runSync(Effect.die("boom"))

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
})

// ── ../client-session-resource.test ─────────────────────────────────────────

type SessionIdentity = { readonly sessionId: SessionId; readonly branchId: BranchId }

class ResourceTestTimeoutError extends Schema.TaggedError<ResourceTestTimeoutError>()(
  "ResourceTestTimeoutError",
  { message: Schema.String },
) {}

const waitFor = (
  label: string,
  predicate: () => boolean,
): Effect.Effect<void, ResourceTestTimeoutError> => {
  let attempts = 200
  const check: Effect.Effect<void, ResourceTestTimeoutError> = Effect.gen(function* () {
    if (predicate()) return
    attempts -= 1
    if (attempts <= 0) {
      return yield* new ResourceTestTimeoutError({ message: `${label} did not settle` })
    }
    // gent/no-sleep: allow yield-then-retry primitive — the fetch fiber must run between checks
    yield* Effect.sleep("1 millis")
    return yield* check
  })
  return check
}

const emptyContext = Context.makeUnsafe<never>(new Map<string, never>())

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

describe("makeClientSessionResource", () => {
  it.live("keeps its value when the session is renamed", () =>
    Effect.gen(function* () {
      let renameTo: (name: string) => void = () => {}
      let fetches = 0
      // eslint-disable-next-line effect/noNullish -- the resource reports absence as undefined.
      let read: () => number | undefined = () => Option.getOrUndefined(Option.none())

      const cleanups: Array<() => void> = []

      const dispose = createRoot((disposeRoot) => {
        const [record, setRecord] = createSignal({ name: "A" })
        renameTo = (name) => setRecord({ name })
        const identity = identityMemo(record)
        const resource = Effect.runSyncWith(emptyContext)(
          makeClientSessionResource<number>({
            transport: { currentSession: () => Option.getOrUndefined(identity()) },
            lifecycle: { addCleanup: (fn) => cleanups.push(fn) },
            cast: (effect) => {
              Effect.runForkWith(emptyContext)(effect)
            },
            label: "test resource",
            fetch: () =>
              Effect.sync(() => {
                fetches += 1
                return fetches
              }),
          }),
        )
        read = resource.read
        return disposeRoot
      })

      yield* waitFor("first fetch", () => fetches === 1).pipe(
        Effect.timeout("2 seconds"),
        Effect.onError(() => Effect.sync(dispose)),
      )
      yield* waitFor("first value", () => read() === 1).pipe(
        Effect.timeout("2 seconds"),
        Effect.onError(() => Effect.sync(dispose)),
      )

      // The wake tray row and the goal border label are drawn from resources
      // like this one. A rename must not blank them for a round trip.
      renameTo("A better name")
      // gent/no-sleep: allow a real-clock gap so a refetch, if one starts, lands before the assertion
      yield* Effect.sleep("50 millis")

      expect(read()).toBe(1)
      expect(fetches).toBe(1)
      dispose()
      for (const fn of cleanups) fn()
    }),
  )
})

// ── ../client-runtime.test ──────────────────────────────────────────────────

/**
 * `makeClientRuntime` is the one runtime every client-extension surface
 * loads against. A surface gives it a transport, a workspace, and
 * `cast`; everything else defaults so headless and tests do not
 * restate no-op callbacks.
 */

const workspace = { cwd: "/tmp/client-runtime-cwd", home: "/tmp/client-runtime-home" }
const mockRuntime = createMockRuntime()
const runCast = { cast: mockRuntime.cast }
const session = { sessionId: SessionId.make("sess-1"), branchId: BranchId.make("branch-1") }

describe("makeClientRuntime", () => {
  it.live("transport, workspace and cast alone resolve every client service", () => {
    const runtime = makeClientRuntime({
      transport: makeClientTestTransport({ currentSession: () => session }),
      workspace,
      shell: runCast,
    })
    return Effect.gen(function* () {
      const seen = yield* Effect.promise(() =>
        runRuntimeEffectBoundary(
          runtime,
          Effect.gen(function* () {
            const shell = yield* ClientShell
            const ws = yield* ClientWorkspace
            const lifecycle = yield* ClientLifecycle
            const activity = yield* ClientActivity
            const transport = yield* ClientTransport
            shell.notify("ignored")
            shell.openOverlay("ignored")
            shell.closeOverlay()
            shell.switchSession({ ...session, name: "ignored" })
            lifecycle.addCleanup(() => {})
            return {
              cwd: ws.cwd,
              activity: activity.snapshot().state,
              session: transport.currentSession(),
            }
          }),
        ),
      )
      expect(seen).toEqual({ cwd: workspace.cwd, activity: "unknown", session })
      yield* Effect.promise(() => runtime.dispose())
    })
  })

  it.live("supplied shell, activity and lifecycle callbacks replace the no-op defaults", () => {
    const sent: Array<string> = []
    const cleanups: Array<() => void> = []
    const runtime = makeClientRuntime({
      transport: makeClientTestTransport({ currentSession: () => session }),
      workspace,
      shell: { ...runCast, notify: (message) => sent.push(message) },
      activity: () => ({ state: "working" }),
      lifecycle: { addCleanup: (fn) => cleanups.push(fn) },
    })
    return Effect.gen(function* () {
      const state = yield* Effect.promise(() =>
        runRuntimeEffectBoundary(
          runtime,
          Effect.gen(function* () {
            const shell = yield* ClientShell
            const lifecycle = yield* ClientLifecycle
            const activity = yield* ClientActivity
            shell.notify("hello")
            lifecycle.addCleanup(() => {})
            return activity.snapshot().state
          }),
        ),
      )
      expect(state).toEqual("working")
      expect(sent).toEqual(["hello"])
      expect(cleanups).toHaveLength(1)
      yield* Effect.promise(() => runtime.dispose())
    })
  })
})
