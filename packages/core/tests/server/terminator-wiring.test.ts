/**
 * Service-pair contract for `SessionRuntimeTerminator` (the private service
 * inside `session-commands.ts`).
 *
 * `SessionRuntimeTerminatorLive` constructs an empty `Ref<SessionRuntimeService>`.
 * `RegisterSessionRuntimeTerminatorLive` is a separate `Layer.effectDiscard`
 * that wires the live `SessionRuntime` into that Ref. Without the latter,
 * every `terminator.terminateSession` / `restoreSession` call inside
 * `SessionCommands.cleanupSessionRuntimeState` is a silent no-op (the
 * `withRuntime` helper short-circuits when the Ref is undefined).
 *
 * Production wires both halves via `dependencies.ts:207` + `:322`. The test
 * layers (`in-process-layer`, `e2e-layer`) historically wired only the
 * first half, so anything booting through `AppServicesLive` had a dead
 * terminator and the runtime-side cleanup was silently skipped.
 *
 * This file pins down the service-pair contract on its own (using a
 * hand-rolled layer with `SessionMutationsLive` directly, NOT
 * `baseLocalLayer` / `createE2ELayer`). It proves the second half of the
 * pair is load-bearing — drop the registration layer, the positive arm
 * fails. Real verification that `in-process-layer.ts` and `e2e-layer.ts`
 * wire both halves correctly comes from `core-boundary.test.ts`, which
 * deletes a session and awaits `events.closed` — that signal only fires
 * when the registered runtime's stream closes, so a missing registration
 * would hang the test past its 15s timeout.
 *
 * Two arms:
 *   1. With registration → probe `SessionRuntime.terminateSession` is called.
 *   2. Without registration → probe is never called (silent no-op).
 *
 * Per `validate-test-catches-regression`: the negative arm proves the
 * positive arm's protection is load-bearing — if the registration layer is
 * dropped, the positive arm fails.
 */
import { describe, it, expect } from "effect-bun-test"
import { DateTime, Effect, Layer, Stream } from "effect"
import { Branch, Session } from "../../src/domain/message"
import { BranchId, SessionId } from "../../src/domain/ids"
import { emptyQueueSnapshot } from "../../src/domain/queue"
import { EventStore } from "../../src/domain/event"
import { EventPublisher } from "../../src/domain/event-publisher"
import { Provider } from "../../src/providers/provider"
import { SessionMutations } from "../../src/domain/session-mutations"
import {
  MachineEngine,
  type MachineEngineService,
} from "../../src/runtime/extensions/resource-host/machine-engine"
import {
  SessionRuntime,
  SessionRuntimeStateSchema,
  type SessionRuntimeService,
} from "../../src/runtime/session-runtime"
import { SessionCwdRegistry } from "../../src/runtime/session-cwd-registry"
import { SessionCommands } from "../../src/server/session-commands"
import { BranchStorage } from "../../src/storage/branch-storage"
import { SessionStorage } from "../../src/storage/session-storage"
import { Storage, subTagLayers } from "../../src/storage/sqlite-storage"

const sessionRuntimeProbe = (terminated: Array<SessionId>): Layer.Layer<SessionRuntime> =>
  Layer.succeed(SessionRuntime, {
    dispatch: () => Effect.void,
    runPrompt: () => Effect.void,
    drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
    getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
    getState: () =>
      Effect.succeed(
        SessionRuntimeStateSchema.Idle.make({
          agent: "probe" as const,
          queue: emptyQueueSnapshot(),
        }),
      ),
    getMetrics: () =>
      Effect.succeed({ turns: 0, tokens: 0, toolCalls: 0, retries: 0, durationMs: 0 }),
    watchState: () => Effect.succeed(Stream.empty),
    terminateSession: (sessionId) =>
      Effect.sync(() => {
        terminated.push(sessionId)
      }),
    restoreSession: () => Effect.void,
  } satisfies SessionRuntimeService)

const machineProbeLayer: Layer.Layer<MachineEngine> = Layer.succeed(MachineEngine, {
  publish: () => Effect.succeed([]),
  send: () => Effect.void,
  execute: () => Effect.die("unexpected machine request"),
  getActorStatuses: () => Effect.succeed([]),
  terminateAll: () => Effect.void,
} satisfies MachineEngineService)

const baseDeps = ({
  withRegistration,
  runtimeLayer,
}: {
  withRegistration: boolean
  runtimeLayer: Layer.Layer<SessionRuntime>
}) => {
  const storageLayer = Storage.MemoryWithSql()
  const terminatorLayer = SessionCommands.SessionRuntimeTerminatorLive
  const registerLayer = withRegistration
    ? Layer.provide(
        SessionCommands.RegisterSessionRuntimeTerminatorLive,
        Layer.merge(runtimeLayer, terminatorLayer),
      )
    : Layer.empty
  return Layer.mergeAll(
    storageLayer,
    subTagLayers(storageLayer),
    runtimeLayer,
    terminatorLayer,
    registerLayer,
    EventStore.Memory,
    EventPublisher.Test(),
    Provider.Debug(),
    machineProbeLayer,
    SessionCwdRegistry.Test(),
  )
}

const seedSession = (sessionId: SessionId, branchId: BranchId) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStorage
    const branches = yield* BranchStorage
    const now = yield* DateTime.nowAsDate
    const session = new Session({ id: sessionId, createdAt: now, updatedAt: now })
    yield* sessions.createSession(session)
    yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
    yield* sessions.updateSession(new Session({ ...session, activeBranchId: branchId }))
  })

describe("SessionRuntimeTerminator wiring through SessionCommands.deleteSession", () => {
  it.effect(
    "with RegisterSessionRuntimeTerminatorLive: deleteSession reaches the live SessionRuntime",
    () => {
      const terminated: Array<SessionId> = []
      const sessionId = SessionId.make("wired-session")
      const branchId = BranchId.make("wired-branch")
      const layer = Layer.provideMerge(
        SessionCommands.SessionMutationsLive,
        baseDeps({ withRegistration: true, runtimeLayer: sessionRuntimeProbe(terminated) }),
      )
      return Effect.gen(function* () {
        yield* seedSession(sessionId, branchId)
        const mutations = yield* SessionMutations
        yield* mutations.deleteSession(sessionId)
        expect(terminated).toEqual([sessionId])
      }).pipe(Effect.provide(layer), Effect.timeout("4 seconds"))
    },
  )

  it.effect(
    "without RegisterSessionRuntimeTerminatorLive: deleteSession silently no-ops the runtime call",
    () => {
      const terminated: Array<SessionId> = []
      const sessionId = SessionId.make("unwired-session")
      const branchId = BranchId.make("unwired-branch")
      const layer = Layer.provideMerge(
        SessionCommands.SessionMutationsLive,
        baseDeps({ withRegistration: false, runtimeLayer: sessionRuntimeProbe(terminated) }),
      )
      return Effect.gen(function* () {
        yield* seedSession(sessionId, branchId)
        const mutations = yield* SessionMutations
        yield* mutations.deleteSession(sessionId)
        expect(terminated).toEqual([])
      }).pipe(Effect.provide(layer), Effect.timeout("4 seconds"))
    },
  )
})
