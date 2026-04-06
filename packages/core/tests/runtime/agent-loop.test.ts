import { describe, test, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { Provider, ProviderError, FinishChunk } from "@gent/core/providers/provider"
import { Message, TextPart, Session, Branch } from "@gent/core/domain/message"
import { Agents } from "@gent/core/domain/agent"
import type { AnyToolDefinition } from "@gent/core/domain/tool"
import { Permission } from "@gent/core/domain/permission"
import { EventStore } from "@gent/core/domain/event"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { SequenceRecorder, RecordingEventStore } from "@gent/core/test-utils"
import { BunServices } from "@effect/platform-bun"

const makeTestExtRegistry = (tools: AnyToolDefinition[] = []) =>
  ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "agents" },
        kind: "builtin" as const,
        sourcePath: "test",
        setup: { agents: Object.values(Agents) },
      },
      ...(tools.length > 0
        ? [
            {
              manifest: { id: "tools" },
              kind: "builtin" as const,
              sourcePath: "test",
              setup: { tools },
            },
          ]
        : []),
    ]),
  )

describe("AgentLoop actor model", () => {
  const makeMessage = (sessionId: string, branchId: string, text: string) =>
    new Message({
      id: `${sessionId}-${branchId}-${text}`,
      sessionId,
      branchId,
      role: "user",
      parts: [new TextPart({ type: "text", text })],
      createdAt: new Date(),
    })

  const makeLayer = (providerLayer: Layer.Layer<Provider>) => {
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      providerLayer,
      makeTestExtRegistry(),
      ExtensionStateRuntime.Test(),
      ExtensionTurnControl.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      EventStore.Test(),
      ToolRunner.Test(),
      BunServices.layer,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    return Layer.provideMerge(
      AgentLoop.Live({ baseSections: [] }),
      Layer.merge(deps, eventPublisherLayer),
    )
  }

  const makeRecordingLayer = (providerLayer: Layer.Layer<Provider>) => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      providerLayer,
      makeTestExtRegistry(),
      ExtensionStateRuntime.Test(),
      ExtensionTurnControl.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ToolRunner.Test(),
      BunServices.layer,
      recorderLayer,
      eventStoreLayer,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    return Layer.provideMerge(
      AgentLoop.Live({ baseSections: [] }),
      Layer.merge(deps, eventPublisherLayer),
    )
  }

  test("runs sessions concurrently", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return new FinishChunk({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const messageA = makeMessage("s1", "b1", "hello")
          const messageB = makeMessage("s2", "b2", "world")

          const fiberA = yield* Effect.forkChild(agentLoop.run(messageA))
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(agentLoop.run(messageB))

          const finishedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedB._tag).toBe("Some")

          const statusA = fiberA.pollUnsafe()
          expect(statusA).toBeUndefined()

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiberA)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("serializes loop creation for the same session and branch", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return new FinishChunk({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
          )
        }

        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const delayedStorage = Layer.effect(
      Storage,
      Effect.gen(function* () {
        const storage = yield* Storage
        return {
          ...storage,
          getLatestEvent: (input) => storage.getLatestEvent(input).pipe(Effect.delay("25 millis")),
        }
      }),
    )

    const baseStorageLayer = Storage.TestWithSql()
    const slowStorage = Layer.provideMerge(delayedStorage, baseStorageLayer)

    const deps = Layer.mergeAll(
      slowStorage,
      providerLayer,
      makeTestExtRegistry(),
      ExtensionStateRuntime.Test(),
      ExtensionTurnControl.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      EventStore.Test(),
      ToolRunner.Test(),
      BunServices.layer,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    const layer = Layer.provideMerge(
      AgentLoop.Live({ baseSections: [] }),
      Layer.merge(deps, eventPublisherLayer),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const fiberA = yield* Effect.forkChild(agentLoop.run(makeMessage("s1", "b1", "first")))
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(agentLoop.run(makeMessage("s1", "b1", "second")))
          const queuedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))

          expect(queuedB._tag).toBe("Some")
          expect(calls).toBe(1)

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiberA)

          expect(calls).toBe(2)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("interrupt scoped to session/branch", async () => {
    const gateA = await Effect.runPromise(Deferred.make<void>())
    const gateB = await Effect.runPromise(Deferred.make<void>())
    const startedA = await Effect.runPromise(Deferred.make<void>())
    const startedB = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        const gate = calls === 1 ? gateA : gateB
        const started = calls === 1 ? startedA : startedB
        return Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
              return new FinishChunk({ finishReason: "stop" })
            }),
          ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
        )
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const messageA = makeMessage("s1", "b1", "alpha")
          const messageB = makeMessage("s2", "b2", "beta")

          const fiberA = yield* Effect.forkChild(agentLoop.run(messageA))
          const fiberB = yield* Effect.forkChild(agentLoop.run(messageB))

          yield* Deferred.await(startedA)
          yield* Deferred.await(startedB)
          yield* agentLoop.steer({ _tag: "Interrupt", sessionId: "s1", branchId: "b1" })

          const finishedA = yield* Fiber.join(fiberA).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedA._tag).toBe("Some")

          const statusB = fiberB.pollUnsafe()
          expect(statusB).toBeUndefined()

          yield* Deferred.succeed(gateA, undefined)
          yield* Deferred.succeed(gateB, undefined)
          yield* Fiber.join(fiberB)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("batches queued regular messages into one follow-up message", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return new FinishChunk({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const storage = yield* Storage

          const first = makeMessage("s1", "b1", "first")
          const second = makeMessage("s1", "b1", "second")
          const third = makeMessage("s1", "b1", "third")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Deferred.await(firstStarted)
          yield* agentLoop.run(second)
          yield* agentLoop.run(third)

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)

          const messages = yield* storage.listMessages("b1")
          const userTexts = messages
            .filter((message) => message.role === "user")
            .map((message) =>
              message.parts
                .filter((part): part is TextPart => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
            )

          expect(userTexts).toEqual(["first", "second\nthird"])
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("publishes domain events for a single turn", async () => {
    const providerLayer = Layer.succeed(Provider, {
      stream: () =>
        Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })])),
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeRecordingLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const recorder = yield* SequenceRecorder

          yield* agentLoop.run(makeMessage("s1", "b1", "inspect me"))

          const calls = yield* recorder.getCalls()
          const publishedEvents = calls
            .filter((call) => call.service === "EventStore" && call.method === "publish")
            .map((call) => (call.args as { _tag?: string } | undefined)?._tag)
            .filter((tag): tag is string => tag !== undefined)

          expect(publishedEvents).toContain("StreamStarted")
          expect(publishedEvents).toContain("TurnCompleted")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("runs interjection before queued follow-up and scopes agent override to that turn", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    const calls: Array<{ model: string; latestUserText: string }> = []
    let streamCount = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: (request) => {
        const latestUserText = [...request.messages]
          .reverse()
          .find((message) => message.role === "user")
          ?.parts.filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        calls.push({
          model: request.model,
          latestUserText: latestUserText ?? "",
        })

        streamCount += 1
        if (streamCount === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return new FinishChunk({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
          )
        }

        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Deferred.await(firstStarted)
          yield* agentLoop.run(queued)
          yield* agentLoop.steer({
            _tag: "Interject",
            sessionId: "s1",
            branchId: "b1",
            message: "steer now",
            agent: "deepwork",
          })

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)

          // Assert agent routing behavior, not specific model IDs
          expect(calls.length).toBe(3)
          expect(calls[0]!.latestUserText).toBe("first")
          expect(calls[1]!.latestUserText).toBe("steer now")
          expect(calls[2]!.latestUserText).toBe("queued")
          // Interjection with agent override uses a different model than default
          expect(calls[1]!.model).not.toBe(calls[0]!.model)
          // Queued follow-up reverts to default agent's model
          expect(calls[2]!.model).toBe(calls[0]!.model)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("reads queued messages without draining them", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return new FinishChunk({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const first = makeMessage("s1", "b1", "first")
          const queuedA = makeMessage("s1", "b1", "queued a")
          const queuedB = makeMessage("s1", "b1", "queued b")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Deferred.await(firstStarted)
          yield* agentLoop.run(queuedA)
          yield* agentLoop.run(queuedB)
          yield* agentLoop.steer({
            _tag: "Interject",
            sessionId: "s1",
            branchId: "b1",
            message: "steer now",
          })

          const snapshot = yield* agentLoop.getQueue({ sessionId: "s1", branchId: "b1" })
          expect(snapshot.steering).toEqual([
            expect.objectContaining({
              kind: "steering",
              content: "steer now",
            }),
          ])
          expect(snapshot.followUp).toEqual([
            expect.objectContaining({
              kind: "follow-up",
              content: "queued a\nqueued b",
            }),
          ])

          const secondSnapshot = yield* agentLoop.getQueue({ sessionId: "s1", branchId: "b1" })
          expect(secondSnapshot).toEqual(snapshot)

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("flushes queued follow-ups after provider failure", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    const calls: string[] = []
    let streamCalls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: ({ messages }) => {
        const latestUserText =
          messages
            .slice()
            .reverse()
            .flatMap((message) => message.parts)
            .find((part): part is TextPart => part.type === "text")?.text ?? ""

        calls.push(latestUserText)
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
                  new ProviderError({
                    message: "provider exploded",
                    model: "test",
                  }),
                ),
              ),
            ),
          )
        }

        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued after failure")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Deferred.await(firstStarted)
          yield* agentLoop.run(queued)

          const snapshotWhileRunning = yield* agentLoop.getQueue({
            sessionId: "s1",
            branchId: "b1",
          })
          expect(snapshotWhileRunning.followUp).toEqual([
            expect.objectContaining({
              kind: "follow-up",
              content: "queued after failure",
            }),
          ])

          yield* Deferred.succeed(gate, undefined)

          yield* Fiber.join(fiber).pipe(Effect.exit)

          expect(calls).toEqual(["first", "queued after failure"])

          const snapshotAfterFailure = yield* agentLoop.getQueue({
            sessionId: "s1",
            branchId: "b1",
          })
          expect(snapshotAfterFailure).toEqual({ steering: [], followUp: [] })
        }).pipe(Effect.provide(layer)),
      ),
    )
  })
})

describe("AgentLoop.runOnce", () => {
  test("publishes machine inspection events", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const extRegistry = makeTestExtRegistry()
    const toolDeps = Layer.mergeAll(
      extRegistry,
      Permission.Test(),
      ApprovalService.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ExtensionStateRuntime.Test(),
    )
    const toolRunnerLayer = ToolRunner.Live.pipe(Layer.provide(toolDeps))
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      Provider.Test([[new FinishChunk({ finishReason: "stop" })]]),
      ExtensionStateRuntime.Test(),
      ExtensionTurnControl.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      BunServices.layer,
      recorderLayer,
      eventStoreLayer,
      toolDeps,
      toolRunnerLayer,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    const loopLayer = AgentLoop.Live({ baseSections: [] }).pipe(
      Layer.provide(Layer.merge(deps, eventPublisherLayer)),
    )
    const layer = Layer.mergeAll(deps, eventPublisherLayer, loopLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const loop = yield* AgentLoop
        const recorder = yield* SequenceRecorder

        const now = new Date()
        const session = new Session({
          id: "inspection-session",
          name: "Inspection",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "inspection-branch",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        yield* loop.runOnce({
          sessionId: session.id,
          branchId: branch.id,
          agentName: "cowork",
          prompt: "inspect",
        })

        yield* Effect.yieldNow

        const calls = yield* recorder.getCalls()
        const tags = calls
          .filter((call) => call.service === "EventStore" && call.method === "publish")
          .map((call) => (call.args as { _tag: string } | undefined)?._tag)

        expect(tags.includes("MachineInspected")).toBe(true)
        expect(tags.includes("TurnCompleted")).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })
})
