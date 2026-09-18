import { describe, it, expect } from "effect-bun-test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { Context, Effect, Option, Schema } from "effect"
import { BranchId, SessionId } from "@gent/core/protocol"
import { makeClientSessionResource } from "../src/extensions/client-facets"

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
