import { describe, expect, it } from "effect-bun-test"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect"
import { ClientLayer } from "effect-encore"
import { ShardingConfig } from "effect/unstable/cluster"
import { PersistenceError } from "effect/unstable/cluster/ClusterError"
import { SqlClient } from "effect/unstable/sql"
import { defineResource, type AnyResourceContribution } from "@gent/core-internal/domain/resource"
import { ResourceId, ResourceRevision } from "@gent/core-internal/domain/resource-graph"
import {
  CanonicalCwd,
  ResourceGraphDesiredCommand,
  ResourceGraphRevision,
  ResourceGraphSnapshot,
  ResourceGraphSource,
  ResourceGraphStatus,
} from "@gent/core-internal/domain/resource-graph-state"
import type { ResourceGraphDesiredReceipt } from "@gent/core-internal/domain/resource-graph-state"
import { ExtensionId, RequestId } from "@gent/core-internal/domain/ids"
import { ResourceGraphStorage } from "@gent/core-internal/storage/resource-graph-storage"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { StorageError } from "@gent/core-internal/domain/storage-error"
import { CurrentWorkspaceId, WorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { makeResourceGraphHost } from "../../src/runtime/extensions/resource-host/resource-graph-host"
import {
  ResourceGraph,
  ResourceGraphActorTest,
  ResourceGraphApplyError,
  ResourceGraphCommandError,
  ResourceGraphDesiredApplier,
  ResourceGraphRecoveryPayload,
  type ResourceGraphDesiredApplication,
  type ResourceGraphPrepared,
  resourceGraphEntityId,
} from "../../src/runtime/extensions/resource-host/resource-graph-entity"
import {
  ResourceGraphCommandService,
  ResourceGraphDispatch,
  type ResourceGraphDispatchService,
} from "../../src/runtime/extensions/resource-host/resource-graph-command"

const WORKSPACE_A = WorkspaceId.make("a".repeat(64))
const CWD_A = CanonicalCwd.make("/tmp/resource-graph-command")
const CWD_B = CanonicalCwd.make("/tmp/resource-graph-command-b")
const RESOURCE_ID = ResourceId.make("@test/resource-graph-command/service")
const RESOURCE_REVISION = ResourceRevision.make("service/1")

class TestService extends Context.Service<TestService, { readonly value: string }>()(
  "@gent/core/tests/extensions/resource-graph-command.test/TestService",
) {}

interface AdmissionControl {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

const makeResource = (events: Array<string>): AnyResourceContribution =>
  defineResource({
    id: RESOURCE_ID,
    revision: RESOURCE_REVISION,
    scope: "process",
    layer: Layer.effect(
      TestService,
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push("acquire")
          return TestService.of({ value: "live" })
        }),
        () => Effect.sync(() => events.push("release")),
      ),
    ),
    start: Effect.sync(() => events.push("start")),
    stop: Effect.sync(() => events.push("stop")),
  })

const makeSnapshot = (revision = "source/1"): ResourceGraphSnapshot =>
  ResourceGraphSnapshot.make({
    source: ResourceGraphSource.make({
      revision: ResourceGraphRevision.make(revision),
      config: { enabled: true },
      extensions: [
        {
          extensionId: ExtensionId.make("@test/resource-graph-command"),
          scope: "builtin",
          source: "test-artifact",
        },
      ],
    }),
    descriptors: [
      {
        id: RESOURCE_ID,
        revision: ResourceRevision.make(RESOURCE_REVISION),
        requires: [],
        required: false,
      },
    ],
  })

const makeCommand = (commandId: string, desiredRevision: string, snapshot = makeSnapshot()) =>
  ResourceGraphDesiredCommand.make({
    workspaceId: WORKSPACE_A,
    cwd: CWD_A,
    commandId: RequestId.make(commandId),
    desiredRevision: ResourceGraphRevision.make(desiredRevision),
    snapshot,
  })

const makeHostApplierLayer = (
  events: Array<string>,
  control?: AdmissionControl,
  failApply = false,
  postAdmissionControl?: AdmissionControl,
  failPrepareRevision?: string,
): Layer.Layer<ResourceGraphDesiredApplier, never, GentPlatform> =>
  Layer.effect(
    ResourceGraphDesiredApplier,
    Effect.gen(function* () {
      const host = yield* makeResourceGraphHost<string>({})
      const resource = makeResource(events)
      const stage = () => Effect.succeed("catalog")
      const apply = (
        prepared: ResourceGraphPrepared,
        admit: () => Effect.Effect<void, ResourceGraphApplyError>,
      ) =>
        Effect.gen(function* () {
          if (failApply) {
            return yield* new ResourceGraphApplyError({ phase: "apply", message: "boom" })
          }
          if (Predicate.isNotUndefined(control)) {
            yield* Deferred.succeed(control.entered, void 0)
            yield* Deferred.await(control.release)
          }
          yield* admit()
          if (Predicate.isNotUndefined(postAdmissionControl)) {
            yield* Deferred.succeed(postAdmissionControl.entered, void 0)
            yield* Deferred.await(postAdmissionControl.release)
          }
          events.push("apply")
          yield* host.apply({
            publicationRevision: ResourceRevision.make(
              String(prepared.request.snapshot.source.revision),
            ),
            payload: prepared.request.snapshot,
            retireMode: "drain",
            resources: [resource],
            stage,
          })
        }).pipe(
          Effect.mapError((error) => {
            if (Schema.is(ResourceGraphApplyError)(error)) return error
            return new ResourceGraphApplyError({ phase: "apply", message: String(error) })
          }),
        )

      return ResourceGraphDesiredApplier.of({
        prepare: (request: ResourceGraphDesiredApplication) => {
          if (
            Predicate.isNotUndefined(failPrepareRevision) &&
            String(request.snapshot.source.revision) === failPrepareRevision
          ) {
            return Effect.fail(
              new ResourceGraphApplyError({ phase: "prepare", message: "prepare failed for test" }),
            )
          }
          return Effect.succeed({ request })
        },
        validate: (prepared) => {
          if (prepared.request.snapshot.descriptors[0]?.id === RESOURCE_ID) return Effect.void
          return Effect.fail(
            new ResourceGraphApplyError({ phase: "validate", message: "unexpected resource" }),
          )
        },
        applyDesired: apply,
      })
    }),
  )

const makeActorLayer = (
  events: Array<string>,
  failApply = false,
  control?: AdmissionControl,
  postAdmissionControl?: AdmissionControl,
  failPrepareRevision?: string,
) => {
  const dependencies = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    Layer.provide(
      makeHostApplierLayer(events, control, failApply, postAdmissionControl, failPrepareRevision),
      GentPlatform.Test("graph-host"),
    ),
  )
  return Layer.merge(ResourceGraphActorTest.pipe(Layer.provide(dependencies)), dependencies)
}

const makeActorLayerAfterAdmission = (
  events: Array<string>,
  control: AdmissionControl,
  failPrepareRevision: string,
) =>
  // oxlint-disable-next-line effect/noNullish -- This test leaves the pre-admission gate unset.
  makeActorLayer(events, false, undefined, control, failPrepareRevision)

const makeDispatchLayer = (
  onDesired: (receipt: ResourceGraphDesiredReceipt) => Effect.Effect<void, PersistenceError>,
  onRecovery: (request: ResourceGraphRecoveryPayload) => Effect.Effect<void, PersistenceError>,
) =>
  Layer.succeed(ResourceGraphDispatch, {
    sendDesired: onDesired,
    sendRecovery: onRecovery,
    sendRecoveryAndAwait: (request) =>
      onRecovery(request).pipe(
        Effect.mapError(
          (cause) =>
            new StorageError({
              message: `test recovery failed: ${String(cause)}`,
              cause,
            }),
        ),
      ),
  } satisfies ResourceGraphDispatchService)

const makeCommandServiceLayer = (dispatch: Layer.Layer<ResourceGraphDispatch>) => {
  const storage = SqliteStorage.TestWithSql()
  const client = Layer.provide(
    ClientLayer.fromConfig,
    Layer.merge(storage, ShardingConfig.layerDefaults),
  )
  return Layer.merge(
    ResourceGraphCommandService.Live.pipe(
      Layer.provide(Layer.mergeAll(storage, client, dispatch, GentPlatform.Test("graph-command"))),
    ),
    storage,
  )
}

describe("resource graph command owner", () => {
  it.live("records and dispatches without waiting for live application", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<ResourceGraphDesiredReceipt>>([])
      const dispatch = makeDispatchLayer(
        (receipt) => Ref.update(dispatched, (values) => [...values, receipt]),
        () => Effect.void,
      )
      const layer = makeCommandServiceLayer(dispatch)
      yield* Effect.gen(function* () {
        const commands = yield* ResourceGraphCommandService
        const storage = yield* ResourceGraphStorage
        const command = makeCommand("command-submit", "graph/1")
        const receipt = yield* commands.submit(command)
        expect(receipt.desiredSequence).toBe(1)
        expect(yield* Ref.get(dispatched)).toEqual([receipt])
        expect((yield* storage.get({ workspaceId: WORKSPACE_A, cwd: CWD_A }))?.state).toBe(
          "pending",
        )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes a dynamic layer from test-local state.
      }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.live("persists the Encore dispatch in the same SQLite message store", () =>
    Effect.gen(function* () {
      const storage = SqliteStorage.TestWithSql()
      const client = Layer.provide(
        ClientLayer.fromConfig,
        Layer.merge(storage, ShardingConfig.layerDefaults),
      )
      const dispatch = ResourceGraphDispatch.Live.pipe(Layer.provide(client))
      const layer = Layer.merge(
        ResourceGraphCommandService.Live.pipe(
          Layer.provide(
            Layer.mergeAll(storage, client, dispatch, GentPlatform.Test("graph-outbox")),
          ),
        ),
        storage,
      )
      yield* Effect.gen(function* () {
        const commands = yield* ResourceGraphCommandService
        const sql = yield* SqlClient.SqlClient
        const command = makeCommand("command-outbox", "graph/1")
        yield* commands.submit(command)
        const first = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM cluster_messages
        `
        yield* commands.submit(command)
        const second = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM cluster_messages
        `
        expect(first[0]?.count).toBe(1)
        expect(second[0]?.count).toBe(1)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes a dynamic layer from test-local state.
      }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.live("rolls back desired state when durable dispatch fails", () =>
    Effect.gen(function* () {
      const dispatch = makeDispatchLayer(
        () =>
          PersistenceError.refail(
            Effect.fail(
              new ResourceGraphCommandError({ phase: "storage", message: "dispatch failed" }),
            ),
          ),
        () => Effect.void,
      )
      const layer = makeCommandServiceLayer(dispatch)
      yield* Effect.gen(function* () {
        const commands = yield* ResourceGraphCommandService
        const storage = yield* ResourceGraphStorage
        const result = yield* commands
          .submit(makeCommand("command-rollback", "graph/1"))
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* storage.get({ workspaceId: WORKSPACE_A, cwd: CWD_A })).toBeUndefined()
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes a dynamic layer from test-local state.
      }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.live("recovery dispatch uses a fresh key for an applied durable owner", () =>
    Effect.gen(function* () {
      const recovered = yield* Ref.make<ReadonlyArray<ResourceGraphRecoveryPayload>>([])
      const dispatch = makeDispatchLayer(
        () => Effect.void,
        (request) => Ref.update(recovered, (values) => [...values, request]),
      )
      const layer = makeCommandServiceLayer(dispatch)
      yield* Effect.gen(function* () {
        const commands = yield* ResourceGraphCommandService
        const storage = yield* ResourceGraphStorage
        const receipt = yield* storage.recordDesired(makeCommand("command-recover", "graph/1"))
        yield* storage.recordApplied(receipt)
        const first = yield* commands.recover(WORKSPACE_A)
        const second = yield* commands.recover(WORKSPACE_A)
        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(first[0]?.recoveryId).not.toBe(second[0]?.recoveryId)
        expect((yield* storage.get({ workspaceId: WORKSPACE_A, cwd: CWD_A }))?.state).toBe(
          "applied",
        )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes a dynamic layer from test-local state.
      }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
      expect(yield* Ref.get(recovered)).toHaveLength(2)
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.live("startup recovery waits for each persisted owner", () =>
    Effect.gen(function* () {
      const recovered = yield* Ref.make<ReadonlyArray<ResourceGraphRecoveryPayload>>([])
      const dispatch = makeDispatchLayer(
        () => Effect.void,
        (request) => Ref.update(recovered, (values) => [...values, request]),
      )
      const layer = makeCommandServiceLayer(dispatch)
      yield* Effect.gen(function* () {
        const commands = yield* ResourceGraphCommandService
        const storage = yield* ResourceGraphStorage
        const receipt = yield* storage.recordDesired(makeCommand("command-await", "graph/1"))
        yield* storage.recordApplied(receipt)
        const report = yield* commands.recoverAllAndAwaitReport
        expect(report.requests).toHaveLength(1)
        expect(yield* Ref.get(recovered)).toEqual(report.requests)
        const outcome = Option.fromUndefinedOr(report.outcomes[0])
        expect(Option.isSome(outcome)).toBe(true)
        if (Option.isNone(outcome)) return yield* Effect.die("expected recovery outcome")
        expect(outcome.value.applying).toBe(true)
        expect(outcome.value.settled).toBe(true)
        expect(Option.isSome(outcome.value.status)).toBe(true)
        if (Option.isNone(outcome.value.status)) return yield* Effect.die("expected status")
        expect(outcome.value.status.value.state).toBe("applying")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes a dynamic layer from test-local state.
      }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.live("keeps one recovery failure visible while another owner settles", () =>
    Effect.gen(function* () {
      const dispatch = makeDispatchLayer(
        () => Effect.void,
        (request) => {
          if (request.cwd === CWD_B) return Effect.void
          return PersistenceError.refail(
            Effect.fail(
              new ResourceGraphCommandError({
                phase: "load",
                message: "owner is unavailable",
              }),
            ),
          )
        },
      )
      const layer = makeCommandServiceLayer(dispatch)
      yield* Effect.gen(function* () {
        const commands = yield* ResourceGraphCommandService
        const storage = yield* ResourceGraphStorage
        const receipt = yield* storage.recordDesired(
          makeCommand("command-failed-recovery", "graph/1"),
        )
        yield* storage.recordApplied(receipt)
        const secondReceipt = yield* storage.recordDesired(
          ResourceGraphDesiredCommand.make({
            ...makeCommand("command-successful-recovery", "graph/2"),
            cwd: CWD_B,
          }),
        )
        yield* storage.recordApplied(secondReceipt)
        const report = yield* commands.recoverAllAndAwaitReport
        expect(report.requests).toHaveLength(2)
        const failed = Option.fromUndefinedOr(
          report.outcomes.find((outcome) => outcome.request.cwd === CWD_A),
        )
        const successful = Option.fromUndefinedOr(
          report.outcomes.find((outcome) => outcome.request.cwd === CWD_B),
        )
        expect(Option.isSome(failed)).toBe(true)
        expect(Option.isSome(successful)).toBe(true)
        if (Option.isNone(failed) || Option.isNone(successful)) {
          return yield* Effect.die("expected both recovery outcomes")
        }
        expect(failed.value.applying).toBe(true)
        expect(failed.value.settled).toBe(false)
        expect(Option.isSome(failed.value.status)).toBe(true)
        expect(Option.isSome(failed.value.error)).toBe(true)
        expect(successful.value.applying).toBe(true)
        expect(successful.value.settled).toBe(true)
        expect(Option.isSome(successful.value.status)).toBe(true)
        if (Option.isNone(failed.value.status) || Option.isNone(successful.value.status)) {
          return yield* Effect.die("expected recovery statuses")
        }
        expect(failed.value.status.value.state).toBe("applying")
        expect(successful.value.status.value.state).toBe("applying")
        const status = yield* storage.get({ workspaceId: WORKSPACE_A, cwd: CWD_A })
        expect(status?.state).toBe("applying")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes a dynamic layer from test-local state.
      }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.live("does not trust an old applied status when recovery marking fails", () =>
    Effect.gen(function* () {
      const key = { workspaceId: WORKSPACE_A, cwd: CWD_A }
      const command = makeCommand("command-applied-but-unavailable", "graph/1")
      const status = ResourceGraphStatus.make({
        ...key,
        commandId: command.commandId,
        desiredRevision: command.desiredRevision,
        desiredSequence: 1,
        snapshot: command.snapshot,
        appliedRevision: command.desiredRevision,
        appliedSequence: 1,
        state: "applied",
      })
      const fakeStorage = ResourceGraphStorage.of({
        recordDesired: () => Effect.die("unused"),
        recordApplying: () =>
          Effect.fail(new StorageError({ message: "database unavailable during recovery" })),
        admit: () => Effect.die("unused"),
        recordApplied: () => Effect.die("unused"),
        recordAppliedAdmission: () => Effect.die("unused"),
        discardAdmission: () => Effect.void,
        recordFailed: () => Effect.die("unused"),
        get: () => Effect.succeed(status),
        listPending: () => Effect.succeed([key]),
        listAll: () => Effect.succeed([key]),
        listWorkspaces: Effect.succeed([WORKSPACE_A]),
      })
      const backing = SqliteStorage.TestWithSql()
      const client = Layer.provide(
        ClientLayer.fromConfig,
        Layer.merge(backing, ShardingConfig.layerDefaults),
      )
      const dispatch = makeDispatchLayer(
        () => Effect.void,
        () =>
          PersistenceError.refail(
            Effect.fail(
              new ResourceGraphCommandError({
                phase: "load",
                message: "owner is unavailable",
              }),
            ),
          ),
      )
      const layer = Layer.merge(
        ResourceGraphCommandService.Live.pipe(
          Layer.provide(
            Layer.mergeAll(
              backing,
              Layer.succeed(ResourceGraphStorage, fakeStorage),
              client,
              dispatch,
              GentPlatform.Test("graph-command"),
            ),
          ),
        ),
        Layer.succeed(ResourceGraphStorage, fakeStorage),
      )
      yield* Effect.gen(function* () {
        const commands = yield* ResourceGraphCommandService
        const report = yield* commands.recoverAllAndAwaitReport
        expect(report.outcomes).toHaveLength(1)
        const outcome = Option.fromUndefinedOr(report.outcomes[0])
        expect(Option.isSome(outcome)).toBe(true)
        if (Option.isNone(outcome)) return yield* Effect.die("expected recovery outcome")
        expect(outcome.value.applying).toBe(false)
        expect(outcome.value.settled).toBe(false)
        expect(Option.isSome(outcome.value.status)).toBe(true)
        expect(Option.isSome(outcome.value.error)).toBe(true)
        if (Option.isNone(outcome.value.status)) return yield* Effect.die("expected status")
        expect(outcome.value.status.value.state).toBe("applied")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes a failure-injected storage layer.
      }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.live("rejects a superseded command before live mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        const layer = makeActorLayer(events)
        yield* Effect.gen(function* () {
          const storage = yield* ResourceGraphStorage
          const first = yield* storage.recordDesired(makeCommand("command-a", "graph/a"))
          const second = yield* storage.recordDesired(
            ResourceGraphDesiredCommand.make({
              ...makeCommand("command-b", "graph/b"),
              expectedRevision: first.desiredRevision,
            }),
          )
          const factory = yield* ResourceGraph.Context
          const ref = yield* factory(resourceGraphEntityId(WORKSPACE_A, CWD_A))
          const stale = yield* ref.execute(ResourceGraph.ApplyDesired.make(first)).pipe(Effect.exit)
          expect(Exit.isFailure(stale)).toBe(true)
          expect(events).not.toContain("apply")
          yield* ref.execute(ResourceGraph.ApplyDesired.make(second))
          expect(events).toContain("apply")
          expect((yield* storage.get({ workspaceId: WORKSPACE_A, cwd: CWD_A }))?.state).toBe(
            "applied",
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes a dynamic layer from test-local state.
        }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("does not mutate after desired state changes before host admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const events: Array<string> = []
        const layer = makeActorLayer(events, false, { entered, release })
        yield* Effect.gen(function* () {
          const storage = yield* ResourceGraphStorage
          const first = yield* storage.recordDesired(makeCommand("command-race-a", "graph/a"))
          const factory = yield* ResourceGraph.Context
          const ref = yield* factory(resourceGraphEntityId(WORKSPACE_A, CWD_A))
          const running = yield* Effect.forkChild(
            ref.execute(ResourceGraph.ApplyDesired.make(first)),
          )
          yield* Deferred.await(entered)
          yield* storage.recordDesired(
            ResourceGraphDesiredCommand.make({
              ...makeCommand("command-race-b", "graph/b"),
              expectedRevision: first.desiredRevision,
            }),
          )
          yield* Deferred.succeed(release, void 0)
          const result = yield* Fiber.join(running).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          expect(events).not.toContain("apply")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes a dynamic layer from test-local state.
        }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("keeps an admitted application when a newer desired graph fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const events: Array<string> = []
        const layer = makeActorLayerAfterAdmission(events, { entered, release }, "source/b")
        yield* Effect.gen(function* () {
          const storage = yield* ResourceGraphStorage
          const first = yield* storage.recordDesired(
            makeCommand("command-admitted-a", "graph/a", makeSnapshot("source/a")),
          )
          const factory = yield* ResourceGraph.Context
          const ref = yield* factory(resourceGraphEntityId(WORKSPACE_A, CWD_A))
          const running = yield* Effect.forkChild(
            ref.execute(ResourceGraph.ApplyDesired.make(first)),
          )
          yield* Deferred.await(entered)
          const second = yield* storage.recordDesired(
            ResourceGraphDesiredCommand.make({
              ...makeCommand("command-admitted-b", "graph/b", makeSnapshot("source/b")),
              expectedRevision: first.desiredRevision,
            }),
          )
          yield* Deferred.succeed(release, void 0)
          const firstResult = yield* Fiber.join(running).pipe(Effect.exit)
          expect(Exit.isSuccess(firstResult)).toBe(true)
          const afterFirst = yield* storage.get({ workspaceId: WORKSPACE_A, cwd: CWD_A })
          if (Predicate.isUndefined(afterFirst)) {
            return yield* Effect.die("Expected the graph status after admitted application")
          }
          expect(afterFirst.desiredRevision).toBe(second.desiredRevision)
          expect(afterFirst.state).toBe("pending")
          expect(afterFirst.appliedRevision).toBe(first.desiredRevision)
          expect(afterFirst.appliedSequence).toBe(first.desiredSequence)

          const secondResult = yield* ref
            .execute(ResourceGraph.ApplyDesired.make(second))
            .pipe(Effect.exit)
          expect(Exit.isFailure(secondResult)).toBe(true)
          const final = yield* storage.get({ workspaceId: WORKSPACE_A, cwd: CWD_A })
          if (Predicate.isUndefined(final)) {
            return yield* Effect.die("Expected the final graph status")
          }
          expect(final.state).toBe("failed")
          expect(final.failure?.message).toContain("prepare failed")
          expect(final.appliedRevision).toBe(first.desiredRevision)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes a dynamic layer from test-local state.
        }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("reacquires an already-applied desired graph on recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        const layer = makeActorLayer(events)
        yield* Effect.gen(function* () {
          const storage = yield* ResourceGraphStorage
          const receipt = yield* storage.recordDesired(
            makeCommand("command-recovery-apply", "graph/recovery"),
          )
          yield* storage.recordApplied(receipt)
          const factory = yield* ResourceGraph.Context
          const ref = yield* factory(resourceGraphEntityId(WORKSPACE_A, CWD_A))
          yield* ref.execute(
            ResourceGraph.RecoverDesired.make(
              ResourceGraphRecoveryPayload.make({
                ...receipt,
                recoveryId: RequestId.make("recovery-apply"),
              }),
            ),
          )
          const status = yield* storage.get({ workspaceId: WORKSPACE_A, cwd: CWD_A })
          expect(status?.state).toBe("applied")
          expect(status?.appliedSequence).toBe(receipt.desiredSequence)
          expect(events).toContain("apply")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes a dynamic layer from test-local state.
        }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("records a failed application without losing the durable desired row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        const layer = makeActorLayer(events, true)
        yield* Effect.gen(function* () {
          const storage = yield* ResourceGraphStorage
          const receipt = yield* storage.recordDesired(makeCommand("command-failure", "graph/1"))
          const factory = yield* ResourceGraph.Context
          const ref = yield* factory(resourceGraphEntityId(WORKSPACE_A, CWD_A))
          const result = yield* ref
            .execute(ResourceGraph.ApplyDesired.make(receipt))
            .pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          const status = yield* storage.get({ workspaceId: WORKSPACE_A, cwd: CWD_A })
          expect(status?.state).toBe("failed")
          expect(status?.failure?.message).toContain("boom")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes a dynamic layer from test-local state.
        }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A), Effect.provide(layer))
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )
})
