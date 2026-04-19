import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { ExtensionMessage, ExtensionProtocolError } from "@gent/core/domain/extension-protocol"
import { SessionStarted } from "@gent/core/domain/event"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import type { LoadedExtension } from "@gent/core/domain/extension"
import { WorkflowRuntime } from "@gent/core/runtime/extensions/workflow-runtime"
import { spawnMachineExtensionRef } from "@gent/core/runtime/extensions/spawn-machine-ref"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { defineResource } from "@gent/core/domain/contribution"
import type { AnyResourceMachine } from "@gent/core/extensions/api"
import { reducerActor } from "./helpers/reducer-actor"
import { makeActorRuntimeLayer } from "./helpers/actor-runtime-layer"

// ============================================================================
// Shared fixtures
// ============================================================================

const sessionId = SessionId.of("test-session")
const branchId = BranchId.of("test-branch")
const testLayer = ExtensionTurnControl.Test()

const makeCounterActor = (id: string) =>
  reducerActor({
    id,
    initial: { count: 0 },
    stateSchema: Schema.Struct({ count: Schema.Number }),
    reduce: (state, event) =>
      event._tag === "SessionStarted" || event._tag === "TurnCompleted"
        ? { state: { count: state.count + 1 } }
        : { state },
    derive: (state) => ({ uiModel: state }),
  })

const makeRuntimeLayer = (extensions: LoadedExtension[]) => makeActorRuntimeLayer({ extensions })

// ============================================================================
// spawnMachineExtensionRef — actor boundary
// ============================================================================

describe("spawnMachineExtensionRef", () => {
  it.live("publish advances state and epoch", () =>
    Effect.gen(function* () {
      const actor = yield* spawnMachineExtensionRef("counter", makeCounterActor("counter"), {
        sessionId,
        branchId,
      }).pipe(Effect.provide(testLayer))

      yield* actor.start

      const before = yield* actor.snapshot
      expect(before.state).toEqual({ _tag: "Active", value: { count: 0 } })
      expect(before.epoch).toBe(0)

      const changed = yield* actor.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      expect(changed).toBe(true)

      const after = yield* actor.snapshot
      expect(after.state).toEqual({ _tag: "Active", value: { count: 1 } })
      expect(after.epoch).toBe(1)
    }),
  )

  it.live("same-state transition keeps epoch stable", () =>
    Effect.gen(function* () {
      const actor = yield* spawnMachineExtensionRef(
        "stable",
        reducerActor({
          id: "stable",
          initial: { value: "unchanged" },
          stateSchema: Schema.Struct({ value: Schema.String }),
          reduce: (state) => ({ state }),
          derive: (state) => ({ uiModel: state }),
        }),
        { sessionId, branchId },
      ).pipe(Effect.provide(testLayer))

      yield* actor.start
      const changed = yield* actor.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      expect(changed).toBe(false)

      const snapshot = yield* actor.snapshot
      expect(snapshot.epoch).toBe(0)
    }),
  )

  it.live("cold actor rejects use before start", () =>
    Effect.gen(function* () {
      const Ping = ExtensionMessage.reply("cold-start", "Ping", {}, Schema.Void)
      const actor = yield* spawnMachineExtensionRef(
        "cold-start",
        reducerActor({
          id: "cold-start",
          initial: { value: "cold" },
          stateSchema: Schema.Struct({ value: Schema.String }),
          reduce: (state) => ({ state }),
        }),
        { sessionId, branchId },
      ).pipe(Effect.provide(testLayer))

      const effects = [
        actor.publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId }),
        actor.send({ extensionId: "cold-start", _tag: "Message" }),
        actor.ask(Ping()),
        actor.snapshot,
      ] as const

      for (const effect of effects) {
        const exit = yield* effect.pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(ExtensionProtocolError)
          expect((error as ExtensionProtocolError).phase).toBe("lifecycle")
        }
      }
    }),
  )

  it.live("ask returns replies through the actor boundary", () =>
    Effect.gen(function* () {
      const Increment = ExtensionMessage.reply(
        "counter",
        "Increment",
        { delta: Schema.Number },
        Schema.Struct({ count: Schema.Number }),
      )

      const actor = yield* spawnMachineExtensionRef(
        "counter",
        reducerActor<{ count: number }, never, ReturnType<typeof Increment>>({
          id: "counter",
          initial: { count: 0 },
          stateSchema: Schema.Struct({ count: Schema.Number }),
          reduce: (state) => ({ state }),
          request: (state, message) =>
            Effect.succeed({
              state: { count: state.count + message.delta },
              reply: { count: state.count + message.delta },
            }),
        }),
        { sessionId, branchId },
      ).pipe(Effect.provide(testLayer))

      yield* actor.start
      const reply = yield* actor.ask(Increment({ delta: 2 }))
      expect(reply).toEqual({ count: 2 })
    }),
  )
})

// ============================================================================
// WorkflowRuntime — supervisor behavior (UI snapshot tests removed in C2)
// ============================================================================

describe("WorkflowRuntime", () => {
  it.live("ask failure restarts once and retries", () => {
    const Ping = ExtensionMessage.reply(
      "flaky-request",
      "Ping",
      {},
      Schema.Struct({ count: Schema.Number }),
    )
    let first = true
    const flaky = reducerActor<{ count: number }, never, ReturnType<typeof Ping>>({
      id: "flaky-request",
      initial: { count: 0 },
      stateSchema: Schema.Struct({ count: Schema.Number }),
      reduce: (state) => ({ state }),
      request: (state) => {
        if (first) {
          first = false
          throw new Error("reply boom")
        }
        return Effect.succeed({
          state: { count: state.count + 1 },
          reply: { count: state.count + 1 },
        })
      },
      derive: (state) => ({ uiModel: state }),
    })

    const layer = makeRuntimeLayer([
      {
        manifest: { id: "flaky-request" },
        kind: "builtin",
        sourcePath: "builtin",
        contributions: {
          resources: [
            defineResource({
              scope: "process",
              layer: Layer.empty as Layer.Layer<unknown>,
              machine: { ...flaky, protocols: { Ping } },
            }),
          ],
        },
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      const reply = yield* runtime.ask(sessionId, Ping({}), branchId)
      const statuses = yield* runtime.getActorStatuses(sessionId)

      expect(reply).toEqual({ count: 1 })
      expect(statuses).toEqual([
        {
          extensionId: "flaky-request",
          sessionId,
          branchId,
          status: "running",
          restartCount: 1,
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.live("invalid replies are rejected against the registered protocol", () => {
    const GetCount = ExtensionMessage.reply(
      "counter",
      "GetCount",
      {},
      Schema.Struct({ count: Schema.Number }),
    )

    const layer = makeRuntimeLayer([
      {
        manifest: { id: "counter" },
        kind: "builtin",
        sourcePath: "builtin",
        contributions: {
          resources: [
            defineResource({
              scope: "process",
              layer: Layer.empty as Layer.Layer<unknown>,
              machine: {
                ...reducerActor<{ count: number }, never, ReturnType<typeof GetCount>>({
                  id: "counter",
                  initial: { count: 0 },
                  stateSchema: Schema.Struct({ count: Schema.Number }),
                  reduce: (state) => ({ state }),
                  request: (state) =>
                    Effect.succeed({
                      state,
                      reply: { count: "not-a-number" } as unknown,
                    }),
                }),
                protocols: { GetCount },
              },
            }),
          ],
        },
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      const exit = yield* runtime.ask(sessionId, GetCount(), branchId).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(error)).toBe(true)
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(ExtensionProtocolError)
          expect(error.value.phase).toBe("reply")
        }
      }
    }).pipe(Effect.provide(layer))
  })
})

// ============================================================================
// Resource.machine — end-to-end via WorkflowRuntime (C3.5a integration test)
//
// Codex C3.5a BLOCK 2 — the Resource.machine path needs an integration test
// that drives a real `effect-machine` machine through the runtime, not just
// a stub round-trip. Mirror of "ask returns replies through the runtime"
// above, with the machine declared via `defineResource({ machine })`.
// ============================================================================

describe("Resource.machine end-to-end", () => {
  const Increment = ExtensionMessage.reply(
    "resource-counter",
    "Increment",
    { delta: Schema.Number },
    Schema.Struct({ count: Schema.Number }),
  )

  const counterMachine: AnyResourceMachine = {
    ...reducerActor<{ count: number }, never, ReturnType<typeof Increment>>({
      id: "resource-counter",
      initial: { count: 0 },
      stateSchema: Schema.Struct({ count: Schema.Number }),
      reduce: (state) => ({ state }),
      request: (state, message) =>
        Effect.succeed({
          state: { count: state.count + message.delta },
          reply: { count: state.count + message.delta },
        }),
    }),
    protocols: { Increment },
  }

  it.live("ask routes through a Resource.machine and returns the reply", () => {
    const layer = makeRuntimeLayer([
      {
        manifest: { id: "resource-counter" },
        kind: "builtin",
        sourcePath: "builtin",
        contributions: {
          resources: [
            // No-service Resource carrying just the machine. WorkflowRuntime
            // supervises the machine; the empty layer keeps the Resource shape
            // valid without contributing any service tags. The explicit
            // `<unknown, "process">` widening dodges `Layer<never,...>` →
            // `AnyResourceContribution` variance traps.
            defineResource<unknown, "process">({
              scope: "process",
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              layer: Layer.empty as Layer.Layer<unknown>,
              machine: counterMachine,
            }),
          ],
        },
      } as LoadedExtension,
    ])

    return Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      const reply = yield* runtime.ask(sessionId, Increment({ delta: 3 }), branchId)
      expect(reply).toEqual({ count: 3 })

      const replyAgain = yield* runtime.ask(sessionId, Increment({ delta: 2 }), branchId)
      expect(replyAgain).toEqual({ count: 5 })
    }).pipe(Effect.provide(layer))
  })

  it.live(
    "publish on a session with a Resource.machine reports the extensionId when state transitions",
    () => {
      // Counter that actually transitions on SessionStarted (matches the
      // long-running counter pattern at the top of the file). If the
      // Resource.machine path is broken, the actor won't spawn or won't
      // be in the changed list.
      const sessionCounter: AnyResourceMachine = {
        ...makeCounterActor("session-counter"),
      }
      const layer = makeRuntimeLayer([
        {
          manifest: { id: "session-counter" },
          kind: "builtin",
          sourcePath: "builtin",
          contributions: {
            resources: [
              defineResource<unknown, "process">({
                scope: "process",
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                layer: Layer.empty as Layer.Layer<unknown>,
                machine: sessionCounter,
              }),
            ],
          },
        } as LoadedExtension,
      ])

      return Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime
        const changed = yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        expect(changed).toContain("session-counter")
      }).pipe(Effect.provide(layer))
    },
  )
})
