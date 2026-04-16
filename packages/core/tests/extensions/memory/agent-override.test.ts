import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { EventStore } from "@gent/core/domain/event"
import { Permission } from "@gent/core/domain/permission"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import type { Message } from "@gent/core/domain/message"
import type { AgentName } from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { AppServicesLive } from "@gent/core/server/index"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { SessionCommands } from "@gent/core/server/session-commands"
import { LocalActorProcessLive } from "@gent/core/runtime/actor-process"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import type { SteerCommand } from "@gent/core/runtime/agent/agent-loop"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { ConfigService } from "@gent/core/runtime/config-service"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { Provider } from "@gent/core/providers/provider"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"

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
  options?: { agentOverride?: AgentName }
}

const makeTestLayer = (logs: {
  submitLog: Ref.Ref<SubmitCall[]>
  steerLog?: Ref.Ref<SteerCommand[]>
}) => {
  const agentLoopLayer = Layer.succeed(AgentLoop, {
    submit: (message: Message, options?: { agentOverride?: AgentName }) =>
      Ref.update(logs.submitLog, (log) => [...log, { message, options }]),
    run: (_message: Message) => Effect.void,
    steer: logs.steerLog
      ? (command: SteerCommand) => Ref.update(logs.steerLog!, (log) => [...log, command])
      : () => Effect.void,
    followUp: () => Effect.void,
    isRunning: () => Effect.succeed(false),
    respondInteraction: () => Effect.void,
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
    EventStore.Test(),
    agentLoopLayer,
    ExtensionRegistry.fromResolved(testExtensions),
    ExtensionStateRuntime.Live([]).pipe(Layer.provideMerge(ExtensionTurnControl.Test())),
    ToolRunner.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, storageDeps)
  const actorProcessLayer = Layer.provide(
    LocalActorProcessLive,
    Layer.merge(storageDeps, eventPublisherLayer),
  )
  const baseWithActorProcess = Layer.mergeAll(
    storageDeps,
    eventPublisherLayer,
    actorProcessLayer,
    Provider.Test([]),
    Permission.Live([], "allow"),
    ConfigService.Test(),
  )
  const deps = Layer.mergeAll(baseWithActorProcess, ApprovalService.Test())
  return Layer.provideMerge(AppServicesLive, deps)
}

describe("sendMessage with agentOverride", () => {
  test("agentOverride is passed through submit as turn-scoped (no SwitchAgent)", async () => {
    const submitLog = Ref.makeUnsafe<SubmitCall[]>([])
    const steerLog = Ref.makeUnsafe<SteerCommand[]>([])
    const layer = makeTestLayer({ submitLog, steerLog })

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

        const submits = yield* Ref.get(submitLog)
        expect(submits.length).toBe(1)
        expect(submits[0]!.options?.agentOverride).toBe("memory:reflect")

        const steers = yield* Ref.get(steerLog)
        expect(steers.length).toBe(0)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("sendMessage without agentOverride does not pass override", async () => {
    const submitLog = Ref.makeUnsafe<SubmitCall[]>([])
    const layer = makeTestLayer({ submitLog })

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

describe("createSession with initialPrompt", () => {
  test("initialPrompt sends message immediately after creation", async () => {
    const submitLog = Ref.makeUnsafe<SubmitCall[]>([])
    const layer = makeTestLayer({ submitLog })

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const session = yield* commands.createSession({
          name: "Initial Prompt Test",
          initialPrompt: "hello from creation",
        })

        expect(session.sessionId).toBeDefined()
        expect(session.branchId).toBeDefined()

        const submits = yield* Ref.get(submitLog)
        expect(submits.length).toBe(1)
        expect(submits[0]!.message.parts[0]!.type).toBe("text")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("initialPrompt with agentOverride threads override through", async () => {
    const submitLog = Ref.makeUnsafe<SubmitCall[]>([])
    const steerLog = Ref.makeUnsafe<SteerCommand[]>([])
    const layer = makeTestLayer({ submitLog, steerLog })

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        yield* commands.createSession({
          name: "Override Prompt Test",
          initialPrompt: "test with override",
          agentOverride: "memory:reflect",
        })

        const submits = yield* Ref.get(submitLog)
        expect(submits.length).toBe(1)
        expect(submits[0]!.options?.agentOverride).toBe("memory:reflect")

        // No SwitchAgent — turn-scoped
        const steers = yield* Ref.get(steerLog)
        expect(steers.length).toBe(0)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("createSession without initialPrompt does not send message", async () => {
    const submitLog = Ref.makeUnsafe<SubmitCall[]>([])
    const layer = makeTestLayer({ submitLog })

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        yield* commands.createSession({ name: "No Prompt Test" })

        const submits = yield* Ref.get(submitLog)
        expect(submits.length).toBe(0)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("empty initialPrompt does not send message", async () => {
    const submitLog = Ref.makeUnsafe<SubmitCall[]>([])
    const layer = makeTestLayer({ submitLog })

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        yield* commands.createSession({
          name: "Empty Prompt Test",
          initialPrompt: "",
        })

        const submits = yield* Ref.get(submitLog)
        expect(submits.length).toBe(0)
      }).pipe(Effect.provide(layer)),
    )
  })
})
