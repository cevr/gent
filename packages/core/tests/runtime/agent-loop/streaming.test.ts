import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Clock, Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import * as AiError from "effect/unstable/ai/AiError"
import { AgentLoopTestActor } from "../../../src/runtime/agent/agent-loop.actor"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { RuntimeEnvironment } from "../../../src/runtime/runtime-environment"
import { ConfigService } from "../../../src/runtime/config-service"
import { ToolRunner } from "../../../src/runtime/agent/tool-runner"
import { ApprovalService } from "../../../src/runtime/approval-service"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
} from "@gent/core-internal/test-utils/language-model"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { textStep } from "@gent/core-internal/debug/provider"
import {
  AgentEvent,
  EventEnvelope,
  EventId,
  EventStore,
  EventStoreError,
} from "@gent/core-internal/domain/event"
import { EventPublisher, EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SequenceRecorder } from "@gent/core-internal/test-utils"
import { emptyQueueSnapshot } from "@gent/core-internal/domain/queue"
import { AgentName } from "@gent/core-internal/domain/agent"
import { BranchId, MessageId, RequestId, SessionId } from "@gent/core-internal/domain/ids"
import { assistantMessageIdForTurn } from "../../../src/runtime/agent/agent-loop.utils"
import {
  makeAgentLoopService,
  makeExtRegistry,
  makeLayer,
  makeLayerWithEventPublisher,
  makeLayerWithEvents,
  makeMessage,
  makeRecordingLayer,
  retryableStreamError,
  runAgentLoop,
  scriptedProvider,
  steerAgentLoop,
} from "./helpers"

describe("run completion", () => {
  it.live("run returns after a fast turn completes before the caller awaits idle", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("fast reply")])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const sessionId = SessionId.make("fast-run-session")
        const branchId = BranchId.make("fast-run-branch")
        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "fast")).pipe(
          Effect.timeout("2 seconds"),
        )
        const state = yield* agentLoop.getState({ sessionId, branchId })
        expect(state._tag).toBe("Idle")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayer(providerLayer)))
    }),
  )
})
describe("streaming", () => {
  it.scopedLive(
    "targeted cancellation before admission prevents model execution",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("later work still runs"),
        ])
        const context = yield* Layer.build(makeLayer(providerLayer))
        yield* Effect.gen(function* () {
          const loop = yield* makeAgentLoopService
          const sessionId = SessionId.make("pre-admission-cancel-session")
          const branchId = BranchId.make("pre-admission-cancel-branch")
          const cancelled = makeMessage(sessionId, branchId, "cancel before start")
          yield* steerAgentLoop({
            _tag: "Cancel",
            sessionId,
            branchId,
            requestId: RequestId.make("cancel-before-admission"),
            messageId: cancelled.id,
          })
          yield* runAgentLoop(loop, cancelled)
          expect(yield* controls.callCount).toBe(0)
          expect(
            (yield* (yield* MessageStorage).getMessage(cancelled.id))?.turnDurationMs,
          ).toBeDefined()
          const later = makeMessage(sessionId, branchId, "later")
          yield* runAgentLoop(loop, later)
          expect(yield* controls.callCount).toBe(1)
          const reply = yield* (yield* MessageStorage).getMessage(
            assistantMessageIdForTurn(later.id, 1),
          )
          expect(reply?.parts).toEqual([Prompt.textPart({ text: "later work still runs" })])
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("4 seconds")),
    6000,
  )

  it.scopedLive(
    "late turn-targeted cancellation leaves the current stream running",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("first reply"),
          { ...textStep("second reply"), gated: true },
        ])
        const context = yield* Layer.build(makeLayer(providerLayer))
        yield* Effect.gen(function* () {
          const loop = yield* makeAgentLoopService
          const sessionId = SessionId.make("targeted-cancel-session")
          const branchId = BranchId.make("targeted-cancel-branch")
          const first = makeMessage(sessionId, branchId, "first")
          const second = makeMessage(sessionId, branchId, "second")
          yield* runAgentLoop(loop, first)
          const running = yield* runAgentLoop(loop, second).pipe(Effect.forkChild)
          yield* controls.waitForCall(1)
          // This helper awaits the actual actor handler, not only durable send admission.
          yield* steerAgentLoop({
            _tag: "Cancel",
            sessionId,
            branchId,
            requestId: RequestId.make("late-first-cancel"),
            messageId: first.id,
          })
          expect((yield* loop.getState({ sessionId, branchId }))._tag).toBe("Running")
          yield* controls.emitAll(1)
          yield* Fiber.join(running)
          const reply = yield* (yield* MessageStorage).getMessage(
            assistantMessageIdForTurn(second.id, 1),
          )
          expect(reply?.parts).toEqual([Prompt.textPart({ text: "second reply" })])
          expect(yield* controls.callCount).toBe(2)
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("4 seconds")),
    6000,
  )

  it.live("concurrent sessions run independently", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, void 0)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageA = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "hello")
          const messageB = makeMessage(SessionId.make("s2"), BranchId.make("b2"), "world")
          const fiberA = yield* Effect.forkChild(runAgentLoop(agentLoop, messageA))
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(runAgentLoop(agentLoop, messageB))
          const finishedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedB._tag).toBe("Some")
          const statusA = fiberA.pollUnsafe()
          expect(statusA).toBeUndefined()
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiberA)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("same session/branch serializes loop creation", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, void 0)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const delayedEventStorage = Layer.effect(
        EventStorage,
        Effect.gen(function* () {
          const eventStorage = yield* EventStorage
          return EventStorage.of({
            ...eventStorage,
            getLatestEvent: (input) =>
              eventStorage.getLatestEvent(input).pipe(Effect.delay("5 millis")),
          })
        }),
      )
      const baseStorageLayer = SqliteStorage.TestWithSql()
      const slowStorage = Layer.provideMerge(delayedEventStorage, baseStorageLayer)
      const deps = Layer.mergeAll(
        slowStorage,
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        makeExtRegistry(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
          const fiberA = yield* Effect.forkChild(
            runAgentLoop(
              agentLoop,
              makeMessage(SessionId.make("s1"), BranchId.make("b1"), "first"),
            ),
          )
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(
            runAgentLoop(
              agentLoop,
              makeMessage(SessionId.make("s1"), BranchId.make("b1"), "second"),
            ),
          )
          const queuedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))
          expect(queuedB._tag).toBe("Some")
          expect(calls).toBe(1)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiberA)
          expect(calls).toBe(2)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("interrupt scoped to session/branch", () =>
    Effect.gen(function* () {
      const gateA = yield* Deferred.make<void>()
      const gateB = yield* Deferred.make<void>()
      const startedA = yield* Deferred.make<void>()
      const startedB = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        calls += 1
        let gate = gateB
        let started = startedB
        if (calls === 1) {
          gate = gateA
          started = startedA
        }
        return Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
              yield* Deferred.succeed(started, void 0)
              yield* Deferred.await(gate)
              return finishPart({ finishReason: "stop" })
            }),
          ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
        )
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageA = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "alpha")
          const messageB = makeMessage(SessionId.make("s2"), BranchId.make("b2"), "beta")
          const fiberA = yield* Effect.forkChild(runAgentLoop(agentLoop, messageA))
          const fiberB = yield* Effect.forkChild(runAgentLoop(agentLoop, messageB))
          yield* Deferred.await(startedA)
          yield* Deferred.await(startedB)
          yield* steerAgentLoop({
            _tag: "Interrupt",
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
            requestId: "req-interrupt-s1",
          })
          const finishedA = yield* Fiber.join(fiberA).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedA._tag).toBe("Some")
          const statusB = fiberB.pollUnsafe()
          expect(statusB).toBeUndefined()
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gateA, void 0)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gateB, void 0)
          yield* Fiber.join(fiberB)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("batches queued messages into one follow-up", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, void 0)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageStorage = yield* MessageStorage
          const first = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "first")
          const second = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "second")
          const third = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "third")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, second)
          yield* runAgentLoop(agentLoop, third)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiber)
          const messages = yield* messageStorage.listMessages(BranchId.make("b1"))
          const userTexts = messages
            .filter((message) => message.role === "user")
            .map((message) =>
              message.parts
                .filter((part): part is Prompt.TextPart => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
            )
          expect(userTexts).toEqual(["first", "second\nthird"])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("publishes StreamStarted and TurnCompleted events", () =>
    Effect.gen(function* () {
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
      )
      const layer = makeRecordingLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const recorder = yield* SequenceRecorder
          yield* runAgentLoop(
            agentLoop,
            makeMessage(SessionId.make("s1"), BranchId.make("b1"), "inspect me"),
          )
          const calls = yield* recorder.getCalls
          const publishedEvents = calls
            .filter((call) => call.service === "EventStore" && call.method === "append")
            .map((call) => Schema.decodeUnknownOption(AgentEvent)(call.args))
            .filter(Option.isSome)
            .map(({ value }) => value._tag)
          expect(publishedEvents).toContain("StreamStarted")
          expect(publishedEvents).toContain("TurnCompleted")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("rolls back assistant message when durable MessageReceived append fails", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("not committed"), finishPart({ finishReason: "stop" })],
      ])
      const failingPublisherLayer = Layer.succeed(
        EventPublisher,
        EventPublisher.of({
          append: (event: AgentEvent) => {
            if (event._tag === "MessageReceived" && event.message.role === "assistant") {
              return Effect.fail(new EventStoreError({ message: "append failed" }))
            }
            return Effect.gen(function* () {
              return EventEnvelope.make({
                id: EventId.make(0),
                event,
                createdAt: yield* Clock.currentTimeMillis,
              })
            })
          },
          deliver: () => Effect.void,
          publish: () => Effect.void,
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("atomic-assistant-session"),
          BranchId.make("atomic-assistant-branch"),
          "hello",
        )
        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(exit._tag).toBe("Failure")
        expect(assistant).toBeUndefined()
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer)))
    }),
  )
  it.live("rolls back turn duration when TurnCompleted append fails", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("committed before finalize"), finishPart({ finishReason: "stop" })],
      ])
      const failingPublisherLayer = Layer.succeed(
        EventPublisher,
        EventPublisher.of({
          append: (event: AgentEvent) => {
            if (event._tag === "TurnCompleted") {
              return Effect.fail(new EventStoreError({ message: "append failed" }))
            }
            return Effect.gen(function* () {
              return EventEnvelope.make({
                id: EventId.make(0),
                event,
                createdAt: yield* Clock.currentTimeMillis,
              })
            })
          },
          deliver: () => Effect.void,
          publish: () => Effect.void,
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("atomic-turn-session"),
          BranchId.make("atomic-turn-branch"),
          "hello",
        )
        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const user = yield* messageStorage.getMessage(message.id)
        expect(exit._tag).toBe("Failure")
        expect(user?.turnDurationMs).toBeUndefined()
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer)))
    }),
  )
  it.live("persists assistant image parts from provider response streams", () =>
    Effect.gen(function* () {
      const messageStorage = yield* MessageStorage
      const agentLoop = yield* makeAgentLoopService
      const message = makeMessage(
        SessionId.make("image-session"),
        BranchId.make("image-branch"),
        "show image",
      )
      yield* runAgentLoop(agentLoop, message)
      const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
      expect(assistant).toBeDefined()
      expect(assistant?.parts).toEqual([
        Prompt.filePart({
          data: "data:image/png;base64,aGk=",
          mediaType: "image/png",
        }),
      ])
    }).pipe(
      Effect.provide(
        makeLayer(
          scriptedProvider([
            [
              Response.makePart("file", {
                mediaType: "image/png",
                data: new Uint8Array([104, 105]),
              }),
              finishPart({ finishReason: "stop" }),
            ],
          ]),
        ),
      ),
    ),
  )
  it.live("interjection runs before queued follow-up with scoped agent override", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      const providerCalls: Array<{
        latestUserText: string
      }> = []
      let streamCount = 0
      const providerLayer = LanguageModelLayers.testStream((options) => {
        const latestUserText = [...Prompt.make(options.prompt).content]
          .reverse()
          .find((message) => message.role === "user")
          ?.content.filter((part): part is Prompt.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        providerCalls.push({
          latestUserText: latestUserText ?? "",
        })
        streamCount += 1
        if (streamCount === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, void 0)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const first = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "first")
          const queued = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "queued")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, queued)
          yield* steerAgentLoop({
            _tag: "Interject",
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
            requestId: "req-interject-priority",
            message: "steer now",
            agent: AgentName.make("deepwork"),
          })
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiber)
          expect(providerCalls.length).toBe(3)
          expect(providerCalls[0]!.latestUserText).toBe("first")
          expect(providerCalls[1]!.latestUserText).toBe("steer now")
          expect(providerCalls[2]!.latestUserText).toBe("queued")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("getQueue reads without draining", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, void 0)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const first = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "first")
          const queuedA = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "queued a")
          const queuedB = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "queued b")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, queuedA)
          yield* runAgentLoop(agentLoop, queuedB)
          yield* steerAgentLoop({
            _tag: "Interject",
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
            requestId: "req-interject-visible-queue",
            message: "steer now",
          })
          const snapshot = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshot.steering).toEqual([
            expect.objectContaining({ _tag: "steering", content: "steer now" }),
          ])
          expect(snapshot.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "queued a\nqueued b" }),
          ])
          const secondSnapshot = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(secondSnapshot).toEqual(snapshot)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiber)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("flushes queued follow-ups after provider failure", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      const providerCalls: string[] = []
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream((options) => {
        const latestUserText =
          Prompt.make(options.prompt)
            .content.slice()
            .reverse()
            .flatMap((message) => {
              if (Array.isArray(message.content)) {
                return message.content
              }
              return []
            })
            .find(Schema.is(Prompt.TextPart))?.text ?? ""
        providerCalls.push(latestUserText)
        streamCalls += 1
        if (streamCalls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return
              }),
            ).pipe(
              Stream.flatMap(() =>
                Stream.fail(
                  AiError.make({
                    module: "Test",
                    method: "streamText",
                    reason: new AiError.UnknownError({ description: "provider exploded" }),
                  }),
                ),
              ),
            ),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const first = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "first")
          const queued = makeMessage(
            SessionId.make("s1"),
            BranchId.make("b1"),
            "queued after failure",
          )
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, queued)
          const snapshotWhileRunning = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshotWhileRunning.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "queued after failure" }),
          ])
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber).pipe(Effect.exit)
          expect(providerCalls).toEqual(["first", "queued after failure"])
          const snapshotAfterFailure = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshotAfterFailure).toEqual(emptyQueueSnapshot())
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live(
    "persists a continuation instruction after partial output and finishes the same turn",
    () =>
      Effect.gen(function* () {
        const eventsRef = yield* Ref.make<AgentEvent[]>([])
        const latestUserTexts: string[] = []
        let streamCalls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          latestUserTexts.push(
            [...Prompt.make(options.prompt).content]
              .reverse()
              .find((message) => message.role === "user")
              ?.content.filter((part): part is Prompt.TextPart => part.type === "text")
              .map((part) => part.text)
              .join("\n") ?? "",
          )
          streamCalls += 1
          if (streamCalls === 1) {
            return Effect.succeed(
              Stream.concat(
                Stream.fromIterable([textDeltaPart("partial ")]),
                Stream.fail(
                  AiError.make({
                    module: "Test",
                    method: "streamText",
                    reason: new AiError.UnknownError({ description: "connection reset" }),
                  }),
                ),
              ),
            )
          }
          return Effect.succeed(
            Stream.fromIterable([textDeltaPart("rest"), finishPart({ finishReason: "stop" })]),
          )
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            const messageStorage = yield* MessageStorage
            const message = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "write it")
            yield* runAgentLoop(agentLoop, message)
            expect(streamCalls).toBe(2)
            expect(latestUserTexts[1]).toContain("Continue from where you stopped")
            const messages = yield* messageStorage.listMessages(BranchId.make("b1"))
            expect(
              messages
                .filter((item) => item.role === "assistant")
                .map((item) => item.parts.find((part) => part.type === "text")?.text),
            ).toEqual(["partial ", "rest"])
            const continuation = messages.find(
              (item) => item.metadata?.customType === "continuation",
            )
            expect(continuation).toMatchObject({
              id: `${message.id}:continuation:1`,
              role: "user",
              metadata: { customType: "continuation", details: { step: 1 } },
            })
            const events = yield* Ref.get(eventsRef)
            const completed = events.filter((event) => event._tag === "TurnCompleted")
            expect(completed).toHaveLength(1)
            expect(completed[0]).not.toMatchObject({ streamFailed: true })
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef))),
        )
      }),
  )
  it.live("bounds continuation instructions per turn and then reports the stream failure", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        streamCalls += 1
        return Effect.succeed(
          Stream.concat(
            Stream.fromIterable([textDeltaPart(`part ${streamCalls}`)]),
            Stream.fail(
              AiError.make({
                module: "Test",
                method: "streamText",
                reason: new AiError.UnknownError({ description: "connection reset" }),
              }),
            ),
          ),
        )
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageStorage = yield* MessageStorage
          const message = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "write it")
          yield* runAgentLoop(agentLoop, message)
          // Two continuations, then the third partial failure ends the turn.
          expect(streamCalls).toBe(3)
          const messages = yield* messageStorage.listMessages(BranchId.make("b1"))
          expect(
            messages.filter((item) => item.metadata?.customType === "continuation"),
          ).toHaveLength(2)
          const events = yield* Ref.get(eventsRef)
          expect(events.filter((event) => event._tag === "TurnCompleted")).toMatchObject([
            { streamFailed: true },
          ])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef))),
      )
    }),
  )
  it.live("retries retryable provider stream-consumption failures before output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.sync(() => {
          streamCalls += 1
          if (streamCalls === 1) {
            return Stream.fail(retryableStreamError())
          }
          return Stream.fromIterable([
            textDeltaPart("after retry"),
            finishPart({ finishReason: "stop" }),
          ])
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("stream-retry-session"),
          BranchId.make("stream-retry-branch"),
          "retry",
        )
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(2)
        expect(tags).toContain("ProviderRetrying")
        expect(tags).not.toContain("ErrorOccurred")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "after retry" })])
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }),
  )
  it.live(
    "retries retryable provider stream-consumption failures after metadata but before output",
    () =>
      Effect.gen(function* () {
        const eventsRef = yield* Ref.make<AgentEvent[]>([])
        let streamCalls = 0
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.sync(() => {
            streamCalls += 1
            if (streamCalls === 1) {
              return Stream.concat(
                Stream.fromIterable([
                  Response.makePart("response-metadata", {
                    id: "response-before-output",
                    modelId: "test",
                    // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
                    timestamp: undefined,
                    // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
                    request: undefined,
                  }),
                  Response.makePart("text-start", { id: "text-before-output" }),
                ]),
                Stream.fail(retryableStreamError()),
              )
            }
            return Stream.fromIterable([
              textDeltaPart("after metadata retry"),
              finishPart({ finishReason: "stop" }),
            ])
          }),
        )
        yield* Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageStorage = yield* MessageStorage
          const message = makeMessage(
            SessionId.make("stream-metadata-retry-session"),
            BranchId.make("stream-metadata-retry-branch"),
            "retry",
          )
          yield* runAgentLoop(agentLoop, message)
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((event) => event._tag)
          expect(streamCalls).toBe(2)
          expect(tags).toContain("ProviderRetrying")
          expect(tags).not.toContain("ErrorOccurred")
          const assistant = yield* messageStorage.getMessage(
            assistantMessageIdForTurn(message.id, 1),
          )
          expect(assistant?.parts).toEqual([Prompt.textPart({ text: "after metadata retry" })])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
      }),
  )
  it.live("emits stream failure events after pre-output retries are exhausted", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.sync(() => {
          streamCalls += 1
          return Stream.fail(retryableStreamError())
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("stream-retry-exhausted-session"),
          BranchId.make("stream-retry-exhausted-branch"),
          "retry",
        )
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(3)
        expect(tags.filter((tag) => tag === "ProviderRetrying")).toHaveLength(2)
        expect(events.filter((event) => event._tag === "StreamEnded")).toEqual([
          expect.objectContaining({ messageId: message.id, step: 1 }),
        ])
        const completion = events.find((event) => event._tag === "TurnCompleted")
        expect(completion).toEqual(
          expect.objectContaining({
            _tag: "TurnCompleted",
            messageId: message.id,
            streamFailed: true,
          }),
        )
        expect(tags).toContain("StreamEnded")
        expect(tags).toContain("ErrorOccurred")
        expect(tags).toContain("TurnCompleted")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeUndefined()
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }),
  )
  it.live(
    "does not blindly retry after partial output; a durable continuation follows instead",
    () =>
      Effect.gen(function* () {
        const eventsRef = yield* Ref.make<AgentEvent[]>([])
        let streamCalls = 0
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.sync(() => {
            streamCalls += 1
            if (streamCalls === 1) {
              return Stream.concat(
                Stream.fromIterable([textDeltaPart("partial answer")]),
                Stream.fail(retryableStreamError()),
              )
            }
            return Stream.fromIterable([
              textDeltaPart("duplicate answer"),
              finishPart({ finishReason: "stop" }),
            ])
          }),
        )
        yield* Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageStorage = yield* MessageStorage
          const message = makeMessage(
            SessionId.make("stream-no-retry-session"),
            BranchId.make("stream-no-retry-branch"),
            "retry",
          )
          yield* runAgentLoop(agentLoop, message)
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((event) => event._tag)
          // The second call is a continuation step with the partial output kept,
          // not a provider retry of the same prompt.
          expect(streamCalls).toBe(2)
          expect(tags).not.toContain("ProviderRetrying")
          expect(tags).toContain("ErrorOccurred")
          const assistant = yield* messageStorage.getMessage(
            assistantMessageIdForTurn(message.id, 1),
          )
          expect(assistant?.parts).toEqual([Prompt.textPart({ text: "partial answer" })])
          const continuation = yield* messageStorage.getMessage(
            MessageId.make(`${message.id}:continuation:1`),
          )
          expect(continuation?.metadata?.customType).toBe("continuation")
          const second = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 2))
          expect(second?.parts).toEqual([Prompt.textPart({ text: "duplicate answer" })])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
      }),
  )
  it.live("native response error parts fail the stream and preserve partial output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(
          Stream.fromIterable([
            textDeltaPart("partial answer"),
            // oxlint-disable-next-line effect/noNewError -- This stream fixture models a native provider error part.
            Response.makePart("error", { error: new Error("native response part failed") }),
            textDeltaPart("unreachable"),
          ]),
        ),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("native-error-session"),
          BranchId.make("native-error-branch"),
          "fail natively",
        )
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(tags).toContain("StreamStarted")
        expect(tags).toContain("StreamChunk")
        expect(tags).toContain("StreamEnded")
        expect(tags).toContain("ErrorOccurred")
        expect(tags).toContain("TurnCompleted")
        const error = events.find((event) => event._tag === "ErrorOccurred")
        expect(error).toEqual(expect.objectContaining({ error: "native response part failed" }))
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "partial answer" })])
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }),
  )
})
// ============================================================================
