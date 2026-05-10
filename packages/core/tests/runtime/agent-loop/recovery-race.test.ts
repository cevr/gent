/**
 * Regression: per-entity `handle` rebuild in `agent-loop.actor.ts` must
 * serialize against `concurrency: "unbounded"` mailbox dispatch.
 *
 * Without the actor-scope `startupSemaphore`, two ops that arrive while the
 * loop is `closed=true` both observe `closed` on entry to `ensureStarted`,
 * both call `openLoop`, and both reassign `handle`/`startupExit`. The first
 * behavior's `start` fork retains its scope while the new `handle` overwrites
 * it — torn reads, leaked fibers.
 *
 * To deterministically drive the actor into `closed=true`, this test uses
 * `TerminateBranch` (the one production path that flips the per-entity
 * `closed` Ref via `cleanupLoop`) and then `clearTerminated` so subsequent
 * ops are allowed past `rejectIfTerminated` — letting them race into
 * `ensureStarted`'s reopen branch.
 *
 * Empirical guard: `AgentLoopQueueStorage.getQueueState` is called exactly
 * once per `openLoop` (it's the first I/O `openLoop` performs). Counting
 * those calls gives a faithful proxy for "number of `openLoop` invocations".
 * Without the semaphore, N concurrent ops produce N+1 calls (1 initial build
 * + N races). With the semaphore, the count caps at 2.
 */

import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Ref, Stream } from "effect"
import {
  finishPart,
  LanguageModelLayers,
  type LanguageModelStreamPart,
} from "@gent/core-internal/test-utils/language-model"
import { dateFromMillis, Branch, Session } from "@gent/core-internal/domain/message"
import { EventStore } from "@gent/core-internal/domain/event"
import { EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import {
  AgentLoop as AgentLoopActor,
  AgentLoopTestActor,
} from "../../../src/runtime/agent/agent-loop.actor"
import { entityIdOf } from "../../../src/runtime/agent/agent-loop.entity-id"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { ResourceManagerLive } from "../../../src/runtime/resource-manager"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { RuntimeEnvironment } from "../../../src/runtime/runtime-environment"
import { ConfigService } from "../../../src/runtime/config-service"
import { ToolRunner } from "../../../src/runtime/agent/tool-runner"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { AgentLoopQueueStorage } from "../../../src/storage/agent-loop-queue-storage"
import { DefaultWorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import { makeExtRegistry } from "../agent-loop/helpers"

const countingQueueStorageLayer = <E>(
  counter: Ref.Ref<number>,
  inner: Layer.Layer<AgentLoopQueueStorage, E>,
): Layer.Layer<AgentLoopQueueStorage, E> => {
  const built = Layer.effect(
    AgentLoopQueueStorage,
    Effect.gen(function* () {
      const real = yield* AgentLoopQueueStorage
      return AgentLoopQueueStorage.of({
        getQueueState: (sessionId, branchId) =>
          Ref.update(counter, (n) => n + 1).pipe(
            Effect.andThen(real.getQueueState(sessionId, branchId)),
          ),
        putQueueState: real.putQueueState,
        clearQueueState: real.clearQueueState,
      })
    }),
  )
  return Layer.provide(built, inner)
}

describe("agent-loop recovery race", () => {
  it.live(
    "concurrent ops after loop close trigger exactly one openLoop rebuild",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("recovery-race-session")
        const branchId = BranchId.make("recovery-race-branch")
        const openLoopCount = yield* Ref.make(0)

        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.succeed(
            Stream.fromIterable([
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[]),
          ),
        )

        const baseStorage = SqliteStorage.TestWithSql()
        const wrappedQueueStorage = countingQueueStorageLayer(
          openLoopCount,
          Layer.provide(AgentLoopQueueStorage.Live, baseStorage),
        )

        const deps = Layer.mergeAll(
          baseStorage,
          wrappedQueueStorage,
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          BunServices.layer,
          ResourceManagerLive,
          ModelRegistry.Test(),
          GentPlatform.Test(),
        )
        const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
        const layer = AgentLoopTestActor({ baseSections: [] }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
          ),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const sessionStorage = yield* SessionStorage
            const branchStorage = yield* BranchStorage
            const governance = yield* AgentLoopSessionGovernance
            const actorClientFactory = yield* AgentLoopActor.Context

            const now = dateFromMillis(1_767_225_600_000)
            yield* sessionStorage.createSession(
              new Session({
                id: sessionId,
                name: "Recovery Race",
                createdAt: now,
                updatedAt: now,
              }),
            )
            yield* branchStorage.createBranch(
              new Branch({
                id: branchId,
                sessionId,
                createdAt: now,
              }),
            )

            const ref = yield* actorClientFactory(
              entityIdOf(DefaultWorkspaceId, sessionId, branchId),
            )

            // Force-close the entity loop via TerminateBranch — the one
            // production path that flips `closed=true` on the per-entity
            // Ref by running `cleanupLoop(handle)`.
            yield* ref.execute(
              AgentLoopActor.TerminateBranch.make({
                workspaceId: DefaultWorkspaceId,
                sessionId,
                branchId,
              }),
            )

            // TerminateBranch also marks the session terminated, which
            // would short-circuit follow-up ops at `rejectIfTerminated`.
            // Clear it so the next ops reach `ensureStarted` and race.
            yield* governance.clearTerminated(DefaultWorkspaceId, sessionId)

            const countAfterClose = yield* Ref.get(openLoopCount)

            // Fire N concurrent GetState ops. `GetState` calls
            // `ensureStarted`. With `closed=true`, each fiber observes
            // `closed`; without the semaphore, each fiber calls `openLoop`
            // independently → N+1 total getQueueState calls.
            yield* Effect.all(
              [
                ref.execute(
                  AgentLoopActor.GetState.make({
                    workspaceId: DefaultWorkspaceId,
                    sessionId,
                    branchId,
                  }),
                ),
                ref.execute(
                  AgentLoopActor.GetState.make({
                    workspaceId: DefaultWorkspaceId,
                    sessionId,
                    branchId,
                  }),
                ),
                ref.execute(
                  AgentLoopActor.GetState.make({
                    workspaceId: DefaultWorkspaceId,
                    sessionId,
                    branchId,
                  }),
                ),
                ref.execute(
                  AgentLoopActor.GetState.make({
                    workspaceId: DefaultWorkspaceId,
                    sessionId,
                    branchId,
                  }),
                ),
                ref.execute(
                  AgentLoopActor.GetState.make({
                    workspaceId: DefaultWorkspaceId,
                    sessionId,
                    branchId,
                  }),
                ),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.catchEager(() => Effect.void))

            const countAfterConcurrentOps = yield* Ref.get(openLoopCount)
            const reopenCount = countAfterConcurrentOps - countAfterClose

            // Initial entity build calls openLoop once. After
            // TerminateBranch, the next op triggers ONE more openLoop
            // (the rebuild). With the semaphore, 5 concurrent ops produce
            // exactly 1 rebuild; without, they produce 5.
            expect(reopenCount).toBeLessThanOrEqual(1)
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
        )
      }),
    10000,
  )
})
