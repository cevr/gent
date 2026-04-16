import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { LocalActorProcessLive, ActorProcess } from "@gent/core/runtime/actor-process"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import type { Message, TextPart } from "@gent/core/domain/message"
import { Session, Branch, ToolResultPart } from "@gent/core/domain/message"
import { Agents } from "@gent/extensions/all-agents"
import type { AnyToolDefinition } from "@gent/core/domain/tool"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { SequenceRecorder, RecordingEventStore } from "@gent/core/test-utils"

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

describe("ActorProcess", () => {
  const makeActorProcessLayer = (agentLoopLayer: Layer.Layer<AgentLoop>) => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const extRegistry = makeTestExtRegistry()
    const deps = Layer.mergeAll(
      Storage.Test(),
      agentLoopLayer,
      extRegistry,
      ExtensionStateRuntime.Test(),
      eventStoreLayer,
      recorderLayer,
      ToolRunner.Test(),
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    return Layer.provideMerge(LocalActorProcessLive, Layer.merge(deps, eventPublisherLayer))
  }

  test("steerAgent delegates to AgentLoop.steer", async () => {
    let steered = false
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () =>
        Effect.sync(() => {
          steered = true
        }),
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
      respondInteraction: () => Effect.void,
      getState: () => Effect.succeed({ status: "idle" as const, agent: "cowork", queueDepth: 0 }),
    })

    const layer = makeActorProcessLayer(agentLoopLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const actorProcess = yield* ActorProcess
        yield* actorProcess.steerAgent({
          _tag: "SwitchAgent",
          sessionId: "s1" as never,
          branchId: "b1" as never,
          agent: "deepwork",
        })
        expect(steered).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("sendUserMessage publishes AgentRestarted on defect", async () => {
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      submit: () => Effect.die("boom"),
      run: () => Effect.die("boom"),
      steer: () => Effect.void,
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
      respondInteraction: () => Effect.void,
      getState: () => Effect.succeed({ status: "idle" as const, agent: "cowork", queueDepth: 0 }),
    })

    const layer = makeActorProcessLayer(agentLoopLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const actorProcess = yield* ActorProcess
        const recorder = yield* SequenceRecorder

        const now = new Date()
        yield* storage.createSession(
          new Session({
            id: "defect-session",
            name: "Defect",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: "defect-branch",
            sessionId: "defect-session",
            createdAt: now,
          }),
        )

        yield* actorProcess.sendUserMessage({
          sessionId: "defect-session" as never,
          branchId: "defect-branch" as never,
          content: "trigger defect",
        })

        const calls = yield* recorder.getCalls()
        const publishedTags = calls
          .filter((c) => c.service === "EventStore" && c.method === "publish")
          .map((c) => (c.args as { _tag: string } | undefined)?._tag)

        expect(publishedTags).toContain("AgentRestarted")
        expect(publishedTags).toContain("ErrorOccurred")

        // AgentRestarted should come before ErrorOccurred
        const restartIdx = publishedTags.indexOf("AgentRestarted")
        const errorIdx = publishedTags.indexOf("ErrorOccurred")
        expect(restartIdx).toBeLessThan(errorIdx)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("invokeTool persists assistant and tool messages, then schedules one follow-up", async () => {
    let followUpText: string | undefined

    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      submit: (message: Message) =>
        Effect.sync(() => {
          followUpText = message.parts
            .filter((part): part is TextPart => part.type === "text")
            .map((part) => part.text)
            .join("")
        }),
      run: (message: Message) =>
        Effect.sync(() => {
          followUpText = message.parts
            .filter((part): part is TextPart => part.type === "text")
            .map((part) => part.text)
            .join("")
        }),
      steer: () => Effect.void,
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
      respondInteraction: () => Effect.void,
      getState: () => Effect.succeed({ status: "idle" as const, agent: "cowork", queueDepth: 0 }),
    })
    const toolRunnerLayer = Layer.succeed(ToolRunner, {
      run: (toolCall) =>
        Effect.succeed(
          new ToolResultPart({
            type: "tool-result",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output: { type: "json", value: { ok: true } },
          }),
        ),
    })

    const extRegistry2 = makeTestExtRegistry()
    const deps = Layer.mergeAll(
      Storage.Test(),
      agentLoopLayer,
      extRegistry2,
      ExtensionStateRuntime.Test(),
      eventStoreLayer,
      recorderLayer,
      toolRunnerLayer,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    const layer = Layer.provideMerge(LocalActorProcessLive, Layer.merge(deps, eventPublisherLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const actorProcess = yield* ActorProcess
        const recorder = yield* SequenceRecorder
        const now = new Date()

        yield* storage.createSession(
          new Session({
            id: "invoke-session",
            name: "Invoke Tool",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: "invoke-branch",
            sessionId: "invoke-session",
            createdAt: now,
          }),
        )

        yield* actorProcess.invokeTool({
          sessionId: "invoke-session" as never,
          branchId: "invoke-branch" as never,
          toolName: "read",
          input: {},
        })

        const messages = yield* storage.listMessages("invoke-branch" as never)
        const calls = yield* recorder.getCalls()
        const publishedTags = calls
          .filter((call) => call.service === "EventStore" && call.method === "publish")
          .map((call) => (call.args as { _tag?: string } | undefined)?._tag)

        expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"])
        expect(messages[0]?.parts[0]?.type).toBe("tool-call")
        expect(messages[1]?.parts[0]?.type).toBe("tool-result")
        expect(followUpText).toBe("Tool read completed. Review the result and continue.")
        expect(publishedTags).toContain("ToolCallStarted")
        expect(publishedTags).toContain("ToolCallSucceeded")
        expect(
          publishedTags.filter((tag) => tag === "MessageReceived").length,
        ).toBeGreaterThanOrEqual(2)
      }).pipe(Effect.provide(layer)),
    )
  })
})
