import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Ref } from "effect"
import { EventStore } from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import type { SessionId } from "@gent/core/domain/ids"
import { Permission } from "@gent/core/domain/permission"
import { Provider } from "@gent/core/providers/provider"
import { ActorProcess } from "@gent/core/runtime/actor-process"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { ConfigService } from "@gent/core/runtime/config-service"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { AppServicesLive } from "@gent/core/server/index"
import { SessionCommands } from "@gent/core/server/session-commands"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"

describe("SessionCommands", () => {
  it.live("deleteSession terminates event delivery workers before removing state", () =>
    Effect.gen(function* () {
      const terminatedRef = yield* Ref.make<ReadonlyArray<SessionId>>([])

      const baseEventStore = EventStore.Test()
      const baseDeps = Layer.mergeAll(
        Storage.TestWithSql(),
        Provider.Test([]),
        baseEventStore,
        ActorProcess.Test(),
        AgentLoop.Test(),
        ExtensionStateRuntime.Test(),
        ExtensionRegistry.fromResolved(resolveExtensions([])),
        Permission.Live([], "allow"),
        ConfigService.Test(),
        ApprovalService.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      )

      // Wrap real EventPublisherLive to record terminateSession calls
      const recordingPublisher = Layer.effect(
        EventPublisher,
        Effect.gen(function* () {
          const real = yield* EventPublisher
          return {
            publish: (event) => real.publish(event),
            terminateSession: (sessionId) =>
              Ref.update(terminatedRef, (current) => [...current, sessionId]).pipe(
                Effect.andThen(real.terminateSession(sessionId)),
              ),
          }
        }),
      )

      const publisherDeps = Layer.merge(baseDeps, Layer.provide(EventPublisherLive, baseDeps))
      const recordingLayer = Layer.provide(recordingPublisher, publisherDeps)
      const fullDeps = Layer.merge(baseDeps, recordingLayer)
      const layer = Layer.provideMerge(AppServicesLive, fullDeps)

      yield* Effect.gen(function* () {
        const commands = yield* SessionCommands

        const created = yield* commands.createSession({ name: "Delete Me" })
        yield* commands.deleteSession(created.sessionId)

        const terminated = yield* Ref.get(terminatedRef)
        expect(terminated).toEqual([created.sessionId])
      }).pipe(Effect.provide(layer))
    }),
  )
})
