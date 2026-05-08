import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Clock, Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import * as AiError from "effect/unstable/ai/AiError"
import { AgentLoopTestActor } from "../../src/runtime/agent/agent-loop.actor"
import { AgentLoopSessionGovernance } from "../../src/runtime/agent/agent-loop.session-governance"
import { ResourceManagerLive } from "../../src/runtime/resource-manager"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import { ConfigService } from "../../src/runtime/config-service"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
} from "@gent/core-internal/test-utils/language-model"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { textStep } from "@gent/core-internal/debug/provider"
import {
  EventEnvelope,
  EventId,
  EventStore,
  EventStoreError,
  type AgentEvent,
} from "@gent/core-internal/domain/event"
import { EventPublisher, EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SequenceRecorder } from "@gent/core-internal/test-utils"
import { emptyQueueSnapshot } from "@gent/core-internal/domain/queue"
import { AgentName } from "@gent/core-internal/domain/agent"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { assistantMessageIdForTurn } from "../../src/runtime/agent/agent-loop.utils"
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
} from "./agent-loop/helpers"

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
      }).pipe(Effect.provide(makeLayer(providerLayer)))
    }),
  )
})
describe("streaming", () => {
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
                yield* Deferred.succeed(firstStarted, undefined)
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
          const messageA = makeMessage("s1", "b1", "hello")
          const messageB = makeMessage("s2", "b2", "world")
          const fiberA = yield* Effect.forkChild(runAgentLoop(agentLoop, messageA))
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(runAgentLoop(agentLoop, messageB))
          const finishedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedB._tag).toBe("Some")
          const statusA = fiberA.pollUnsafe()
          expect(statusA).toBeUndefined()
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiberA)
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
                yield* Deferred.succeed(firstStarted, undefined)
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
          return {
            ...eventStorage,
            getLatestEvent: (input) =>
              eventStorage.getLatestEvent(input).pipe(Effect.delay("5 millis")),
          }
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
        BunServices.layer,
        ResourceManagerLive,
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
            runAgentLoop(agentLoop, makeMessage("s1", "b1", "first")),
          )
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeMessage("s1", "b1", "second")),
          )
          const queuedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))
          expect(queuedB._tag).toBe("Some")
          expect(calls).toBe(1)
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiberA)
          expect(calls).toBe(2)
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
        const gate = calls === 1 ? gateA : gateB
        const started = calls === 1 ? startedA : startedB
        return Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
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
          const messageA = makeMessage("s1", "b1", "alpha")
          const messageB = makeMessage("s2", "b2", "beta")
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
          yield* Deferred.succeed(gateA, undefined)
          yield* Deferred.succeed(gateB, undefined)
          yield* Fiber.join(fiberB)
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
                yield* Deferred.succeed(firstStarted, undefined)
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
          const first = makeMessage("s1", "b1", "first")
          const second = makeMessage("s1", "b1", "second")
          const third = makeMessage("s1", "b1", "third")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, second)
          yield* runAgentLoop(agentLoop, third)
          yield* Deferred.succeed(gate, undefined)
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
          yield* runAgentLoop(agentLoop, makeMessage("s1", "b1", "inspect me"))
          const calls = yield* recorder.getCalls()
          const publishedEvents = calls
            .filter((call) => call.service === "EventStore" && call.method === "append")
            .map(
              (call) =>
                (
                  call.args as
                    | {
                        _tag?: string
                      }
                    | undefined
                )?._tag,
            )
            .filter((tag): tag is string => tag !== undefined)
          expect(publishedEvents).toContain("StreamStarted")
          expect(publishedEvents).toContain("TurnCompleted")
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("rolls back assistant message when durable MessageReceived append fails", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("not committed"), finishPart({ finishReason: "stop" })],
      ])
      const failingPublisherLayer = Layer.succeed(EventPublisher, {
        append: (event: AgentEvent) =>
          event._tag === "MessageReceived" && event.message.role === "assistant"
            ? Effect.fail(new EventStoreError({ message: "append failed" }))
            : Effect.gen(function* () {
                return EventEnvelope.make({
                  id: EventId.make(0),
                  event,
                  createdAt: yield* Clock.currentTimeMillis,
                })
              }),
        deliver: () => Effect.void,
        publish: () => Effect.void,
      })
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage("atomic-assistant-session", "atomic-assistant-branch", "hello")
        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(exit._tag).toBe("Failure")
        expect(assistant).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer)))
    }),
  )
  it.live("rolls back turn duration when TurnCompleted append fails", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("committed before finalize"), finishPart({ finishReason: "stop" })],
      ])
      const failingPublisherLayer = Layer.succeed(EventPublisher, {
        append: (event: AgentEvent) =>
          event._tag === "TurnCompleted"
            ? Effect.fail(new EventStoreError({ message: "append failed" }))
            : Effect.gen(function* () {
                return EventEnvelope.make({
                  id: EventId.make(0),
                  event,
                  createdAt: yield* Clock.currentTimeMillis,
                })
              }),
        deliver: () => Effect.void,
        publish: () => Effect.void,
      })
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage("atomic-turn-session", "atomic-turn-branch", "hello")
        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const user = yield* messageStorage.getMessage(message.id)
        expect(exit._tag).toBe("Failure")
        expect(user?.turnDurationMs).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer)))
    }),
  )
  it.live("persists assistant image parts from provider response streams", () =>
    Effect.gen(function* () {
      const messageStorage = yield* MessageStorage
      const agentLoop = yield* makeAgentLoopService
      const message = makeMessage("image-session", "image-branch", "show image")
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
                yield* Deferred.succeed(firstStarted, undefined)
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
          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued")
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
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
          expect(providerCalls.length).toBe(3)
          expect(providerCalls[0]!.latestUserText).toBe("first")
          expect(providerCalls[1]!.latestUserText).toBe("steer now")
          expect(providerCalls[2]!.latestUserText).toBe("queued")
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
                yield* Deferred.succeed(firstStarted, undefined)
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
          const first = makeMessage("s1", "b1", "first")
          const queuedA = makeMessage("s1", "b1", "queued a")
          const queuedB = makeMessage("s1", "b1", "queued b")
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
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
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
            .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            .find(
              (part: unknown): part is Prompt.TextPart =>
                typeof part === "object" &&
                part !== null &&
                (
                  part as {
                    type?: unknown
                  }
                ).type === "text",
            )?.text ?? ""
        providerCalls.push(latestUserText)
        streamCalls += 1
        if (streamCalls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return undefined
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
          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued after failure")
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
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber).pipe(Effect.exit)
          expect(providerCalls).toEqual(["first", "queued after failure"])
          const snapshotAfterFailure = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshotAfterFailure).toEqual(emptyQueueSnapshot())
        }).pipe(Effect.provide(layer)),
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
        const message = makeMessage("stream-retry-session", "stream-retry-branch", "retry")
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(2)
        expect(tags).toContain("ProviderRetrying")
        expect(tags).not.toContain("ErrorOccurred")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "after retry" })])
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
                    timestamp: undefined,
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
            "stream-metadata-retry-session",
            "stream-metadata-retry-branch",
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
          "stream-retry-exhausted-session",
          "stream-retry-exhausted-branch",
          "retry",
        )
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(3)
        expect(tags.filter((tag) => tag === "ProviderRetrying")).toHaveLength(2)
        expect(tags).toContain("StreamEnded")
        expect(tags).toContain("ErrorOccurred")
        expect(tags).toContain("TurnCompleted")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }),
  )
  it.live("does not retry retryable provider stream failures after partial output", () =>
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
        const message = makeMessage("stream-no-retry-session", "stream-no-retry-branch", "retry")
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(1)
        expect(tags).not.toContain("ProviderRetrying")
        expect(tags).toContain("ErrorOccurred")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "partial answer" })])
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
            Response.makePart("error", { error: new Error("native response part failed") }),
            textDeltaPart("unreachable"),
          ]),
        ),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage("native-error-session", "native-error-branch", "fail natively")
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
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }),
  )
})
// ============================================================================
