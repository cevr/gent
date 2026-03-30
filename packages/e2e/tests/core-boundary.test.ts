import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { EventStore } from "@gent/core/domain/event"
import { Permission } from "@gent/core/domain/permission"
import {
  PermissionHandler,
  PromptHandler,
  HandoffHandler,
} from "@gent/core/domain/interaction-handlers"
import type { SessionId } from "@gent/core/domain/ids"
import type { Message } from "@gent/core/domain/message"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { Provider } from "@gent/core/providers/provider"
import { AppServicesLive } from "@gent/core/server/index"
import { SessionCommands } from "@gent/core/server/session-commands"
import { ActorProcess, LocalActorProcessLive } from "@gent/core/runtime/actor-process"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { ConfigService } from "@gent/core/runtime/config-service"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { Agents } from "@gent/core/domain/agent"

const testExtensionRegistryLayer = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: "agents" },
      kind: "builtin" as const,
      sourcePath: "test",
      setup: { agents: Object.values(Agents) },
    },
  ]),
)

describe("SessionCommands → ActorProcess integration", () => {
  const makeActorProcessLayer = (
    storageDeps: Layer.Layer<
      Storage | EventStore | AgentLoop | ToolRunner | ExtensionRegistry,
      never,
      never
    >,
  ) => Layer.provide(LocalActorProcessLive, storageDeps)

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
                .filter((p): p is { type: "text"; text: string } => p.type === "text")
                .map((p) => p.text)
                .join(""),
            },
          ])
        return {
          submit: (message: Message) => appendMessage(message),
          run: (message: Message) => appendMessage(message),
          steer: () => Effect.void,
          followUp: () => Effect.void,
          isRunning: () => Effect.succeed(false),
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

    const eventStoreLayer = EventStore.Test()
    const storageDeps = Layer.mergeAll(
      Storage.Test(),
      eventStoreLayer,
      agentLoopLayer,
      testExtensionRegistryLayer,
      ToolRunner.Test(),
      ExtensionStateRuntime.Test(),
    )
    const actorProcessLayer = makeActorProcessLayer(storageDeps)
    const baseWithActorProcess = Layer.mergeAll(
      storageDeps,
      actorProcessLayer,
      Provider.Test([]),
      Permission.Live([], "ask"),
      ConfigService.Test(),
    )
    const deps = Layer.mergeAll(
      baseWithActorProcess,
      Layer.provide(PermissionHandler.Live, baseWithActorProcess),
      Layer.provide(PromptHandler.Live, baseWithActorProcess),
      Layer.provide(HandoffHandler.Live, baseWithActorProcess),
    )
    return Layer.provideMerge(AppServicesLive, deps)
  }

  test("createSession then sendMessage reaches AgentLoop.run", async () => {
    const runLog = Ref.makeUnsafe<Array<{ sessionId: string; content: string }>>([])
    const layer = makeIntegrationLayer(runLog)

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const session = yield* commands.createSession({
          name: "Integration Test",
        })

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
      getState: () =>
        Effect.succeed({
          phase: "idle" as const,
          status: "idle" as const,
          agent: "cowork" as const,
          queue: { steering: [], followUp: [] },
        }),
    })

    const eventStoreLayer = EventStore.Test()
    const storageDeps = Layer.mergeAll(
      Storage.Test(),
      eventStoreLayer,
      agentLoopLayer,
      testExtensionRegistryLayer,
      ToolRunner.Test(),
      ExtensionStateRuntime.Test(),
    )
    const actorProcessLayer = Layer.provide(LocalActorProcessLive, storageDeps)
    const baseWithActorProcess = Layer.mergeAll(
      storageDeps,
      actorProcessLayer,
      Provider.Test([]),
      Permission.Live([], "ask"),
      ConfigService.Test(),
    )
    const deps = Layer.mergeAll(
      baseWithActorProcess,
      Layer.provide(PermissionHandler.Live, baseWithActorProcess),
      Layer.provide(PromptHandler.Live, baseWithActorProcess),
      Layer.provide(HandoffHandler.Live, baseWithActorProcess),
    )
    const layer = Layer.provideMerge(AppServicesLive, deps)

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

  test("actor process getState delegates to the loop snapshot", async () => {
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      isRunning: () => Effect.succeed(true),
      getState: () =>
        Effect.succeed({
          phase: "streaming" as const,
          status: "interrupted" as const,
          agent: "deepwork" as const,
          queue: {
            steering: [{ content: "steer" }],
            followUp: [{ content: "follow-up" }],
          },
        }),
    })

    const storageDeps = Layer.mergeAll(
      Storage.Test(),
      EventStore.Test(),
      agentLoopLayer,
      testExtensionRegistryLayer,
      ToolRunner.Test(),
    )
    const layer = Layer.provide(LocalActorProcessLive, storageDeps)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const actorProcess = yield* ActorProcess
        return yield* actorProcess.getState({
          sessionId: "state-session" as SessionId,
          branchId: "state-branch" as BranchId,
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toEqual({
      phase: "streaming",
      status: "interrupted",
      agent: "deepwork",
      queue: {
        steering: [{ content: "steer" }],
        followUp: [{ content: "follow-up" }],
      },
      lastError: undefined,
    })
  })
})
