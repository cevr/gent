/**
 * Tests for extension runtime concurrency:
 * - concurrent actor spawn for the same session
 * - ordered delivery across actor restarts
 */
import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Layer } from "effect"
import { EventStore, SessionStarted, TurnCompleted } from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { defineResource } from "@gent/core/domain/contribution"
import { reducerActor } from "./helpers/reducer-actor"

const sessionId = SessionId.of("test-session")
const branchId = BranchId.of("test-branch")

describe("extension concurrency", () => {
  describe("actor spawn serialization", () => {
    it.live("concurrent reduce calls for same session share actors", () => {
      let spawnCount = 0
      const actor = reducerActor<{ count: number }>({
        id: "counter",
        initial: { count: 0 },
        reduce: (state, event) =>
          event._tag === "SessionStarted" ? { state: { count: state.count + 1 } } : { state },
      })

      const wrappedActor = {
        ...actor,
        slots: () =>
          Effect.sync(() => {
            spawnCount++
            return {}
          }),
      }

      const extensions = [
        {
          manifest: { id: "counter", version: "1.0.0" },
          contributions: {
            resources: [
              defineResource({
                scope: "process",
                layer: Layer.empty as Layer.Layer<unknown>,
                machine: wrappedActor,
              }),
            ],
          },
        },
      ] as Parameters<typeof MachineEngine.fromExtensions>[0]

      const layer = Layer.provide(
        MachineEngine.fromExtensions(extensions),
        ExtensionTurnControl.Test(),
      )

      return Effect.gen(function* () {
        const runtime = yield* MachineEngine
        const event = new SessionStarted({ sessionId, branchId })
        const ctx = { sessionId, branchId }

        const [r1, r2] = yield* Effect.all(
          [runtime.publish(event, ctx), runtime.publish(event, ctx)],
          { concurrency: 2 },
        )

        expect(spawnCount).toBe(1)
        // publish() now returns the IDs of extensions whose machines transitioned.
        // At least one of the concurrent publishes should have caused a transition.
        expect(r1.length + r2.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(layer))
    })
  })

  describe("delivery ordering across restarts", () => {
    it.live("runtime restart preserves same-session delivery ordering", () =>
      Effect.gen(function* () {
        const delivered: string[] = []
        const firstDeliveryEntered = yield* Deferred.make<void>()
        let first = true

        const extensions = [
          {
            manifest: { id: "ordered-restart", version: "1.0.0" },
            kind: "builtin" as const,
            sourcePath: "builtin",
            contributions: {
              resources: [
                defineResource({
                  scope: "process",
                  layer: Layer.empty as Layer.Layer<unknown>,
                  machine: reducerActor({
                    id: "ordered-restart",
                    initial: { delivered: [] as string[] },
                    reduce: (state, event) => {
                      if (first && event._tag === "SessionStarted") {
                        first = false
                        Effect.runSync(
                          Deferred.succeed(firstDeliveryEntered, void 0).pipe(Effect.ignore),
                        )
                        throw new Error("first delivery boom")
                      }
                      delivered.push(event._tag)
                      return { state: { delivered } }
                    },
                  }),
                }),
              ],
            },
          },
        ] as Parameters<typeof MachineEngine.fromExtensions>[0]

        const registryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
        const baseLayer = Layer.mergeAll(
          MachineEngine.fromExtensions(extensions).pipe(
            Layer.provideMerge(ExtensionTurnControl.Test()),
          ),
          EventStore.Memory,
          registryLayer,
          RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        )
        const layer = Layer.merge(baseLayer, Layer.provide(EventPublisherLive, baseLayer))

        yield* Effect.gen(function* () {
          const publisher = yield* EventPublisher
          const runtime = yield* MachineEngine

          yield* Effect.all(
            [
              publisher.publish(new SessionStarted({ sessionId, branchId })),
              Deferred.await(firstDeliveryEntered).pipe(
                Effect.andThen(
                  publisher.publish(new TurnCompleted({ sessionId, branchId, durationMs: 25 })),
                ),
              ),
            ],
            { concurrency: 2 },
          )

          const statuses = yield* runtime.getActorStatuses(sessionId)
          expect(delivered).toEqual(["SessionStarted", "TurnCompleted"])
          expect(statuses).toEqual([
            {
              extensionId: "ordered-restart",
              sessionId,
              branchId,
              status: "running",
              restartCount: 1,
            },
          ])
        }).pipe(Effect.provide(layer))
      }),
    )
  })
})
