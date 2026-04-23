/**
 * Tests for extension runtime concurrency:
 * - concurrent actor spawn for the same session
 * - ordered delivery across actor restarts
 */
import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { EventStore, SessionStarted, TurnCompleted } from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import {
  MachineEngine,
  type MachineEngineService,
} from "@gent/core/runtime/extensions/resource-host/machine-engine"
import {
  collectSubscriptions,
  SubscriptionEngine,
} from "@gent/core/runtime/extensions/resource-host"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { defineResource } from "@gent/core/domain/contribution"
import { reducerActor } from "./helpers/reducer-actor"

const sessionId = SessionId.of("test-session")
const branchId = BranchId.of("test-branch")

const makeRuntimeLayer = (
  extensions: Parameters<typeof MachineEngine.fromExtensions>[0],
): Layer.Layer<MachineEngine | SubscriptionEngine | ExtensionTurnControl> => {
  const turnControl = ExtensionTurnControl.Test()
  return Layer.mergeAll(
    MachineEngine.fromExtensions(extensions).pipe(Layer.provideMerge(turnControl)),
    SubscriptionEngine.withSubscriptions(collectSubscriptions(extensions)),
    turnControl,
  )
}

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
            scope: "builtin" as const,
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

  describe("same-session mailbox reentrancy", () => {
    it.live("nested publish from a subscription handler is queued without deadlocking", () =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>()
        let runtimeRef: MachineEngineService | undefined

        const extensions = [
          {
            manifest: { id: "nested-publisher", version: "1.0.0" },
            scope: "builtin" as const,
            sourcePath: "builtin",
            contributions: {
              resources: [
                defineResource({
                  scope: "process",
                  layer: Layer.empty as Layer.Layer<unknown>,
                  subscriptions: [
                    {
                      pattern: "nested:publish",
                      handler: (envelope) =>
                        Effect.gen(function* () {
                          if (
                            runtimeRef === undefined ||
                            envelope.sessionId === undefined ||
                            envelope.branchId === undefined
                          ) {
                            return yield* Effect.die("nested publish test runtime missing")
                          }
                          yield* runtimeRef.publish(
                            new TurnCompleted({
                              sessionId: envelope.sessionId,
                              branchId: envelope.branchId,
                              durationMs: 1,
                            }),
                            { sessionId: envelope.sessionId, branchId: envelope.branchId },
                          )
                        }),
                    },
                  ],
                  machine: reducerActor({
                    id: "nested-publisher",
                    initial: { phase: "idle" as "idle" | "started" | "completed" },
                    reduce: (state, event) => {
                      if (event._tag === "SessionStarted" && state.phase === "idle") {
                        return { state: { phase: "started" as const } }
                      }
                      if (event._tag === "TurnCompleted") {
                        Effect.runSync(Deferred.succeed(completed, void 0).pipe(Effect.ignore))
                        return { state: { phase: "completed" as const } }
                      }
                      return { state }
                    },
                    afterTransition: (before, after) =>
                      before.phase === "idle" && after.phase === "started"
                        ? [{ _tag: "BusEmit", channel: "nested:publish", payload: undefined }]
                        : [],
                  }),
                }),
              ],
            },
          },
        ] as Parameters<typeof MachineEngine.fromExtensions>[0]

        const layer = makeRuntimeLayer(extensions)

        yield* Effect.gen(function* () {
          const runtime = yield* MachineEngine
          runtimeRef = runtime

          yield* runtime
            .publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId })
            .pipe(Effect.timeout("1 second"))
          yield* Deferred.await(completed).pipe(Effect.timeout("1 second"))
        }).pipe(Effect.provide(layer))
      }),
    )

    it.live("nested publish preserves outer event ordering across actors", () =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>()
        const observerEvents: string[] = []
        let runtimeRef: MachineEngineService | undefined

        const extensions = [
          {
            manifest: { id: "ordering-publisher", version: "1.0.0" },
            scope: "builtin" as const,
            sourcePath: "builtin",
            contributions: {
              resources: [
                defineResource({
                  scope: "process",
                  layer: Layer.empty as Layer.Layer<unknown>,
                  subscriptions: [
                    {
                      pattern: "nested:publish:ordered",
                      handler: (envelope) =>
                        Effect.gen(function* () {
                          if (
                            runtimeRef === undefined ||
                            envelope.sessionId === undefined ||
                            envelope.branchId === undefined
                          ) {
                            return yield* Effect.die("nested publish ordering test runtime missing")
                          }
                          const transitioned = yield* runtimeRef.publish(
                            new TurnCompleted({
                              sessionId: envelope.sessionId,
                              branchId: envelope.branchId,
                              durationMs: 1,
                            }),
                            { sessionId: envelope.sessionId, branchId: envelope.branchId },
                          )
                          expect(transitioned).toEqual([])
                        }),
                    },
                  ],
                  machine: reducerActor({
                    id: "ordering-publisher",
                    initial: { started: false },
                    reduce: (state, event) =>
                      event._tag === "SessionStarted" && !state.started
                        ? { state: { started: true } }
                        : { state },
                    afterTransition: (before, after) =>
                      !before.started && after.started
                        ? [
                            {
                              _tag: "BusEmit",
                              channel: "nested:publish:ordered",
                              payload: undefined,
                            },
                          ]
                        : [],
                  }),
                }),
              ],
            },
          },
          {
            manifest: { id: "ordering-observer", version: "1.0.0" },
            scope: "builtin" as const,
            sourcePath: "builtin",
            contributions: {
              resources: [
                defineResource({
                  scope: "process",
                  layer: Layer.empty as Layer.Layer<unknown>,
                  machine: reducerActor({
                    id: "ordering-observer",
                    initial: { seen: [] as string[] },
                    reduce: (state, event) => {
                      const nextSeen = [...state.seen, event._tag]
                      observerEvents.push(event._tag)
                      if (event._tag === "TurnCompleted") {
                        Effect.runSync(Deferred.succeed(completed, void 0).pipe(Effect.ignore))
                      }
                      return { state: { seen: nextSeen } }
                    },
                  }),
                }),
              ],
            },
          },
        ] as Parameters<typeof MachineEngine.fromExtensions>[0]

        const layer = makeRuntimeLayer(extensions)

        yield* Effect.gen(function* () {
          const runtime = yield* MachineEngine
          runtimeRef = runtime

          const transitioned = yield* runtime
            .publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId })
            .pipe(Effect.timeout("1 second"))
          expect(transitioned).toContain("ordering-publisher")
          expect(transitioned).toContain("ordering-observer")

          yield* Deferred.await(completed).pipe(Effect.timeout("1 second"))
          expect(observerEvents).toEqual(["SessionStarted", "TurnCompleted"])
        }).pipe(Effect.provide(layer))
      }),
    )

    it.live("nested send from a subscription handler is delivered without deadlocking", () =>
      Effect.gen(function* () {
        const received = yield* Deferred.make<void>()
        let runtimeRef: MachineEngineService | undefined
        const RecordNested = ExtensionMessage("nested-receiver", "RecordNested", {})

        const extensions = [
          {
            manifest: { id: "nested-sender", version: "1.0.0" },
            scope: "builtin" as const,
            sourcePath: "builtin",
            contributions: {
              resources: [
                defineResource({
                  scope: "process",
                  layer: Layer.empty as Layer.Layer<unknown>,
                  subscriptions: [
                    {
                      pattern: "nested:send",
                      handler: (envelope) =>
                        Effect.gen(function* () {
                          if (
                            runtimeRef === undefined ||
                            envelope.sessionId === undefined ||
                            envelope.branchId === undefined
                          ) {
                            return yield* Effect.die("nested send test runtime missing")
                          }
                          yield* runtimeRef.send(
                            envelope.sessionId,
                            RecordNested(),
                            envelope.branchId,
                          )
                        }),
                    },
                  ],
                  machine: reducerActor({
                    id: "nested-sender",
                    initial: { sent: false },
                    reduce: (state, event) =>
                      event._tag === "SessionStarted" && !state.sent
                        ? { state: { sent: true } }
                        : { state },
                    afterTransition: (before, after) =>
                      !before.sent && after.sent
                        ? [{ _tag: "BusEmit", channel: "nested:send", payload: undefined }]
                        : [],
                  }),
                }),
              ],
            },
          },
          {
            manifest: { id: "nested-receiver", version: "1.0.0" },
            scope: "builtin" as const,
            sourcePath: "builtin",
            contributions: {
              resources: [
                defineResource({
                  scope: "process",
                  layer: Layer.empty as Layer.Layer<unknown>,
                  machine: {
                    ...reducerActor<{ received: boolean }, ReturnType<typeof RecordNested>>({
                      id: "nested-receiver",
                      initial: { received: false },
                      reduce: (state) => ({ state }),
                      receive: () => {
                        Effect.runSync(Deferred.succeed(received, void 0).pipe(Effect.ignore))
                        return { state: { received: true } }
                      },
                    }),
                    protocols: { RecordNested },
                  },
                }),
              ],
            },
          },
        ] as Parameters<typeof MachineEngine.fromExtensions>[0]

        const layer = makeRuntimeLayer(extensions)

        yield* Effect.gen(function* () {
          const runtime = yield* MachineEngine
          runtimeRef = runtime

          yield* runtime
            .publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId })
            .pipe(Effect.timeout("1 second"))
          yield* Deferred.await(received).pipe(Effect.timeout("1 second"))
        }).pipe(Effect.provide(layer))
      }),
    )

    it.live("nested execute from a subscription handler is delivered without deadlocking", () =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>()
        let runtimeRef: MachineEngineService | undefined
        const ReadNested = ExtensionMessage.reply(
          "nested-executor",
          "ReadNested",
          {},
          Schema.Struct({ ok: Schema.Boolean }),
        )

        const extensions = [
          {
            manifest: { id: "nested-caller", version: "1.0.0" },
            scope: "builtin" as const,
            sourcePath: "builtin",
            contributions: {
              resources: [
                defineResource({
                  scope: "process",
                  layer: Layer.empty as Layer.Layer<unknown>,
                  subscriptions: [
                    {
                      pattern: "nested:execute",
                      handler: (envelope) =>
                        Effect.gen(function* () {
                          if (
                            runtimeRef === undefined ||
                            envelope.sessionId === undefined ||
                            envelope.branchId === undefined
                          ) {
                            return yield* Effect.die("nested execute test runtime missing")
                          }
                          const reply = yield* runtimeRef.execute(
                            envelope.sessionId,
                            ReadNested(),
                            envelope.branchId,
                          )
                          expect(reply).toEqual({ ok: true })
                          yield* Deferred.succeed(completed, void 0)
                        }),
                    },
                  ],
                  machine: reducerActor({
                    id: "nested-caller",
                    initial: { started: false },
                    reduce: (state, event) =>
                      event._tag === "SessionStarted" && !state.started
                        ? { state: { started: true } }
                        : { state },
                    afterTransition: (before, after) =>
                      !before.started && after.started
                        ? [{ _tag: "BusEmit", channel: "nested:execute", payload: undefined }]
                        : [],
                  }),
                }),
              ],
            },
          },
          {
            manifest: { id: "nested-executor", version: "1.0.0" },
            scope: "builtin" as const,
            sourcePath: "builtin",
            contributions: {
              resources: [
                defineResource({
                  scope: "process",
                  layer: Layer.empty as Layer.Layer<unknown>,
                  machine: {
                    ...reducerActor<{ reads: number }, never, ReturnType<typeof ReadNested>>({
                      id: "nested-executor",
                      initial: { reads: 0 },
                      reduce: (state) => ({ state }),
                      request: (state) =>
                        Effect.succeed({
                          state: { reads: state.reads + 1 },
                          reply: { ok: true },
                        }),
                    }),
                    protocols: { ReadNested },
                  },
                }),
              ],
            },
          },
        ] as Parameters<typeof MachineEngine.fromExtensions>[0]

        const layer = makeRuntimeLayer(extensions)

        yield* Effect.gen(function* () {
          const runtime = yield* MachineEngine
          runtimeRef = runtime

          yield* runtime
            .publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId })
            .pipe(Effect.timeout("1 second"))
          yield* Deferred.await(completed).pipe(Effect.timeout("1 second"))
        }).pipe(Effect.provide(layer))
      }),
    )

    it.live("concurrent same-session execute calls do not overlap actor critical sections", () =>
      Effect.gen(function* () {
        const firstEntered = yield* Deferred.make<void>()
        const secondEntered = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        let activeRequests = 0
        let overlapped = false
        const ReadSerial = ExtensionMessage.reply(
          "serialized-executor",
          "ReadSerial",
          {},
          Schema.Struct({ order: Schema.Number }),
        )

        const extensions = [
          {
            manifest: { id: "serialized-executor", version: "1.0.0" },
            scope: "builtin" as const,
            sourcePath: "builtin",
            contributions: {
              resources: [
                defineResource({
                  scope: "process",
                  layer: Layer.empty as Layer.Layer<unknown>,
                  machine: {
                    ...reducerActor<{ reads: number }, never, ReturnType<typeof ReadSerial>>({
                      id: "serialized-executor",
                      initial: { reads: 0 },
                      reduce: (state) => ({ state }),
                      request: (state) =>
                        Effect.gen(function* () {
                          activeRequests += 1
                          if (activeRequests > 1) overlapped = true

                          if (state.reads === 0) {
                            yield* Deferred.succeed(firstEntered, void 0)
                            yield* Deferred.await(releaseFirst)
                          } else {
                            yield* Deferred.succeed(secondEntered, void 0)
                          }

                          activeRequests -= 1
                          return {
                            state: { reads: state.reads + 1 },
                            reply: { order: state.reads + 1 },
                          }
                        }),
                    }),
                    protocols: { ReadSerial },
                  },
                }),
              ],
            },
          },
        ] as Parameters<typeof MachineEngine.fromExtensions>[0]

        const layer = makeRuntimeLayer(extensions)

        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* MachineEngine
            const first = yield* Effect.forkScoped(
              runtime.execute(sessionId, ReadSerial(), branchId).pipe(Effect.timeout("1 second")),
            )

            yield* Deferred.await(firstEntered).pipe(Effect.timeout("1 second"))

            const second = yield* Effect.forkScoped(
              runtime.execute(sessionId, ReadSerial(), branchId).pipe(Effect.timeout("1 second")),
            )

            yield* Effect.yieldNow
            expect(yield* Deferred.isDone(secondEntered)).toBe(false)
            expect(overlapped).toBe(false)

            yield* Deferred.succeed(releaseFirst, void 0)

            expect(yield* Fiber.join(first)).toEqual({ order: 1 })
            expect(yield* Fiber.join(second)).toEqual({ order: 2 })
            expect(yield* Deferred.await(secondEntered).pipe(Effect.timeout("1 second"))).toBe(
              undefined,
            )
            expect(overlapped).toBe(false)
          }),
        ).pipe(Effect.provide(layer))
      }),
    )
  })
})
