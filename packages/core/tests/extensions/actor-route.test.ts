/**
 * Actor-route in ActorRouter.
 *
 * ActorRouter routes ExtensionMessages through the live ActorRef
 * discovered via the Receptionist using the extension Behavior's
 * `serviceKey`. This test pins the end-to-end path: defineExtension →
 * ActorHost spawn → Receptionist registration → ActorRouter.send/execute
 * → actor receives + replies.
 *
 * Empirical regression: temporarily comment out the `actorRoutes.get`
 * branch in actor-router.ts (sendImmediate / executeImmediate) and
 * both assertions must fail with `is not loaded`.
 */

import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Layer, Schema } from "effect"
import { ServiceKey, type Behavior } from "../../src/domain/actor"
import { TaggedEnumClass } from "../../src/domain/schema-tagged-enum-class"
import { ExtensionMessage, ExtensionProtocolError } from "../../src/domain/extension-protocol"
import { BranchId, ExtensionId, SessionId } from "../../src/domain/ids"
import type { LoadedExtension } from "../../src/domain/extension"
import type { ResolvedExtensions } from "../../src/runtime/extensions/registry"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
import { ActorHost } from "../../src/runtime/extensions/actor-host"
import { ActorRouter } from "../../src/runtime/extensions/resource-host/actor-router"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control"

const sessionId = SessionId.make("actor-route-session")
const branchId = BranchId.make("actor-route-branch")

const RouteKey = ServiceKey<RouteMsg>("actor-route/test-service")

const RouteMsg = TaggedEnumClass("RouteMsg", {
  Inc: {},
  Get: {},
})
type RouteMsg = Schema.Schema.Type<typeof RouteMsg>

interface RouteState {
  readonly count: number
}

// Reply latch: lets the test observe a `tell`-delivered Inc landing in
// the actor without polling. Stored in a closure-captured Deferred so
// the Behavior reads it from `receive`.
const makeRouteBehavior = (
  bumped: Deferred.Deferred<number>,
): Behavior<RouteMsg, RouteState, never> => ({
  initialState: { count: 0 },
  serviceKey: RouteKey,
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "Inc": {
          const next = { count: state.count + 1 }
          yield* Deferred.succeed(bumped, next.count)
          return next
        }
        case "Get":
          yield* ctx.reply(state.count)
          return state
      }
    }) as Effect.Effect<RouteState, never, never>,
})

const Inc = ExtensionMessage.command("actor-route/test", "Inc", {})
const Get = ExtensionMessage.reply("actor-route/test", "Get", {}, Schema.Number)

const makeLoaded = (bumped: Deferred.Deferred<number>): LoadedExtension =>
  ({
    manifest: { id: ExtensionId.make("actor-route/test") },
    contributions: {
      actors: [makeRouteBehavior(bumped)],
      protocols: { Inc, Get },
    },
    scope: "builtin",
    sourcePath: "test",
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: only fields read by ActorRouter + ActorHost matter
  }) as unknown as LoadedExtension

const makeResolved = (extensions: ReadonlyArray<LoadedExtension>): ResolvedExtensions =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: ActorHost only walks `extensions`
  ({ extensions }) as unknown as ResolvedExtensions

describe("ActorRouter — actor-route fallback", () => {
  test("send dispatches an ExtensionMessage to the live actor via Receptionist", async () => {
    const bumped = await Effect.runPromise(Deferred.make<number>())
    const ext = makeLoaded(bumped)
    const resolved = makeResolved([ext])

    const layer = ActorRouter.fromExtensions([ext]).pipe(
      Layer.provideMerge(ExtensionTurnControl.Live),
      Layer.provideMerge(ActorHost.fromResolved(resolved)),
      Layer.provideMerge(ActorEngine.Live),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorRouter
          yield* engine.send(sessionId, Inc.make(), branchId)
          const observed = yield* Deferred.await(bumped)
          expect(observed).toBe(1)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("execute routes an ask through the actor and decodes the reply", async () => {
    const bumped = await Effect.runPromise(Deferred.make<number>())
    const ext = makeLoaded(bumped)
    const resolved = makeResolved([ext])

    const layer = ActorRouter.fromExtensions([ext]).pipe(
      Layer.provideMerge(ExtensionTurnControl.Live),
      Layer.provideMerge(ActorHost.fromResolved(resolved)),
      Layer.provideMerge(ActorEngine.Live),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorRouter
          yield* engine.send(sessionId, Inc.make(), branchId)
          yield* Deferred.await(bumped)
          const count = yield* engine.execute(sessionId, Get.make(), branchId)
          expect(count).toBe(1)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("execute on an unknown extension fails with a protocol error", async () => {
    // No extension matching the message — neither FSM nor actor route.
    const Ping = ExtensionMessage.reply("actor-route/missing", "Ping", {}, Schema.Number)

    const layer = ActorRouter.fromExtensions([]).pipe(
      Layer.provideMerge(ExtensionTurnControl.Live),
      Layer.provideMerge(ActorEngine.Live),
    )

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorRouter
          return yield* engine.execute(sessionId, Ping.make(), branchId)
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const fails = exit.cause.reasons.filter(Cause.isFailReason)
      const found = fails.find((r) => r.error instanceof ExtensionProtocolError)
      expect(found).toBeDefined()
    }
  })
})
