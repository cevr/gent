import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { EventStore } from "@gent/core/domain/event"
import { Permission } from "@gent/core/domain/permission"
import {
  PermissionHandler,
  PromptHandler,
  HandoffHandler,
} from "@gent/core/domain/interaction-handlers"
import type { Message } from "@gent/core/domain/message"
import type { AgentName } from "@gent/core/domain/agent"
import { Agents } from "@gent/core/domain/agent"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { AppServicesLive } from "@gent/core/server/index"
import { SessionCommands } from "@gent/core/server/session-commands"
import { LocalActorProcessLive } from "@gent/core/runtime/actor-process"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import type { SteerCommand } from "@gent/core/runtime/agent/agent-loop"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { ConfigService } from "@gent/core/runtime/config-service"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ExtensionEventBus } from "@gent/core/runtime/extensions/event-bus"
import { Provider } from "@gent/core/providers/provider"

const testExtensions = resolveExtensions([
  {
    manifest: { id: "agents" },
    kind: "builtin" as const,
    sourcePath: "test",
    setup: { agents: Object.values(Agents) },
  },
])

interface SubmitCall {
  message: Message
  options?: { bypass?: boolean; agentOverride?: AgentName }
}

describe("sendMessage with agentOverride", () => {
  test("agentOverride is passed through submit as turn-scoped (no SwitchAgent)", async () => {
    const submitLog = Ref.makeUnsafe<SubmitCall[]>([])
    const steerLog = Ref.makeUnsafe<SteerCommand[]>([])

    const agentLoopLayer = Layer.succeed(AgentLoop, {
      submit: (message: Message, options?: { bypass?: boolean; agentOverride?: AgentName }) =>
        Ref.update(submitLog, (log) => [...log, { message, options }]),
      run: (_message: Message) => Effect.void,
      steer: (command: SteerCommand) => Ref.update(steerLog, (log) => [...log, command]),
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

    const storageDeps = Layer.mergeAll(
      Storage.Test(),
      EventStore.Test(),
      agentLoopLayer,
      ExtensionRegistry.fromResolved(testExtensions),
      ExtensionStateRuntime.Live([]),
      ExtensionTurnControl.Test(),
      ExtensionEventBus.Test(),
      ToolRunner.Test(),
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
        const session = yield* commands.createSession({ name: "Agent Override Test" })

        yield* commands.sendMessage({
          sessionId: session.sessionId,
          branchId: session.branchId,
          content: "test with agent override",
          agentOverride: "memory:reflect",
        })

        // Verify agentOverride was passed through submit (turn-scoped)
        const submits = yield* Ref.get(submitLog)
        expect(submits.length).toBe(1)
        expect(submits[0]!.options?.agentOverride).toBe("memory:reflect")

        // Verify NO SwitchAgent steer was called (not persistent)
        const steers = yield* Ref.get(steerLog)
        expect(steers.length).toBe(0)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("sendMessage without agentOverride does not pass override", async () => {
    const submitLog = Ref.makeUnsafe<SubmitCall[]>([])

    const agentLoopLayer = Layer.succeed(AgentLoop, {
      submit: (message: Message, options?: { bypass?: boolean; agentOverride?: AgentName }) =>
        Ref.update(submitLog, (log) => [...log, { message, options }]),
      run: (_message: Message) => Effect.void,
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
    })

    const storageDeps = Layer.mergeAll(
      Storage.Test(),
      EventStore.Test(),
      agentLoopLayer,
      ExtensionRegistry.fromResolved(testExtensions),
      ExtensionStateRuntime.Live([]),
      ExtensionTurnControl.Test(),
      ExtensionEventBus.Test(),
      ToolRunner.Test(),
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
        const session = yield* commands.createSession({ name: "No Override Test" })

        yield* commands.sendMessage({
          sessionId: session.sessionId,
          branchId: session.branchId,
          content: "test without override",
        })

        const submits = yield* Ref.get(submitLog)
        expect(submits.length).toBe(1)
        expect(submits[0]!.options?.agentOverride).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })
})
