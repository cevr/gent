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
import { SessionCommands } from "@gent/core/server/session-commands"
import { Storage } from "@gent/core/storage/sqlite-storage"

describe("SessionCommands", () => {
  it.live("deleteSession terminates event delivery workers before removing state", () =>
    Effect.gen(function* () {
      const terminatedRef = yield* Ref.make<ReadonlyArray<SessionId>>([])

      const deps = Layer.mergeAll(
        Storage.TestWithSql(),
        Provider.Test([]),
        EventStore.Test(),
        Layer.succeed(EventPublisher, {
          publish: () => Effect.void,
          terminateSession: (sessionId) =>
            Ref.update(terminatedRef, (current) => [...current, sessionId]),
        }),
        ActorProcess.Test(),
        AgentLoop.Test(),
        Layer.succeed(ExtensionStateRuntime, {
          publish: () => Effect.succeed(false),
          deriveAll: () => Effect.succeed([]),
          send: () => Effect.void,
          ask: () => Effect.die("not implemented"),
          getUiSnapshots: () => Effect.succeed([]),
          getActorStatuses: () => Effect.succeed([]),
          terminateAll: () => Effect.void,
        }),
        Permission.Live([], "allow"),
        ConfigService.Test(),
      )

      const layer = Layer.provide(SessionCommands.Live, deps)
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
