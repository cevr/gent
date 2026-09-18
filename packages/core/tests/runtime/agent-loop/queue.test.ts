import { test } from "bun:test"
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import {
  Predicate,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
  Stream,
  TxSubscriptionRef,
} from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  type LanguageModelStreamPart,
} from "../../../src/test-utils/language-model"
import { textStep, toolCallStep } from "../../../src/test-utils/sequence-steps"
import { tool } from "@gent/core/extensions/api"
import {
  dateFromMillis,
  emptyLoopQueueState,
  LoopQueueState,
  type LoopQueueState as LoopQueueStateType,
  Message,
  type QueuedTurnItem,
} from "../../../src/domain/message"
import { EventStore, MessageReceived, TurnCompleted } from "../../../src/domain/event"
import { EventPublisherLive } from "../../../src/domain/event-publisher"
import { SqliteStorage } from "../../../src/storage/sqlite-storage"
import { EventStorage } from "../../../src/storage/event-storage"
import { BranchId, MessageId, SessionId } from "../../../src/domain/ids"
import { windowMarkerMessage } from "../../../src/runtime/model-context-window"
import { AgentLoopTestActor } from "../../../src/runtime/agent/agent-loop.actor"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { RuntimeEnvironment } from "../../../src/runtime/runtime-environment"
import { ConfigService } from "../../../src/runtime/config-service"
import { noBranchTools, ToolRunner } from "../../../src/runtime/agent/tools"
import { ApprovalService } from "../../../src/runtime/approval-service"
import { ModelResolver } from "../../../src/providers/model-resolver"
import {
  makeAgentLoopService,
  makeExtRegistry,
  steerAgentLoop,
  submitAgentLoop,
  waitFor,
  waitForPhase,
} from "./helpers"
import { MessageStorage } from "../../../src/storage/message-storage"
import { buildIdleState, buildRunningState } from "../../../src/runtime/agent/agent-loop.state"
import {
  buildInitialAgentLoopState,
  canStartTurnNow,
  makeLoopInbox,
  wantsWakeOnRecovery,
  type AgentLoopState,
} from "../../../src/runtime/agent/loop-inbox"
import { AgentLoopQueueStorage } from "../../../src/storage/agent-loop-queue-storage"
import type { AgentLoopError } from "../../../src/runtime/agent/agent-loop.state"
import { StorageError } from "../../../src/domain/errors"
import { ensureStorageParents } from "../../../src/test-utils"

const emptyPersistedQueue = (): LoopQueueStateType =>
  LoopQueueState.make({ steering: [], followUp: [] })

describe("turn admission", () => {
  const item = (id: string) => ({
    message: Message.cases.regular.make({
      id: MessageId.make(id),
      sessionId: SessionId.make("admit-session"),
      branchId: BranchId.make("admit-branch"),
      role: "user",
      parts: [Prompt.textPart({ text: id })],
      createdAt: dateFromMillis(1_767_225_600_000),
    }),
  })

  test("an idle branch with nothing reserved may start a turn", () => {
    expect(canStartTurnNow(buildInitialAgentLoopState({ state: buildIdleState() }))).toBe(true)
  })

  test("a running branch may not start another turn", () => {
    const running = buildRunningState(item("running"), { startedAtMs: 0 })
    expect(canStartTurnNow(buildInitialAgentLoopState({ state: running }))).toBe(false)
  })

  // The reserving caller has taken the item out of the queue and has not yet
  // reached `startTurn`, so `state` is still Idle. A second caller that reads
  // only `state` would take a turn past the reservation, and the reserved item
  // would then be in neither the queue nor the transcript.
  test("an idle branch holding a reservation may not start a turn", () => {
    const reserved = buildRunningState(item("reserved"), { startedAtMs: 0 })
    const state = {
      ...buildInitialAgentLoopState({ state: buildIdleState() }),
      startingState: reserved,
    }
    expect(state.state._tag).toBe("Idle")
    expect(canStartTurnNow(state)).toBe(false)
  })
})

describe("wake admission", () => {
  const wakeSessionId = SessionId.make("wake-session")
  const wakeBranchId = BranchId.make("wake-branch")
  const queuedMessage = (id: string, text: string) =>
    Message.cases.regular.make({
      id: MessageId.make(id),
      sessionId: wakeSessionId,
      branchId: wakeBranchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })

  /**
   * Batching and keying are the inbox's, so they are exercised through
   * `admit`. The inbox runs over a memory queue row: the durable write is
   * covered by the drain and recovery suites below.
   */
  const withInbox = <A>(
    body: (inbox: {
      readonly admit: (item: QueuedTurnItem) => Effect.Effect<unknown, AgentLoopError>
      readonly queue: Effect.Effect<LoopQueueStateType>
    }) => Effect.Effect<A, AgentLoopError>,
  ) =>
    Effect.gen(function* () {
      const loopRef = yield* TxSubscriptionRef.make<AgentLoopState>(
        buildInitialAgentLoopState({
          state: buildRunningState({ message: queuedMessage("busy", "busy") }, { startedAtMs: 0 }),
        }),
      )
      const rows = yield* Ref.make(emptyLoopQueueState())
      const inbox = yield* makeLoopInbox({
        sessionId: wakeSessionId,
        branchId: wakeBranchId,
        loopRef,
        queuePersistenceSemaphore: yield* Semaphore.make(1),
        persistenceFailure: yield* Deferred.make<void, AgentLoopError>(),
        startedRef: yield* Ref.make(true),
      }).pipe(
        Effect.provideService(AgentLoopQueueStorage, {
          getQueueState: () => Ref.get(rows),
          putQueueState: (_s, _b, queue) => Ref.set(rows, queue),
        }),
      )
      return yield* body({
        admit: (item) => inbox.admit(item, { queueOnly: true }),
        queue: TxSubscriptionRef.get(loopRef).pipe(Effect.map((s) => s.queue)),
      })
    })

  it.effect("a batched follow-up keeps the wake request and the queue reports it", () =>
    withInbox((inbox) =>
      Effect.gen(function* () {
        yield* inbox.admit({ message: queuedMessage("wake-a", "first") })
        expect(wantsWakeOnRecovery(yield* inbox.queue)).toEqual(
          Option.some({ unconditional: false }),
        )
        yield* inbox.admit({ message: queuedMessage("wake-b", "second"), wake: true })
        const woken = yield* inbox.queue
        expect(woken.followUp).toHaveLength(1)
        expect(woken.followUp[0]?.wake).toBe(true)
        expect(wantsWakeOnRecovery(woken)).toEqual(Option.some({ unconditional: true }))
      }),
    ),
  )

  it.effect(
    "a source-keyed follow-up is never merged into its neighbour; re-admission replaces it",
    () =>
      withInbox((inbox) =>
        Effect.gen(function* () {
          yield* inbox.admit({ message: queuedMessage("user-a", "first") })
          yield* inbox.admit({
            message: queuedMessage("follow-up:w:s:b:child-1", "child done"),
            keyed: true,
          })
          expect((yield* inbox.queue).followUp.map((item) => String(item.message.id))).toEqual([
            "user-a",
            "follow-up:w:s:b:child-1",
          ])
          yield* inbox.admit({
            message: queuedMessage("follow-up:w:s:b:child-1", "child done (retry)"),
            keyed: true,
          })
          expect((yield* inbox.queue).followUp).toHaveLength(2)
        }),
      ),
  )

  test("a recovered queue with nothing in it never wakes", () => {
    expect(wantsWakeOnRecovery(emptyLoopQueueState())).toEqual(Option.none())
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
            if (!Predicate.isUndefined(gate)) {
              yield* Deferred.await(gate)
            }
            return Stream.fromIterable([
              textDeltaPart(`turn-${idx}`),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          gatedProvider,
          ModelResolver.fromLanguageModel(gatedProvider),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
                  if (count >= 1) {
                    return Option.some(count)
                  }
                  return Option.none()
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
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
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
                  // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                  yield* Deferred.succeed(secondFollowUpStored, undefined).pipe(
                    Effect.catchEager(() => Effect.void),
                  )
                }
              }),
          }),
        )
        const makeLayer = () => {
          const deps = Layer.mergeAll(
            SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
            queueStorageLayer,
            queuedProvider,
            ModelResolver.fromLanguageModel(queuedProvider),
            makeExtRegistry(),
            RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
            ConfigService.Test(),
            EventStore.Memory,
            ToolRunner.Test(),
            ApprovalService.Test(),
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
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(makeLayer())),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            const recovered = yield* agentLoop.getQueue({ sessionId, branchId })
            expect(recovered.followUp.map((item) => item.content)).toEqual(["second", "third"])
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(makeLayer())),
        )
        // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
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
            // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
            yield* Deferred.succeed(providerCalled, undefined).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("recovered"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "startup does not replay a continuation prompt as a user turn",
    () =>
      Effect.gen(function* () {
        // A continuation prompt is persisted as a user message inside a turn
        // and never gets a TurnCompleted of its own. Seen in the gamut testbed:
        // startup took it for an unanswered turn and sent a transcript that
        // ended with the assistant reply, which the provider rejected.
        const sessionId = SessionId.make("session-loop-continuation-replay")
        const branchId = BranchId.make("branch-loop-continuation-replay")
        const providerCalled = yield* Deferred.make<void>()
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
            yield* Deferred.succeed(providerCalled, undefined).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("replayed"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
        const messageId = MessageId.make("msg-continuation-replay")
        const message = Message.cases.regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "answer me" })],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
        const continuation = Message.cases.regular.make({
          id: MessageId.make(`${messageId}:continuation:2`),
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "Answer the request now." })],
          createdAt: dateFromMillis(1_767_225_600_001),
          metadata: { customType: "continuation", details: { step: 2 } },
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({ sessionId, branchId })
            const eventStorage = yield* EventStorage
            yield* eventStorage.appendEvent(MessageReceived.make({ message }))
            yield* eventStorage.appendEvent(MessageReceived.make({ message: continuation }))
            yield* eventStorage.appendEvent(
              TurnCompleted.make({ sessionId, branchId, messageId, durationMs: 1 }),
            )

            const agentLoop = yield* makeAgentLoopService
            const state = yield* agentLoop.getState({ sessionId, branchId })
            expect(state._tag).toBe("Idle")
            const called = yield* Deferred.await(providerCalled).pipe(
              Effect.timeout("500 millis"),
              Effect.option,
            )
            expect(Option.isNone(called)).toBe(true)
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "startup does not answer a context handoff marker as a user turn",
    () =>
      Effect.gen(function* () {
        // A handoff marker is a user-role message the loop persists mid-turn.
        // Seen on the gamut at a 20k window: reopening a finished child took
        // the marker for an unanswered turn and the provider rejected the
        // transcript, which ended with the assistant reply.
        const sessionId = SessionId.make("session-loop-marker-replay")
        const branchId = BranchId.make("branch-loop-marker-replay")
        const providerCalled = yield* Deferred.make<void>()
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
            yield* Deferred.succeed(providerCalled, undefined).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("replayed"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
        const messageId = MessageId.make("msg-marker-replay")
        const message = Message.cases.regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "answer me" })],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
        const reply = Message.cases.regular.make({
          id: MessageId.make("msg-marker-reply"),
          sessionId,
          branchId,
          role: "assistant",
          parts: [Prompt.textPart({ text: "answered" })],
          createdAt: dateFromMillis(1_767_225_600_001),
        })
        const marker = windowMarkerMessage({
          sessionId,
          branchId,
          keepFromMessageId: reply.id,
          notice: "Context handoff.",
          createdAt: dateFromMillis(1_767_225_600_002),
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({ sessionId, branchId })
            const eventStorage = yield* EventStorage
            yield* eventStorage.appendEvent(MessageReceived.make({ message }))
            yield* eventStorage.appendEvent(MessageReceived.make({ message: reply }))
            yield* eventStorage.appendEvent(MessageReceived.make({ message: marker }))
            yield* eventStorage.appendEvent(
              TurnCompleted.make({ sessionId, branchId, messageId, durationMs: 1 }),
            )

            const agentLoop = yield* makeAgentLoopService
            const state = yield* agentLoop.getState({ sessionId, branchId })
            expect(state._tag).toBe("Idle")
            const called = yield* Deferred.await(providerCalled).pipe(
              Effect.timeout("500 millis"),
              Effect.option,
            )
            expect(Option.isNone(called)).toBe(true)
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "startup does not answer delivered steering as a user turn",
    () =>
      Effect.gen(function* () {
        // Steering delivered at a step boundary joins the turn already running
        // and never gets a `TurnCompleted` of its own. Without a runtime
        // marker, recovery reads that as an unanswered user turn and answers
        // it a second time after a restart.
        const sessionId = SessionId.make("session-loop-steering-replay")
        const branchId = BranchId.make("branch-loop-steering-replay")
        const providerCalled = yield* Deferred.make<void>()
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
            yield* Deferred.succeed(providerCalled, undefined).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("replayed"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
        const messageId = MessageId.make("msg-steering-replay")
        const message = Message.cases.regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "answer me" })],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
        // The shape `deliverSteeringAtStepBoundary` writes: a user-role
        // interjection carrying the runtime marker, with no completion of
        // its own.
        const delivered = Message.cases.regular.make({
          id: MessageId.make("msg-steering-replay-interject"),
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "also do this" })],
          createdAt: dateFromMillis(1_767_225_600_001),
          metadata: { customType: "steering" },
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({ sessionId, branchId })
            const eventStorage = yield* EventStorage
            yield* eventStorage.appendEvent(MessageReceived.make({ message }))
            yield* eventStorage.appendEvent(MessageReceived.make({ message: delivered }))
            yield* eventStorage.appendEvent(
              TurnCompleted.make({ sessionId, branchId, messageId, durationMs: 1 }),
            )

            const agentLoop = yield* makeAgentLoopService
            const state = yield* agentLoop.getState({ sessionId, branchId })
            expect(state._tag).toBe("Idle")
            const called = yield* Deferred.await(providerCalled).pipe(
              Effect.timeout("500 millis"),
              Effect.option,
            )
            expect(Option.isNone(called)).toBe(true)
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "steering reaches the transcript before the queue lets it go",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-steer-transcript-first")
        const branchId = BranchId.make("branch-steer-transcript-first")
        const storedQueueRef = yield* Ref.make<LoopQueueStateType>(emptyPersistedQueue())
        const echoTool = tool({
          id: "echo",
          description: "Echoes input",
          params: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: (params) => Effect.succeed({ text: params.text }),
        })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...toolCallStep("echo", { text: "step 1" }), gated: true },
          textStep("Done after steering."),
        ])
        // Read at the drop: the write that empties a non-empty steering queue
        // is the one that follows delivery. Recording whether the transcript
        // already holds the interjection at that instant says which of the two
        // writes went first, without failing either.
        const transcriptHeldAtDrop = yield* Ref.make(Option.none<boolean>())
        const storageLayer = SqliteStorage.TestWithSql(
          noBranchTools.storage,
          noBranchTools.migrations,
        )
        const queueStorageLayer = Layer.provide(
          Layer.effect(
            AgentLoopQueueStorage,
            Effect.gen(function* () {
              const messageStorage = yield* MessageStorage
              return AgentLoopQueueStorage.of({
                getQueueState: () => Ref.get(storedQueueRef),
                putQueueState: (_sessionId, _branchId, queue) =>
                  Effect.gen(function* () {
                    const previous = yield* Ref.get(storedQueueRef)
                    if (previous.steering.length > 0 && queue.steering.length === 0) {
                      const messages = yield* messageStorage
                        .listMessages(branchId)
                        .pipe(Effect.catchEager(() => Effect.succeed([])))
                      const held = messages.some((message) => message._tag === "interjection")
                      // First drop wins: a later step boundary must not
                      // overwrite what the one under test recorded.
                      yield* Ref.update(transcriptHeldAtDrop, (current) =>
                        Option.orElse(current, () => Option.some(held)),
                      )
                    }
                    yield* Ref.set(storedQueueRef, queue)
                  }),
              })
            }),
          ),
          storageLayer,
        )
        const deps = Layer.mergeAll(
          storageLayer,
          queueStorageLayer,
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry([echoTool]),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
            const messageStorage = yield* MessageStorage
            const turn = Message.cases.regular.make({
              id: MessageId.make("msg-steer-transcript-first"),
              sessionId,
              branchId,
              role: "user",
              parts: [Prompt.textPart({ text: "run a tool" })],
              createdAt: dateFromMillis(1_767_225_600_000),
            })
            const fiber = yield* Effect.forkChild(
              submitAgentLoop(agentLoop, turn, { interactive: true }).pipe(Effect.ignore),
            )
            yield* controls.waitForCall(0)
            yield* steerAgentLoop({
              _tag: "Interject",
              sessionId,
              branchId,
              requestId: "req-steer-transcript-first",
              message: "answer this too",
            })
            yield* controls.emitAll(0)
            yield* Fiber.join(fiber).pipe(Effect.ignore)
            // The submit returns once the turn is admitted, not once it ends.
            // Reading the transcript before the loop parks would tear the layer
            // down mid-stream and interrupt the very delivery under test.
            yield* waitForPhase(agentLoop, { sessionId, branchId }, "Idle")
            const messages = yield* messageStorage.listMessages(branchId)
            expect(messages.filter((message) => message._tag === "interjection")).toHaveLength(1)
            // The drop happened, and the transcript already held the interjection
            // when it did. A crash in that window replays a delivery the message
            // id makes a no-op; the other order loses input the branch accepted.
            expect(yield* Ref.get(transcriptHeldAtDrop)).toStrictEqual(Option.some(true))
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
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
            putQueueState: (_sessionId, _branchId, queue) => {
              if (queue.followUp.length > 0) {
                return Effect.fail(
                  new StorageError({
                    message: "queue persistence failed",
                    cause: "injected test failure",
                  }),
                )
              }
              return Ref.set(storedQueueRef, queue)
            },
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          queueStorageLayer,
          heldProvider,
          ModelResolver.fromLanguageModel(heldProvider),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer)),
        )
        // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
        yield* Deferred.succeed(activeTurnReleased, undefined).pipe(
          Effect.catchEager(() => Effect.void),
        )
      }),
    15000,
  )
})
