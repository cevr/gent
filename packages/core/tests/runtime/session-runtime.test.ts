import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { AgentRunError } from "@gent/core/domain/agent"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import type { AnyCapabilityContribution } from "@gent/core/extensions/api"
import type { ExtensionContributions } from "../../src/domain/extension.js"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { ResourceManagerLive } from "@gent/core/runtime/resource-manager"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { Session, Branch, ToolResultPart } from "@gent/core/domain/message"
import { emptyQueueSnapshot } from "@gent/core/domain/queue"
import { Agents } from "@gent/extensions/all-agents"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { SequenceRecorder, RecordingEventStore } from "@gent/core/test-utils"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import {
  SessionRuntime,
  applySteerCommand,
  interruptPayloadToSteerCommand,
  invokeToolCommand,
  respondInteractionCommand,
  sendUserMessageCommand,
} from "@gent/core/runtime/session-runtime"

const makeTestExtRegistry = (tools: AnyCapabilityContribution[] = []) =>
  ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "agents" },
        kind: "builtin" as const,
        sourcePath: "test",
        contributions: { agents: Object.values(Agents) } satisfies ExtensionContributions,
      },
      ...(tools.length > 0
        ? [
            {
              manifest: { id: "tools" },
              kind: "builtin" as const,
              sourcePath: "test",
              contributions: { capabilities: tools } satisfies ExtensionContributions,
            },
          ]
        : []),
    ]),
  )

const idleLoopState = {
  _tag: "Idle" as const,
  agent: "cowork" as const,
  queue: emptyQueueSnapshot(),
}

describe("SessionRuntime", () => {
  const makeSessionRuntimeLayer = (agentLoopLayer: Layer.Layer<AgentLoop>) => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      agentLoopLayer,
      makeTestExtRegistry(),
      MachineEngine.Test(),
      eventStoreLayer,
      recorderLayer,
      ToolRunner.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ResourceManagerLive,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    return Layer.provideMerge(SessionRuntime.FromLoop, Layer.merge(deps, eventPublisherLayer))
  }

  test("runOnce preserves AgentRunError from the internal loop", async () => {
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      runOnce: () => Effect.fail(new AgentRunError({ message: "run failed" })),
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
      respondInteraction: () => Effect.void,
      watchState: () => Effect.succeed(Stream.empty),
      getState: () => Effect.succeed(idleLoopState),
    })

    const layer = makeSessionRuntimeLayer(agentLoopLayer)

    await expect(
      Effect.gen(function* () {
        const sessionRuntime = yield* SessionRuntime
        yield* sessionRuntime.runOnce({
          sessionId: "s1" as never,
          branchId: "b1" as never,
          agentName: "cowork",
          prompt: "do the thing",
        })
      }).pipe(Effect.provide(layer), Effect.runPromise),
    ).rejects.toMatchObject({ _tag: "AgentRunError", message: "run failed" })
  })

  test("dispatch ApplySteer hands control to the internal loop", async () => {
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
      watchState: () => Effect.succeed(Stream.empty),
      getState: () => Effect.succeed(idleLoopState),
    })

    const layer = makeSessionRuntimeLayer(agentLoopLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const sessionRuntime = yield* SessionRuntime
        yield* sessionRuntime.dispatch(
          applySteerCommand({
            _tag: "SwitchAgent",
            sessionId: "s1" as never,
            branchId: "b1" as never,
            agent: "deepwork",
          }),
        )
        expect(steered).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("interrupt translates interject payloads onto a tagged steer command", async () => {
    let commandSeen:
      | {
          _tag: string
          sessionId: string
          branchId: string
          message?: string
        }
      | undefined

    const agentLoopLayer = Layer.succeed(AgentLoop, {
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: (command) =>
        Effect.sync(() => {
          commandSeen = command as typeof commandSeen
        }),
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
      respondInteraction: () => Effect.void,
      watchState: () => Effect.succeed(Stream.empty),
      getState: () => Effect.succeed(idleLoopState),
    })

    const layer = makeSessionRuntimeLayer(agentLoopLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const sessionRuntime = yield* SessionRuntime
        yield* sessionRuntime.dispatch(
          applySteerCommand(
            interruptPayloadToSteerCommand({
              _tag: "Interject",
              sessionId: "s1" as never,
              branchId: "b1" as never,
              message: "cut in",
            }),
          ),
        )
        expect(commandSeen).toEqual({
          _tag: "Interject",
          sessionId: "s1",
          branchId: "b1",
          message: "cut in",
        })
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
      watchState: () => Effect.succeed(Stream.empty),
      getState: () => Effect.succeed(idleLoopState),
    })

    const layer = makeSessionRuntimeLayer(agentLoopLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const sessionRuntime = yield* SessionRuntime
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

        yield* sessionRuntime.dispatch(
          sendUserMessageCommand({
            sessionId: "defect-session" as never,
            branchId: "defect-branch" as never,
            content: "trigger defect",
          }),
        )

        const calls = yield* recorder.getCalls()
        const publishedTags = calls
          .filter((call) => call.service === "EventStore" && call.method === "publish")
          .map((call) => (call.args as { _tag: string } | undefined)?._tag)

        expect(publishedTags).toContain("AgentRestarted")
        expect(publishedTags).toContain("ErrorOccurred")
        expect(publishedTags.indexOf("AgentRestarted")).toBeLessThan(
          publishedTags.indexOf("ErrorOccurred"),
        )
      }).pipe(Effect.provide(layer)),
    )
  })

  test("invokeTool persists assistant and tool messages without auto-scheduling a follow-up", async () => {
    let submitCount = 0

    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      submit: () =>
        Effect.sync(() => {
          submitCount += 1
        }),
      run: () =>
        Effect.sync(() => {
          submitCount += 1
        }),
      steer: () => Effect.void,
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
      respondInteraction: () => Effect.void,
      watchState: () => Effect.succeed(Stream.empty),
      getState: () => Effect.succeed(idleLoopState),
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

    const deps = Layer.mergeAll(
      Storage.Test(),
      agentLoopLayer,
      makeTestExtRegistry(),
      MachineEngine.Test(),
      eventStoreLayer,
      recorderLayer,
      toolRunnerLayer,
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ResourceManagerLive,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    const layer = Layer.provideMerge(
      SessionRuntime.FromLoop,
      Layer.merge(deps, eventPublisherLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const sessionRuntime = yield* SessionRuntime
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

        yield* sessionRuntime.dispatch(
          invokeToolCommand({
            sessionId: "invoke-session" as never,
            branchId: "invoke-branch" as never,
            toolName: "read",
            input: {},
          }),
        )

        const messages = yield* storage.listMessages("invoke-branch" as never)
        const calls = yield* recorder.getCalls()
        const publishedTags = calls
          .filter((call) => call.service === "EventStore" && call.method === "publish")
          .map((call) => (call.args as { _tag?: string } | undefined)?._tag)

        expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"])
        expect(messages[0]?.parts[0]?.type).toBe("tool-call")
        expect(messages[1]?.parts[0]?.type).toBe("tool-result")
        expect(submitCount).toBe(0)
        expect(publishedTags).toContain("ToolCallStarted")
        expect(publishedTags).toContain("ToolCallSucceeded")
        expect(
          publishedTags.filter((tag) => tag === "MessageReceived").length,
        ).toBeGreaterThanOrEqual(2)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("dispatch RespondInteraction hands the response to the internal loop", async () => {
    let responseSeen:
      | {
          sessionId: string
          branchId: string
          requestId: string
        }
      | undefined

    const agentLoopLayer = Layer.succeed(AgentLoop, {
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
      respondInteraction: (input) =>
        Effect.sync(() => {
          responseSeen = input as typeof responseSeen
        }),
      watchState: () => Effect.succeed(Stream.empty),
      getState: () => Effect.succeed(idleLoopState),
    })

    const layer = makeSessionRuntimeLayer(agentLoopLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const sessionRuntime = yield* SessionRuntime
        yield* sessionRuntime.dispatch(
          respondInteractionCommand({
            sessionId: "s1" as never,
            branchId: "b1" as never,
            requestId: "req-1",
          }),
        )
        expect(responseSeen).toEqual({
          _tag: "RespondInteraction",
          sessionId: "s1",
          branchId: "b1",
          requestId: "req-1",
        })
      }).pipe(Effect.provide(layer)),
    )
  })
})
