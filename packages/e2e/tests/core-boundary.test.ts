import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Stream } from "effect"
import { EventStore } from "@gent/core/domain/event"
import { Permission } from "@gent/core/domain/permission"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { MessageId } from "@gent/core/domain/ids"
import { QueueEntryInfo, QueueSnapshot, emptyQueueSnapshot } from "@gent/core/domain/queue"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { Provider } from "@gent/core/providers/provider"
import { AppServicesLive } from "@gent/core/server/index"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { SessionCwdRegistry } from "@gent/core/runtime/session-cwd-registry"
import { SessionCommands } from "@gent/core/server/session-commands"
import { SessionQueries } from "@gent/core/server/session-queries"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import {
  SessionRuntime,
  SessionRuntimeStateSchema,
  type RuntimeCommand,
} from "@gent/core/runtime/session-runtime"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { ConfigService } from "@gent/core/runtime/config-service"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
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

const makeAppLayer = (sessionRuntimeLayer: Layer.Layer<SessionRuntime>) => {
  const baseDeps = Layer.mergeAll(
    Storage.TestWithSql(),
    EventStore.Memory,
    sessionRuntimeLayer,
    testExtensionRegistryLayer,
    runtimePlatformLayer,
    Provider.Debug(),
    Permission.Live([], "allow"),
    ConfigService.Test(),
    MachineEngine.Test(),
    SessionCwdRegistry.Test(),
    ApprovalService.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDeps)
  return Layer.provideMerge(AppServicesLive, Layer.merge(baseDeps, eventPublisherLayer))
}

describe("SessionCommands → SessionRuntime boundary", () => {
  test("createSession then sendMessage dispatches SendUserMessage to SessionRuntime", async () => {
    const dispatchLog = Ref.makeUnsafe<RuntimeCommand[]>([])
    const layer = makeAppLayer(
      Layer.succeed(SessionRuntime, {
        dispatch: (command) => Ref.update(dispatchLog, (commands) => [...commands, command]),
        drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getState: () =>
          Effect.succeed(
            new SessionRuntimeStateSchema.Idle({
              agent: "cowork",
              queue: emptyQueueSnapshot(),
            }),
          ),
        getMetrics: () =>
          Effect.succeed({ turns: 0, tokens: 0, toolCalls: 0, retries: 0, durationMs: 0 }),
        watchState: () => Effect.succeed(Stream.empty),
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const session = yield* commands.createSession({ name: "Integration Test" })

        yield* commands.sendMessage({
          sessionId: session.sessionId,
          branchId: session.branchId,
          content: "hello from sendMessage",
        })

        const dispatched = yield* Ref.get(dispatchLog)
        expect(dispatched).toHaveLength(1)
        expect(dispatched[0]).toMatchObject({
          _tag: "SendUserMessage",
          sessionId: session.sessionId,
          branchId: session.branchId,
          content: "hello from sendMessage",
        })
      }).pipe(Effect.provide(layer)),
    )
  })

  test("steer dispatches ApplySteer to SessionRuntime", async () => {
    const dispatchLog = Ref.makeUnsafe<RuntimeCommand[]>([])
    const layer = makeAppLayer(
      Layer.succeed(SessionRuntime, {
        dispatch: (command) => Ref.update(dispatchLog, (commands) => [...commands, command]),
        drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getState: () =>
          Effect.succeed(
            new SessionRuntimeStateSchema.Idle({
              agent: "cowork",
              queue: emptyQueueSnapshot(),
            }),
          ),
        getMetrics: () =>
          Effect.succeed({ turns: 0, tokens: 0, toolCalls: 0, retries: 0, durationMs: 0 }),
        watchState: () => Effect.succeed(Stream.empty),
      }),
    )

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

        const dispatched = yield* Ref.get(dispatchLog)
        expect(dispatched).toHaveLength(1)
        expect(dispatched[0]).toMatchObject({
          _tag: "ApplySteer",
          command: {
            _tag: "SwitchAgent",
            sessionId: session.sessionId,
            branchId: session.branchId,
            agent: "deepwork",
          },
        })
      }).pipe(Effect.provide(layer)),
    )
  })

  test("session snapshot reads runtime state from SessionRuntime", async () => {
    const layer = makeAppLayer(
      Layer.succeed(SessionRuntime, {
        dispatch: () => Effect.void,
        drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getState: () =>
          Effect.succeed(
            new SessionRuntimeStateSchema.Running({
              agent: "deepwork",
              queue: new QueueSnapshot({
                steering: [
                  new QueueEntryInfo({
                    id: MessageId.of("queue-steering"),
                    kind: "steering",
                    content: "steer",
                    createdAt: 0,
                  }),
                ],
                followUp: [
                  new QueueEntryInfo({
                    id: MessageId.of("queue-follow-up"),
                    kind: "follow-up",
                    content: "follow-up",
                    createdAt: 0,
                  }),
                ],
              }),
            }),
          ),
        getMetrics: () =>
          Effect.succeed({ turns: 0, tokens: 0, toolCalls: 0, retries: 0, durationMs: 0 }),
        watchState: () => Effect.succeed(Stream.empty),
      }),
    )

    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const queries = yield* SessionQueries
        const session = yield* commands.createSession({ name: "Snapshot Test" })

        return yield* queries.getSessionSnapshot({
          sessionId: session.sessionId,
          branchId: session.branchId,
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(snapshot.runtime).toEqual({
      _tag: "Running",
      agent: "deepwork",
      queue: {
        steering: [
          {
            id: "queue-steering",
            kind: "steering",
            content: "steer",
            createdAt: 0,
          },
        ],
        followUp: [
          {
            id: "queue-follow-up",
            kind: "follow-up",
            content: "follow-up",
            createdAt: 0,
          },
        ],
      },
    })
  })
})
