/**
 * Regression: per-entity `handle` rebuild in `agent-loop.actor.ts` must
 * serialize against `concurrency: "unbounded"` mailbox dispatch.
 *
 * `openLoop` flips `closed=false` synchronously, then yields on its first
 * I/O (`getQueueState`). Without holding the startup permit across the
 * full read/rebuild/check, a second op arriving between those two steps
 * observes `closed=false`, skips the serialization, and proceeds against
 * a `handle`/`startupExit` pair that has not yet been reassigned.
 *
 * To turn this into a deterministic regression: wrap `AgentLoopQueueStorage`
 * so the first `getQueueState` call (the one `openLoop` makes on reopen)
 * blocks on a `Deferred`. Op1 enters `ensureStarted`, sets `closed=false`,
 * blocks inside `getQueueState`. Op2 fires concurrently. With the full-body
 * permit, Op2 blocks waiting for Op1 to drop the permit — its completion
 * `Deferred` is unset until we release Op1's gate. With a narrow permit,
 * Op2 races past the `closed` check and completes immediately, before we
 * have released Op1.
 *
 * Assertion: Op2 has NOT completed at the moment Op1 is still inside the
 * gated `getQueueState`. After releasing the gate, Op1 + Op2 both complete.
 *
 * To deterministically drive the actor into `closed=true` first, use
 * `TerminateBranch` (the production path that flips per-entity `closed`
 * via `cleanupLoop`) followed by `clearTerminated` so subsequent ops are
 * allowed past `rejectIfTerminated`.
 */

import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, Layer, Ref, Schedule, Stream } from "effect"
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

const gatedQueueStorageLayer = <E>(
  reopenGate: Ref.Ref<Deferred.Deferred<void> | undefined>,
  reopenEntered: Ref.Ref<Deferred.Deferred<void> | undefined>,
  inner: Layer.Layer<AgentLoopQueueStorage, E>,
): Layer.Layer<AgentLoopQueueStorage, E> => {
  const built = Layer.effect(
    AgentLoopQueueStorage,
    Effect.gen(function* () {
      const real = yield* AgentLoopQueueStorage
      return AgentLoopQueueStorage.of({
        getQueueState: (sessionId, branchId) =>
          Effect.gen(function* () {
            // Snapshot the gate BEFORE signaling entry. If we signaled
            // first and then re-read the gate, the test fiber could clear
            // `reopenGate` between the two reads, and Op1 would slip past
            // unblocked.
            const gate = yield* Ref.get(reopenGate)
            const enteredSignal = yield* Ref.get(reopenEntered)
            if (enteredSignal !== undefined) {
              yield* Deferred.succeed(enteredSignal, undefined)
            }
            if (gate !== undefined) {
              yield* Deferred.await(gate)
            }
            return yield* real.getQueueState(sessionId, branchId)
          }),
        putQueueState: real.putQueueState,
        clearQueueState: real.clearQueueState,
      })
    }),
  )
  return Layer.provide(built, inner)
}

describe("agent-loop recovery race", () => {
  it.live(
    "second op blocks on startup semaphore until first op finishes reopen",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("recovery-race-session")
        const branchId = BranchId.make("recovery-race-branch")

        // Gate the next getQueueState (i.e., the next openLoop) so we can
        // pause Op1 mid-reopen. `reopenEntered` lets us await the moment
        // Op1 has actually entered `getQueueState` (so `closed=false` is
        // already published).
        const reopenGate = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined)
        const reopenEntered = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined)

        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.succeed(
            Stream.fromIterable([
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[]),
          ),
        )

        const baseStorage = SqliteStorage.TestWithSql()
        const wrappedQueueStorage = gatedQueueStorageLayer(
          reopenGate,
          reopenEntered,
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

            // Force-close the entity loop via TerminateBranch (the one
            // production path that flips `closed=true` via cleanupLoop),
            // then clear the session-terminated guard so follow-up ops
            // reach `ensureStarted` rather than getting rejected.
            yield* ref.execute(
              AgentLoopActor.TerminateBranch.make({
                workspaceId: DefaultWorkspaceId,
                sessionId,
                branchId,
              }),
            )
            yield* governance.clearTerminated(DefaultWorkspaceId, sessionId)

            // Install the reopen gate before the next ensureStarted.
            const gate = yield* Deferred.make<void>()
            const entered = yield* Deferred.make<void>()
            yield* Ref.set(reopenGate, gate)
            yield* Ref.set(reopenEntered, entered)

            // Op1 enters the actor mailbox, reaches `ensureStarted`,
            // sets `closed=false`, then BLOCKS inside getQueueState.
            const op1 = yield* ref
              .execute(
                AgentLoopActor.GetState.make({
                  workspaceId: DefaultWorkspaceId,
                  sessionId,
                  branchId,
                }),
              )
              .pipe(Effect.forkChild)

            // Wait until Op1 is provably inside the gated getQueueState
            // (which means `closed=false` is already published — the
            // exact window where a narrow semaphore would let Op2 leak
            // past).
            yield* Deferred.await(entered)

            // Disarm the gate so Op2's own openLoop (if any) won't block.
            // Op2 should NOT need to reopen — under the wide semaphore it
            // blocks on the permit until Op1 finishes; under a narrow
            // semaphore it would race past the now-unset `closed=false`
            // and try to use the partially-rebuilt handle. Either way,
            // the gate must not capture Op2's storage calls.
            yield* Ref.set(reopenGate, undefined)
            yield* Ref.set(reopenEntered, undefined)

            // Op2 fires concurrently. Track its completion via a Deferred
            // so we can assert it has NOT completed while Op1 is gated.
            const op2Done = yield* Deferred.make<void>()
            const op2 = yield* ref
              .execute(
                AgentLoopActor.GetState.make({
                  workspaceId: DefaultWorkspaceId,
                  sessionId,
                  branchId,
                }),
              )
              .pipe(Effect.andThen(Deferred.succeed(op2Done, undefined)), Effect.forkChild)

            // Sanity: Op2 should not have completed yet. With the wide
            // semaphore, Op2 is parked on `startupSemaphore.withPermits`.
            // With a narrow semaphore, Op2 would already have observed
            // `closed=false` and completed (visible as op2Done resolved
            // before we release the gate).
            //
            // We give the scheduler enough ticks to expose any racy
            // completion before checking — without sleeps we cannot
            // distinguish "still running" from "about to complete on the
            // next tick". `Effect.yieldNow` drains the microtask queue
            // without burning wallclock.
            yield* Effect.yieldNow.pipe(Effect.repeat(Schedule.recurs(20)))
            const op2DoneEarly = yield* Deferred.isDone(op2Done)
            expect(op2DoneEarly).toBe(false)

            // Release Op1's gate. Both ops should now drain.
            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(op1)
            yield* Fiber.join(op2)
            yield* Deferred.await(op2Done)
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
        )
      }),
    10000,
  )
})
