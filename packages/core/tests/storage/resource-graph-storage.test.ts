import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect"
import { canonicalJsonString } from "effect-encore"
import { SqlClient } from "effect/unstable/sql"
import {
  ResourceDescriptor,
  ResourceId,
  ResourceRevision,
} from "@gent/core-internal/domain/resource-graph"
import {
  CanonicalCwd,
  ResourceGraphCommandConflictError,
  ResourceGraphDesiredCommand,
  ResourceGraphExpectedRevisionError,
  ResourceGraphRevision,
  ResourceGraphSource,
  ResourceGraphSnapshot,
  ResourceGraphStaleReceiptError,
  type ResourceGraphExtensionSource,
} from "@gent/core-internal/domain/resource-graph-state"
import { RequestId, ExtensionId } from "@gent/core-internal/domain/ids"
import { StorageError } from "@gent/core-internal/domain/storage-error"
import { CurrentWorkspaceId, WorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import { ResourceGraphStorage } from "@gent/core-internal/storage/resource-graph-storage"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { toSqlNull } from "@gent/core-internal/storage/sqlite/rows"

const WORKSPACE_A = WorkspaceId.make("a".repeat(64))
const WORKSPACE_B = WorkspaceId.make("b".repeat(64))
const CWD_A = CanonicalCwd.make("/tmp/resource-graph-a")
const CWD_B = CanonicalCwd.make("/tmp/resource-graph-b")

const makeDescriptor = (id: string, revision = "resource/1") =>
  ResourceDescriptor.make({
    id: ResourceId.make(id),
    revision: ResourceRevision.make(revision),
    requires: [],
    required: false,
  })

const makeSource = (revision = "source/1", reverse = false) => {
  const first = {
    extensionId: ExtensionId.make("@test/first"),
    scope: "builtin",
    source: "artifact-first",
  } satisfies ResourceGraphExtensionSource
  const second = {
    extensionId: ExtensionId.make("@test/second"),
    scope: "project",
    source: "artifact-second",
  } satisfies ResourceGraphExtensionSource
  let extensions: ReadonlyArray<ResourceGraphExtensionSource> = [first, second]
  if (reverse) extensions = [second, first]
  return ResourceGraphSource.make({
    revision: ResourceGraphRevision.make(revision),
    config: { enabled: true, nested: { value: 1 } },
    extensions,
  })
}

const makeSnapshot = (revision = "source/1", reverse = false) =>
  ResourceGraphSnapshot.make({
    source: makeSource(revision, reverse),
    descriptors: [makeDescriptor("@test/resource")],
  })

const makeCommand = (params: {
  readonly commandId: string
  readonly desiredRevision: string
  readonly expectedRevision?: ResourceGraphRevision
  readonly workspaceId?: WorkspaceId
  readonly cwd?: CanonicalCwd
  readonly sourceRevision?: string
  readonly reverseSourceOrder?: boolean
}) => {
  const workspaceId = Option.fromUndefinedOr(params.workspaceId).pipe(
    Option.getOrElse(() => WORKSPACE_A),
  )
  const cwd = Option.fromUndefinedOr(params.cwd).pipe(Option.getOrElse(() => CWD_A))
  const sourceRevision = Option.fromUndefinedOr(params.sourceRevision).pipe(
    Option.getOrElse(() => "source/1"),
  )
  const reverseSourceOrder = Option.fromUndefinedOr(params.reverseSourceOrder).pipe(
    Option.getOrElse(() => false),
  )
  const base = {
    workspaceId,
    cwd,
    commandId: RequestId.make(params.commandId),
    desiredRevision: ResourceGraphRevision.make(params.desiredRevision),
    snapshot: makeSnapshot(sourceRevision, reverseSourceOrder),
  }
  if (Predicate.isUndefined(params.expectedRevision)) return ResourceGraphDesiredCommand.make(base)
  return ResourceGraphDesiredCommand.make({ ...base, expectedRevision: params.expectedRevision })
}

const keyFor = (workspaceId = WORKSPACE_A, cwd = CWD_A) => ({ workspaceId, cwd })

const withStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(SqliteStorage.TestWithSql()),
    Effect.provideService(CurrentWorkspaceId, WORKSPACE_A),
  )

const expectFailure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isFailure(exit)) return Effect.succeed(Cause.squash(exit.cause))
  return Effect.die("Expected the effect to fail")
}

describe("ResourceGraphStorage", () => {
  it.live("persists a desired snapshot and lists it for restart recovery", () =>
    Effect.gen(function* () {
      const storage = yield* ResourceGraphStorage
      const command = makeCommand({ commandId: "graph-round-trip", desiredRevision: "graph/1" })
      const receipt = yield* storage.recordDesired(command)

      expect(receipt.desiredSequence).toBe(1)
      expect(receipt.desiredRevision).toBe(command.desiredRevision)
      expect(yield* storage.listPending(WORKSPACE_A)).toEqual([keyFor()])
      expect(yield* storage.listAll(WORKSPACE_A)).toEqual([keyFor()])

      const status = yield* storage.get(keyFor())
      if (Predicate.isUndefined(status)) return yield* Effect.die("Expected the graph status")
      expect(status.desiredRevision).toBe(command.desiredRevision)
      expect(status.desiredSequence).toBe(1)
      expect(status.snapshot.source.extensions.map((entry) => String(entry.extensionId))).toEqual([
        "@test/first",
        "@test/second",
      ])
      expect(status.appliedRevision).toBeUndefined()
    }).pipe(withStorage),
  )

  it.live("deduplicates equal commands and keeps the original receipt after supersession", () =>
    Effect.gen(function* () {
      const storage = yield* ResourceGraphStorage
      const first = makeCommand({ commandId: "graph-command-a", desiredRevision: "graph/a" })
      const firstReceipt = yield* storage.recordDesired(first)
      const second = makeCommand({
        commandId: "graph-command-b",
        desiredRevision: "graph/b",
        expectedRevision: firstReceipt.desiredRevision,
      })
      const secondReceipt = yield* storage.recordDesired(second)
      const retriedFirst = yield* storage.recordDesired(first)

      expect(retriedFirst).toEqual(firstReceipt)
      expect(secondReceipt.desiredSequence).toBe(2)

      const conflict = ResourceGraphDesiredCommand.make({
        ...first,
        desiredRevision: ResourceGraphRevision.make("graph/a-conflict"),
      })
      const conflictExit = yield* storage.recordDesired(conflict).pipe(Effect.exit)
      const conflictError = yield* expectFailure(conflictExit)
      expect(Schema.is(ResourceGraphCommandConflictError)(conflictError)).toBe(true)

      const status = yield* storage.get(keyFor())
      if (Predicate.isUndefined(status)) return yield* Effect.die("Expected the graph status")
      expect(status.desiredRevision).toBe(second.desiredRevision)
      expect(status.desiredSequence).toBe(2)
    }).pipe(withStorage),
  )

  it.live("deduplicates omitted and explicit undefined optional metadata", () =>
    Effect.gen(function* () {
      const storage = yield* ResourceGraphStorage
      const first = makeCommand({
        commandId: "graph-optional-undefined",
        desiredRevision: "graph/optional-undefined",
      })
      const explicitUndefined = ResourceGraphDesiredCommand.make({
        ...first,
        // oxlint-disable-next-line effect/noNullish -- Schema.optional accepts explicit undefined.
        expectedRevision: undefined,
        snapshot: ResourceGraphSnapshot.make({
          ...first.snapshot,
          source: ResourceGraphSource.make({
            ...first.snapshot.source,
            extensions: first.snapshot.source.extensions.map((source) => ({
              ...source,
              // oxlint-disable-next-line effect/noNullish -- Schema.optional accepts explicit undefined.
              version: undefined,
            })),
          }),
        }),
      })

      const firstReceipt = yield* storage.recordDesired(first)
      const retryReceipt = yield* storage.recordDesired(explicitUndefined)

      expect(retryReceipt).toEqual(firstReceipt)
      const status = yield* storage.get(keyFor())
      if (Predicate.isUndefined(status)) return yield* Effect.die("Expected the graph status")
      expect(status.desiredRevision).toBe(first.desiredRevision)
      expect(status.snapshot.source.extensions.every((source) => !("version" in source))).toBe(true)
    }).pipe(withStorage),
  )

  it.live("treats an absent expected revision as create-only", () =>
    Effect.gen(function* () {
      const storage = yield* ResourceGraphStorage
      const first = makeCommand({ commandId: "graph-create", desiredRevision: "graph/1" })
      yield* storage.recordDesired(first)

      const overwrite = makeCommand({ commandId: "graph-overwrite", desiredRevision: "graph/2" })
      const overwriteExit = yield* storage.recordDesired(overwrite).pipe(Effect.exit)
      expect(
        Schema.is(ResourceGraphExpectedRevisionError)(yield* expectFailure(overwriteExit)),
      ).toBe(true)

      const status = yield* storage.get(keyFor())
      if (Predicate.isUndefined(status)) return yield* Effect.die("Expected the graph status")
      expect(status.desiredRevision).toBe(first.desiredRevision)
      expect(status.desiredSequence).toBe(1)

      const expectedOnCreate = makeCommand({
        commandId: "graph-invalid-create",
        desiredRevision: "graph/new-owner",
        cwd: CWD_B,
        expectedRevision: ResourceGraphRevision.make("graph/missing"),
      })
      const createExit = yield* storage.recordDesired(expectedOnCreate).pipe(Effect.exit)
      expect(Schema.is(ResourceGraphExpectedRevisionError)(yield* expectFailure(createExit))).toBe(
        true,
      )
      expect(yield* storage.get(keyFor(WORKSPACE_A, CWD_B))).toBeUndefined()
    }).pipe(withStorage),
  )

  it.live("allows only one concurrent revision for one expected predecessor", () =>
    Effect.gen(function* () {
      const storage = yield* ResourceGraphStorage
      const first = makeCommand({ commandId: "graph-race-a", desiredRevision: "graph/race-a" })
      const firstReceipt = yield* storage.recordDesired(first)
      const second = makeCommand({
        commandId: "graph-race-b",
        desiredRevision: "graph/race-b",
        expectedRevision: firstReceipt.desiredRevision,
      })
      const third = makeCommand({
        commandId: "graph-race-c",
        desiredRevision: "graph/race-c",
        expectedRevision: firstReceipt.desiredRevision,
      })
      const exits = yield* Effect.all(
        [Effect.exit(storage.recordDesired(second)), Effect.exit(storage.recordDesired(third))],
        { concurrency: 2 },
      )
      const successes = exits.filter(Exit.isSuccess)
      const failures = exits.filter(Exit.isFailure)
      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(1)
      const failure = failures[0]
      if (Predicate.isUndefined(failure)) return yield* Effect.die("Expected one failed revision")
      expect(Schema.is(ResourceGraphExpectedRevisionError)(yield* expectFailure(failure))).toBe(
        true,
      )
      const success = successes[0]
      if (Predicate.isUndefined(success)) return yield* Effect.die("Expected one winning revision")
      if (Exit.isFailure(success)) return yield* Effect.die("Expected a successful revision")
      expect(success.value.desiredSequence).toBe(2)

      const status = yield* storage.get(keyFor())
      if (Predicate.isUndefined(status)) return yield* Effect.die("Expected the graph status")
      expect(status.desiredSequence).toBe(2)
      expect([second.desiredRevision, third.desiredRevision]).toContain(status.desiredRevision)
    }).pipe(withStorage),
  )

  it.live("rejects late receipts and preserves the last successful application on failure", () =>
    Effect.gen(function* () {
      const storage = yield* ResourceGraphStorage
      const first = makeCommand({ commandId: "graph-apply-a", desiredRevision: "graph/apply-a" })
      const firstReceipt = yield* storage.recordDesired(first)
      const applied = yield* storage.recordApplied(firstReceipt)
      expect(applied.state).toBe("applied")
      expect(applied.appliedRevision).toBe(firstReceipt.desiredRevision)
      expect(yield* storage.listPending(WORKSPACE_A)).toEqual([])
      expect(yield* storage.listAll(WORKSPACE_A)).toEqual([keyFor()])

      const second = makeCommand({
        commandId: "graph-apply-b",
        desiredRevision: "graph/apply-b",
        expectedRevision: firstReceipt.desiredRevision,
      })
      const secondReceipt = yield* storage.recordDesired(second)
      expect(yield* storage.listPending(WORKSPACE_A)).toEqual([keyFor()])

      const lateExit = yield* storage.recordApplied(firstReceipt).pipe(Effect.exit)
      expect(Schema.is(ResourceGraphStaleReceiptError)(yield* expectFailure(lateExit))).toBe(true)

      yield* storage.recordApplying(secondReceipt)
      const failed = yield* storage.recordFailed({
        ...secondReceipt,
        failure: { message: "test failure" },
      })
      expect(failed.state).toBe("failed")
      expect(failed.failure?.message).toBe("test failure")
      expect(failed.appliedRevision).toBe(firstReceipt.desiredRevision)
      expect(failed.appliedSequence).toBe(firstReceipt.desiredSequence)

      const appliedAgain = yield* storage.recordApplied(secondReceipt)
      expect(appliedAgain.state).toBe("applied")
      expect(appliedAgain.appliedRevision).toBe(secondReceipt.desiredRevision)
      expect(yield* storage.listPending(WORKSPACE_A)).toEqual([])
      expect(yield* storage.listAll(WORKSPACE_A)).toEqual([keyFor()])
    }).pipe(withStorage),
  )

  it.live("keeps declaration order in the durable source identity", () =>
    Effect.gen(function* () {
      const storage = yield* ResourceGraphStorage
      const first = makeCommand({
        commandId: "graph-order",
        desiredRevision: "graph/order",
        reverseSourceOrder: false,
      })
      yield* storage.recordDesired(first)
      const reordered = makeCommand({
        commandId: "graph-order",
        desiredRevision: "graph/order",
        reverseSourceOrder: true,
      })
      const conflictExit = yield* storage.recordDesired(reordered).pipe(Effect.exit)
      expect(Schema.is(ResourceGraphCommandConflictError)(yield* expectFailure(conflictExit))).toBe(
        true,
      )
    }).pipe(withStorage),
  )

  it.live("isolates workspace owners and rejects cross-workspace writes", () =>
    Effect.gen(function* () {
      const storage = yield* ResourceGraphStorage
      const first = makeCommand({ commandId: "graph-workspace-a", desiredRevision: "graph/a" })
      yield* storage.recordDesired(first)

      const crossRead = yield* storage
        .get(keyFor(WORKSPACE_A))
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_B))
      expect(crossRead).toBeUndefined()

      const crossWrite = yield* storage
        .recordDesired(
          makeCommand({
            commandId: "graph-cross-write",
            desiredRevision: "graph/cross",
            workspaceId: WORKSPACE_A,
            cwd: CWD_B,
          }),
        )
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_B), Effect.exit)
      expect(Schema.is(StorageError)(yield* expectFailure(crossWrite))).toBe(true)

      const secondWorkspace = makeCommand({
        commandId: "graph-workspace-b",
        desiredRevision: "graph/b",
        workspaceId: WORKSPACE_B,
        cwd: CWD_A,
      })
      yield* storage
        .recordDesired(secondWorkspace)
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_B))

      expect(yield* storage.get(keyFor(WORKSPACE_A))).toBeDefined()
      const workspaceBStatus = yield* storage
        .get(keyFor(WORKSPACE_B, CWD_A))
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_B))
      expect(workspaceBStatus?.desiredRevision).toBe(secondWorkspace.desiredRevision)
    }).pipe(withStorage),
  )

  it.live("returns a storage error for malformed persisted JSON", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const storage = yield* ResourceGraphStorage
      yield* sql`
          INSERT INTO resource_graph_state (
            workspace_id, cwd, desired_revision, desired_sequence, desired_json,
            applied_revision, applied_sequence, state, failure_json, command_id, updated_at
          ) VALUES (
            ${WORKSPACE_A}, ${CWD_A}, ${"graph/malformed"}, ${1}, ${'{"invalid":true}'},
            ${toSqlNull()}, ${toSqlNull()}, ${"pending"}, ${toSqlNull()}, ${"graph-malformed"}, ${1}
          )
        `
      const loaded = yield* storage.get(keyFor()).pipe(Effect.exit)
      expect(Schema.is(StorageError)(yield* expectFailure(loaded))).toBe(true)

      yield* sql`
          INSERT INTO resource_graph_state (
            workspace_id, cwd, desired_revision, desired_sequence, desired_json,
            applied_revision, applied_sequence, state, failure_json, command_id, updated_at
          ) VALUES (
            ${WORKSPACE_A}, ${CWD_B}, ${"graph/malformed-sequence"}, ${1.5},
            ${canonicalJsonString(makeSnapshot("source/malformed-sequence"))},
            ${toSqlNull()}, ${toSqlNull()}, ${"pending"}, ${toSqlNull()},
            ${"graph-malformed-sequence"}, ${1}
          )
        `
      const malformedSequence = yield* storage.get(keyFor(WORKSPACE_A, CWD_B)).pipe(Effect.exit)
      expect(Schema.is(StorageError)(yield* expectFailure(malformedSequence))).toBe(true)
    }).pipe(withStorage),
  )

  it.live("rolls back a desired write inside an outer transaction", () =>
    Effect.gen(function* () {
      const storage = yield* ResourceGraphStorage
      const sql = yield* SqlClient.SqlClient
      const command = makeCommand({
        commandId: "graph-rollback",
        desiredRevision: "graph/rollback",
      })
      const rolledBack = yield* Effect.gen(function* () {
        yield* storage.recordDesired(command)
        return yield* new StorageError({ message: "abort outer transaction" })
      }).pipe(sql.withTransaction, Effect.exit)
      expect(Schema.is(StorageError)(yield* expectFailure(rolledBack))).toBe(true)
      expect(yield* storage.get(keyFor())).toBeUndefined()

      const rows = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count
          FROM resource_graph_commands
        `
      expect(rows[0]?.count).toBe(0)
    }).pipe(withStorage),
  )
})
