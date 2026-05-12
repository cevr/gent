import { test } from "bun:test"
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  type LanguageModelStreamPart,
} from "@gent/core-internal/test-utils/language-model"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import { EventStore, MessageReceived } from "@gent/core-internal/domain/event"
import { EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { ActorCommandId, BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids"
import { AgentLoopTestActor } from "../../../src/runtime/agent/agent-loop.actor"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { RuntimeEnvironment } from "../../../src/runtime/runtime-environment"
import { ConfigService } from "../../../src/runtime/config-service"
import { ToolRunner } from "../../../src/runtime/agent/tool-runner"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import {
  makeAgentLoopService,
  makeExtRegistry,
  submitAgentLoop,
  waitFor,
  waitForPhase,
} from "./helpers"
import {
  LoopQueueState,
  type LoopQueueState as LoopQueueStateType,
} from "../../../src/runtime/agent/agent-loop.state"
import { AgentLoopQueueStorage } from "../../../src/storage/agent-loop-queue-storage"
import { StorageError } from "../../../src/domain/storage-error"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import {
  assistantMessageIdForCommand,
  toolCallIdForCommand,
  toolResultMessageIdForCommand,
  toolResultMessageIdForToolCall,
} from "../../../src/runtime/agent/agent-loop.utils"

const emptyPersistedQueue = (): LoopQueueStateType =>
  LoopQueueState.make({ steering: [], followUp: [] })

describe("agent loop command ids", () => {
  test("derive stable message and tool ids", () => {
    const commandId = ActorCommandId.make("test-command-id")

    expect(String(toolCallIdForCommand(commandId))).toBe(String(commandId))
    expect(String(assistantMessageIdForCommand(commandId))).toBe(`${commandId}:assistant`)
    expect(String(toolResultMessageIdForCommand(commandId))).toBe(`${commandId}:tool-result`)
    expect(String(toolResultMessageIdForToolCall(toolCallIdForCommand(commandId)))).toBe(
      `tool-call:${commandId}:tool-result`,
    )
  })
})

describe("queue drain regression", () => {
  it.live(
    "multiple submits during a Running turn drain in submission order after TurnDone",
    () =>
      Effect.gen(function* () {
        const drainSessionId = SessionId.make("session-loop-drain")
        const drainBranchId = BranchId.make("branch-loop-drain")
        // Provider gates each turn on a per-turn Deferred so the test can
        // serialize "submit while Running" semantics deterministically.
        // First model stream call is gated by gates[0], second by gates[1], etc.
        // Each call records its index into `streamOrder` and returns a
        // simple text+stop response when its gate resolves.
        const gates = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ]
        const streamOrder = yield* Ref.make<readonly number[]>([])
        const streamCallRef = yield* Ref.make(0)
        const gatedProvider = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            const idx = yield* Ref.getAndUpdate(streamCallRef, (n) => n + 1)
            yield* Ref.update(streamOrder, (arr) => [...arr, idx])
            const gate = gates[idx]
            if (gate !== undefined) {
              yield* Deferred.await(gate)
            }
            return Stream.fromIterable([
              textDeltaPart(`turn-${idx}`),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(),
          gatedProvider,
          ModelResolver.fromLanguageModel(gatedProvider),
          makeExtRegistry(),
          RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          BunServices.layer,
          ModelRegistry.Test(),
          GentPlatform.Test(),
        )
        const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
        const layer = AgentLoopTestActor({ baseSections: [] }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
          ),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            // `interactive: true` disables follow-up batching in
            // `canBatchQueuedFollowUp` — without it, multiple plain-text
            // user submits collapse into a single combined turn before
            // they ever hit the queue drain.
            const submitOne = (id: string, text: string) =>
              submitAgentLoop(
                agentLoop,
                Message.cases.regular.make({
                  id: MessageId.make(id),
                  sessionId: drainSessionId,
                  branchId: drainBranchId,
                  role: "user",
                  parts: [Prompt.textPart({ text })],
                  createdAt: dateFromMillis(1_767_225_600_000),
                }),
                { interactive: true },
              )
            // Submit turn #0; wait until the provider's model stream has
            // actually been entered (parked on gate[0]). Phase transitions
            // to Running before model streaming starts, so we poll on
            // streamCallRef instead.
            yield* submitOne("msg-drain-0", "first")
            yield* waitFor(
              () =>
                Effect.gen(function* () {
                  const count = yield* Ref.get(streamCallRef)
                  return count >= 1 ? count : undefined
                }),
              "model stream call #0 to start",
              200,
            )
            expect(yield* Ref.get(streamCallRef)).toBe(1)
            // Submit #1, #2, #3 while #0 is still parked. They MUST
            // enqueue (Running → Running re-enter) — they cannot start
            // a new model stream until #0's gate releases.
            yield* submitOne("msg-drain-1", "second")
            yield* submitOne("msg-drain-2", "third")
            yield* submitOne("msg-drain-3", "fourth")
            // Confirm model streaming was not re-entered.
            expect(yield* Ref.get(streamCallRef)).toBe(1)
            // Release all gates. Drain proceeds: #0 → #1 → #2 → #3.
            yield* Deferred.succeed(gates[0]!, void 0)
            yield* Deferred.succeed(gates[1]!, void 0)
            yield* Deferred.succeed(gates[2]!, void 0)
            yield* Deferred.succeed(gates[3]!, void 0)
            // Wait for full drain: stream call count must reach 4 and
            // loop returns to Idle.
            yield* waitForPhase(
              agentLoop,
              { sessionId: drainSessionId, branchId: drainBranchId },
              "Idle",
            )
            const finalCount = yield* Ref.get(streamCallRef)
            expect(finalCount).toBe(4)
            const order = yield* Ref.get(streamOrder)
            expect(order).toEqual([0, 1, 2, 3])
            const queueStorage = yield* AgentLoopQueueStorage
            const queue = yield* queueStorage.getQueueState(drainSessionId, drainBranchId)
            expect(queue.inFlight).toBeUndefined()
            expect(queue.followUp).toEqual([])
            expect(queue.steering).toEqual([])
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "concurrent follow-up persistence keeps the full queue after actor restart",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-loop-persist-race")
        const branchId = BranchId.make("branch-loop-persist-race")
        const storedQueueRef = yield* Ref.make<LoopQueueStateType>(emptyPersistedQueue())
        const secondFollowUpStored = yield* Deferred.make<void>()
        const activeTurnReleased = yield* Deferred.make<void>()
        const queuedProvider = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            yield* Deferred.await(activeTurnReleased)
            return Stream.fromIterable([
              textDeltaPart("held"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const queueStorageLayer = Layer.succeed(
          AgentLoopQueueStorage,
          AgentLoopQueueStorage.of({
            getQueueState: () => Ref.get(storedQueueRef),
            putQueueState: (_sessionId, _branchId, queue) =>
              Effect.gen(function* () {
                const queuedFollowUps = queue.followUp.length
                if (queuedFollowUps === 1) {
                  yield* Deferred.await(secondFollowUpStored).pipe(
                    Effect.timeoutOption("10 millis"),
                  )
                }
                yield* Ref.set(storedQueueRef, queue)
                if (queuedFollowUps === 2) {
                  yield* Deferred.succeed(secondFollowUpStored, undefined).pipe(
                    Effect.catchEager(() => Effect.void),
                  )
                }
              }),
            clearQueueState: () => Ref.set(storedQueueRef, emptyPersistedQueue()),
          }),
        )
        const makeLayer = () => {
          const deps = Layer.mergeAll(
            SqliteStorage.TestWithSql(),
            queueStorageLayer,
            queuedProvider,
            ModelResolver.fromLanguageModel(queuedProvider),
            makeExtRegistry(),
            RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
            ConfigService.Test(),
            EventStore.Memory,
            ToolRunner.Test(),
            BunServices.layer,
            ModelRegistry.Test(),
            GentPlatform.Test(),
          )
          const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
          return AgentLoopTestActor({ baseSections: [] }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
            ),
          )
        }
        const makeMessage = (id: string, text: string) =>
          Message.cases.regular.make({
            id: MessageId.make(id),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text })],
            createdAt: dateFromMillis(1_767_225_600_000),
          })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* submitAgentLoop(agentLoop, makeMessage("msg-persist-race-0", "first"), {
              interactive: true,
            })
            const firstQueued = yield* Effect.forkChild(
              submitAgentLoop(agentLoop, makeMessage("msg-persist-race-1", "second"), {
                interactive: true,
              }),
            )
            const secondQueued = yield* Effect.forkChild(
              submitAgentLoop(agentLoop, makeMessage("msg-persist-race-2", "third"), {
                interactive: true,
              }),
            )
            yield* Fiber.join(firstQueued)
            yield* Fiber.join(secondQueued)
            expect((yield* agentLoop.getQueue({ sessionId, branchId })).followUp).toHaveLength(2)
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(makeLayer())),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            const recovered = yield* agentLoop.getQueue({ sessionId, branchId })
            expect(recovered.followUp.map((item) => item.content)).toEqual(["second", "third"])
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(makeLayer())),
        )
        yield* Deferred.succeed(activeTurnReleased, undefined).pipe(
          Effect.catchEager(() => Effect.void),
        )
      }),
    15000,
  )

  it.live(
    "startup resumes an incomplete user turn even after the queue token was cleared",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-loop-incomplete-recovery")
        const branchId = BranchId.make("branch-loop-incomplete-recovery")
        const providerCalled = yield* Deferred.make<void>()
        const providerCalls = yield* Ref.make(0)
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            yield* Ref.update(providerCalls, (n) => n + 1)
            yield* Deferred.succeed(providerCalled, undefined).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("recovered"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(),
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          BunServices.layer,
          ModelRegistry.Test(),
          GentPlatform.Test(),
        )
        const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
        const layer = AgentLoopTestActor({ baseSections: [] }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
          ),
        )
        const message = Message.cases.regular.make({
          id: MessageId.make("msg-incomplete-recovery"),
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "recover me" })],
          createdAt: dateFromMillis(1_767_225_600_000),
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({ sessionId, branchId })
            const eventStorage = yield* EventStorage
            yield* eventStorage.appendEvent(MessageReceived.make({ message }))

            const agentLoop = yield* makeAgentLoopService
            yield* agentLoop.getState({ sessionId, branchId })
            yield* Deferred.await(providerCalled).pipe(Effect.timeout("4 seconds"))
            expect(yield* Ref.get(providerCalls)).toBe(1)
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "failed follow-up persistence does not expose the queued item",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-loop-persist-failure")
        const branchId = BranchId.make("branch-loop-persist-failure")
        const storedQueueRef = yield* Ref.make<LoopQueueStateType>(emptyPersistedQueue())
        const activeTurnReleased = yield* Deferred.make<void>()
        const heldProvider = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            yield* Deferred.await(activeTurnReleased)
            return Stream.fromIterable([
              textDeltaPart("held"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const queueStorageLayer = Layer.succeed(
          AgentLoopQueueStorage,
          AgentLoopQueueStorage.of({
            getQueueState: () => Ref.get(storedQueueRef),
            putQueueState: (_sessionId, _branchId, queue) =>
              queue.followUp.length > 0
                ? Effect.fail(
                    new StorageError({
                      message: "queue persistence failed",
                      cause: "injected test failure",
                    }),
                  )
                : Ref.set(storedQueueRef, queue),
            clearQueueState: () => Ref.set(storedQueueRef, emptyPersistedQueue()),
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(),
          queueStorageLayer,
          heldProvider,
          ModelResolver.fromLanguageModel(heldProvider),
          makeExtRegistry(),
          RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          BunServices.layer,
          ModelRegistry.Test(),
          GentPlatform.Test(),
        )
        const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
        const layer = AgentLoopTestActor({ baseSections: [] }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
          ),
        )
        const makeMessage = (id: string, text: string) =>
          Message.cases.regular.make({
            id: MessageId.make(id),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text })],
            createdAt: dateFromMillis(1_767_225_600_000),
          })

        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* submitAgentLoop(agentLoop, makeMessage("msg-persist-failure-0", "first"), {
              interactive: true,
            })

            const queuedExit = yield* Effect.exit(
              submitAgentLoop(agentLoop, makeMessage("msg-persist-failure-1", "second"), {
                interactive: true,
              }),
            )

            expect(queuedExit._tag).toBe("Failure")
            expect((yield* agentLoop.getQueue({ sessionId, branchId })).followUp).toEqual([])
            expect((yield* Ref.get(storedQueueRef)).followUp).toEqual([])
          }).pipe(Effect.provide(layer)),
        )
        yield* Deferred.succeed(activeTurnReleased, undefined).pipe(
          Effect.catchEager(() => Effect.void),
        )
      }),
    15000,
  )
})
