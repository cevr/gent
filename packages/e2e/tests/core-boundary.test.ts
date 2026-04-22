import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Stream } from "effect"
import { EventStore } from "@gent/core/domain/event"
import { Permission } from "@gent/core/domain/permission"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import type { Message } from "@gent/core/domain/message"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { Provider } from "@gent/core/providers/provider"
import { AppServicesLive } from "@gent/core/server/index"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { SessionCwdRegistry } from "@gent/core/runtime/session-cwd-registry"
import { SessionCommands } from "@gent/core/server/session-commands"
import { ResourceManagerLive } from "@gent/core/runtime/resource-manager"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { ConfigService } from "@gent/core/runtime/config-service"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { SessionRuntime } from "@gent/core/runtime/session-runtime"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { Agents } from "@gent/extensions/all-agents"

const runtimePlatformLayer = RuntimePlatform.Test({
  cwd: "/tmp",
  home: "/tmp",
  platform: "test",
})

const testExtensionRegistryLayer = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: "agents" },
      kind: "builtin" as const,
      sourcePath: "test",
      contributions: { agents: Object.values(Agents) },
    },
  ]),
)

const makeAppLayer = (
  storageDeps: Layer.Layer<
    Storage | EventStore | AgentLoop | ToolRunner | ExtensionRegistry,
    never,
    never
  >,
) => {
  const eventPublisherLayer = Layer.provide(
    EventPublisherLive,
    Layer.merge(storageDeps, runtimePlatformLayer),
  )
  const baseRuntime = Layer.mergeAll(
    storageDeps,
    eventPublisherLayer,
    Provider.Debug(),
    Permission.Live([], "allow"),
    ConfigService.Test(),
  )
  const sessionRuntimeLayer = Layer.provide(SessionRuntime.Live, baseRuntime)
  const deps = Layer.mergeAll(baseRuntime, sessionRuntimeLayer, ApprovalService.Test())
  return Layer.provideMerge(AppServicesLive, Layer.merge(deps, runtimePlatformLayer))
}

describe("SessionCommands → SessionRuntime integration", () => {
  const makeIntegrationLayer = (runLog: Ref.Ref<Array<{ sessionId: string; content: string }>>) => {
    const agentLoopLayer = Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const log = yield* Effect.succeed(runLog)
        const appendMessage = (message: Message) =>
          Ref.update(log, (entries) => [
            ...entries,
            {
              sessionId: message.sessionId,
              content: message.parts
                .filter((part): part is { type: "text"; text: string } => part.type === "text")
                .map((part) => part.text)
                .join(""),
            },
          ])

        return {
          submit: (message: Message) => appendMessage(message),
          run: (message: Message) => appendMessage(message),
          steer: () => Effect.void,
          followUp: () => Effect.void,
          isRunning: () => Effect.succeed(false),
          respondInteraction: () => Effect.void,
          watchState: () => Effect.succeed(Stream.empty),
          getState: () =>
            Effect.succeed({
              phase: "idle" as const,
              status: "idle" as const,
              agent: "cowork" as const,
              queue: { steering: [], followUp: [] },
            }),
        }
      }),
    )

    const storageDeps = Layer.mergeAll(
      Storage.TestWithSql(),
      EventStore.Memory,
      agentLoopLayer,
      testExtensionRegistryLayer,
      ToolRunner.Test(),
      MachineEngine.Test(),
      ResourceManagerLive,
      SessionCwdRegistry.Test(),
    )

    return makeAppLayer(storageDeps)
  }

  test("createSession then sendMessage reaches AgentLoop.run", async () => {
    const runLog = Ref.makeUnsafe<Array<{ sessionId: string; content: string }>>([])
    const layer = makeIntegrationLayer(runLog)

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const session = yield* commands.createSession({ name: "Integration Test" })

        yield* commands.sendMessage({
          sessionId: session.sessionId,
          branchId: session.branchId,
          content: "hello from sendMessage",
        })

        const entries = yield* Ref.get(runLog)
        expect(entries.length).toBe(1)
        expect(entries[0]!.sessionId).toBe(session.sessionId)
        expect(entries[0]!.content).toBe("hello from sendMessage")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("sendMessage reaches AgentLoop.run", async () => {
    const runLog = Ref.makeUnsafe<Array<{ sessionId: string; content: string }>>([])
    const layer = makeIntegrationLayer(runLog)

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const session = yield* commands.createSession({ name: "Send Test" })

        yield* commands.sendMessage({
          sessionId: session.sessionId,
          branchId: session.branchId,
          content: "hello from sendMessage",
        })

        const entries = yield* Ref.get(runLog)
        expect(entries.length).toBe(1)
        expect(entries[0]!.sessionId).toBe(session.sessionId)
        expect(entries[0]!.content).toBe("hello from sendMessage")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("steer reaches AgentLoop.steer", async () => {
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
      getState: () =>
        Effect.succeed({
          phase: "idle" as const,
          status: "idle" as const,
          agent: "cowork" as const,
          queue: { steering: [], followUp: [] },
        }),
    })

    const storageDeps = Layer.mergeAll(
      Storage.TestWithSql(),
      EventStore.Memory,
      agentLoopLayer,
      testExtensionRegistryLayer,
      ToolRunner.Test(),
      MachineEngine.Test(),
      ResourceManagerLive,
      SessionCwdRegistry.Test(),
    )
    const layer = makeAppLayer(storageDeps)

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const session = yield* commands.createSession({ name: "Steer Test" })

        yield* commands.steer({
          _tag: "SwitchAgent",
          sessionId: session.sessionId,
          branchId: session.branchId,
          agent: "deepwork",
        })

        expect(steered).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("session runtime getState delegates to the loop snapshot", async () => {
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      isRunning: () => Effect.succeed(true),
      respondInteraction: () => Effect.void,
      watchState: () => Effect.succeed(Stream.empty),
      getState: () =>
        Effect.succeed({
          phase: "running" as const,
          status: "interrupted" as const,
          agent: "deepwork" as const,
          queue: {
            steering: [{ content: "steer" }],
            followUp: [{ content: "follow-up" }],
          },
        }),
    })

    const storageDeps = Layer.mergeAll(
      Storage.TestWithSql(),
      EventStore.Memory,
      agentLoopLayer,
      testExtensionRegistryLayer,
      ToolRunner.Test(),
      MachineEngine.Test(),
      ResourceManagerLive,
      SessionCwdRegistry.Test(),
    )
    const eventPublisherLayer = Layer.provide(
      EventPublisherLive,
      Layer.merge(storageDeps, runtimePlatformLayer),
    )
    const layer = Layer.provide(SessionRuntime.Live, Layer.merge(storageDeps, eventPublisherLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessionRuntime = yield* SessionRuntime
        return yield* sessionRuntime.getState({
          sessionId: SessionId.of("state-session"),
          branchId: BranchId.of("state-branch"),
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toEqual({
      phase: "running",
      status: "interrupted",
      agent: "deepwork",
      queue: {
        steering: [{ content: "steer" }],
        followUp: [{ content: "follow-up" }],
      },
    })
  })
})
