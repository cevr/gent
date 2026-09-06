import { describe, expect, it } from "effect-bun-test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Cause, Effect, Exit, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Branch, dateFromMillis, Message, Session } from "@gent/core-internal/domain/message"
import {
  ToolBindingSource,
  ToolCallBindingConflictError,
  ToolSchemaRevision,
  ToolSourceRevision,
  makeToolBindingIdentity,
} from "@gent/core-internal/domain/tool-binding"
import {
  BranchId,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
  ToolId,
} from "@gent/core-internal/domain/ids"
import { ResourceId, ResourceRevision } from "@gent/core-internal/domain/resource-graph"
import { StorageError } from "@gent/core-internal/domain/storage-error"
import {
  CurrentWorkspaceId,
  DefaultWorkspaceId,
  WorkspaceId,
} from "@gent/core-internal/server/workspace-rpc"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { ToolCallBindingStorage } from "@gent/core-internal/storage/tool-call-binding-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"

const FIXED_NOW = dateFromMillis(1_767_225_600_000)
const WORKSPACE_A = WorkspaceId.make("a".repeat(64))
const WORKSPACE_B = WorkspaceId.make("b".repeat(64))

const makeBinding = (schemaRevision = "schema/1") =>
  makeToolBindingIdentity({
    toolId: ToolId.make("@test/tool"),
    extensionId: ExtensionId.make("@test/extension"),
    source: ToolBindingSource.cases.Static.make({
      sourceRevision: ToolSourceRevision.make("source/1"),
    }),
    schemaRevision: ToolSchemaRevision.make(schemaRevision),
    resources: [
      {
        id: ResourceId.make("@test/z-resource"),
        revision: ResourceRevision.make("resource/1"),
      },
      {
        id: ResourceId.make("@test/a-resource"),
        revision: ResourceRevision.make("resource/1"),
      },
    ],
  })

const makeFixture = (suffix: string, workspaceId: WorkspaceId = DefaultWorkspaceId) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStorage
    const branches = yield* BranchStorage
    const messages = yield* MessageStorage
    const sessionId = SessionId.make(`binding-session-${suffix}`)
    const branchId = BranchId.make(`binding-branch-${suffix}`)
    const messageId = MessageId.make(`binding-message-${suffix}`)

    yield* sessions.createSession(
      new Session({
        id: sessionId,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }),
    )
    yield* branches.createBranch(
      new Branch({
        id: branchId,
        sessionId,
        createdAt: FIXED_NOW,
      }),
    )
    const message = Message.cases.regular.make({
      id: messageId,
      sessionId,
      branchId,
      role: "assistant",
      parts: [
        Prompt.toolCallPart({
          id: ToolCallId.make(`binding-call-${suffix}`),
          name: "@test/tool",
          params: {},
          providerExecuted: false,
        }),
      ],
      createdAt: FIXED_NOW,
    })
    yield* messages.createMessage(message)
    return { sessionId, branchId, messageId, toolCallId: ToolCallId.make(`binding-call-${suffix}`) }
  }).pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))

const saveParams = (
  fixture: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly messageId: MessageId
    readonly toolCallId: ToolCallId
  },
  binding = makeBinding(),
) => ({
  assistantMessageId: fixture.messageId,
  toolCallId: fixture.toolCallId,
  sessionId: fixture.sessionId,
  branchId: fixture.branchId,
  binding,
  createdAt: FIXED_NOW.getTime(),
})

const getParams = (fixture: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
  readonly toolCallId: ToolCallId
}) => ({
  assistantMessageId: fixture.messageId,
  toolCallId: fixture.toolCallId,
  sessionId: fixture.sessionId,
  branchId: fixture.branchId,
})

describe("ToolCallBindingStorage", () => {
  it.live("round-trips a canonical JSON-safe binding identity", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("round-trip")
      const storage = yield* ToolCallBindingStorage
      const binding = makeBinding()

      const saved = yield* storage.save(saveParams(fixture, binding))
      const loaded = yield* storage.get(getParams(fixture))

      expect(saved).toEqual(binding)
      expect(loaded).toEqual(binding)
      expect(loaded?.resources.map((resource) => String(resource.id))).toEqual([
        "@test/a-resource",
        "@test/z-resource",
      ])
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )

  it.live("accepts an equal duplicate without changing the immutable row", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("equal-duplicate")
      const storage = yield* ToolCallBindingStorage
      const first = makeBinding()
      const second = makeBinding()

      yield* storage.save(saveParams(fixture, first))
      const duplicate = yield* storage.save(saveParams(fixture, second))

      expect(duplicate).toEqual(first)
      expect(yield* storage.get(getParams(fixture))).toEqual(first)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )

  it.live("rejects a conflicting duplicate without overwriting the row", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("conflict")
      const storage = yield* ToolCallBindingStorage
      const first = makeBinding()
      yield* storage.save(saveParams(fixture, first))

      const conflict = yield* storage
        .save(saveParams(fixture, makeBinding("schema/2")))
        .pipe(Effect.exit)
      expect(Exit.isFailure(conflict)).toBe(true)
      if (Exit.isFailure(conflict)) {
        expect(Schema.is(ToolCallBindingConflictError)(Cause.squash(conflict.cause))).toBe(true)
      }
      expect(yield* storage.get(getParams(fixture))).toEqual(first)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )

  it.live("requires the assistant message to contain the bound tool call", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("call-ownership")
      const storage = yield* ToolCallBindingStorage
      const missingCall = yield* storage
        .save(
          saveParams({
            ...fixture,
            toolCallId: ToolCallId.make("binding-call-missing"),
          }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(missingCall)).toBe(true)
      if (Exit.isFailure(missingCall)) {
        expect(Schema.is(StorageError)(Cause.squash(missingCall.cause))).toBe(true)
      }

      const binding = makeBinding()
      const mismatchedName = yield* storage
        .save(
          saveParams(
            fixture,
            makeToolBindingIdentity({
              ...binding,
              toolId: ToolId.make("@test/other-tool"),
            }),
          ),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(mismatchedName)).toBe(true)
      if (Exit.isFailure(mismatchedName)) {
        expect(Schema.is(StorageError)(Cause.squash(mismatchedName.cause))).toBe(true)
      }
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )

  it.live("rejects a non-canonical resource vector at the persistence boundary", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("invalid-resource-vector")
      const storage = yield* ToolCallBindingStorage
      const binding = makeBinding()
      const invalid = {
        ...binding,
        resources: [...binding.resources, ...binding.resources],
      }
      const result = yield* storage.save(saveParams(fixture, invalid)).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Schema.is(StorageError)(Cause.squash(result.cause))).toBe(true)
      }
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )

  it.live("rejects reads and writes outside the message workspace and branch", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("ownership", WORKSPACE_A)
      const storage = yield* ToolCallBindingStorage
      yield* storage
        .save(saveParams(fixture))
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A))

      const hiddenFromOtherWorkspace = yield* storage
        .get(getParams(fixture))
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_B))
      expect(hiddenFromOtherWorkspace).toBeUndefined()

      const hiddenWrite = yield* storage
        .save(saveParams(fixture, makeBinding("schema/hidden-workspace")))
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_B), Effect.exit)
      expect(Exit.isFailure(hiddenWrite)).toBe(true)
      if (Exit.isFailure(hiddenWrite)) {
        expect(Schema.is(StorageError)(Cause.squash(hiddenWrite.cause))).toBe(true)
      }

      const wrongSession = yield* storage
        .save(
          saveParams({
            ...fixture,
            sessionId: SessionId.make("binding-other-session"),
          }),
        )
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A))
        .pipe(Effect.exit)
      expect(Exit.isFailure(wrongSession)).toBe(true)
      if (Exit.isFailure(wrongSession)) {
        expect(Schema.is(StorageError)(Cause.squash(wrongSession.cause))).toBe(true)
      }

      const wrongBranch = yield* storage
        .save(
          saveParams({
            ...fixture,
            branchId: BranchId.make("binding-other-branch"),
          }),
        )
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A))
        .pipe(Effect.exit)
      expect(Exit.isFailure(wrongBranch)).toBe(true)
      if (Exit.isFailure(wrongBranch)) {
        expect(Schema.is(StorageError)(Cause.squash(wrongBranch.cause))).toBe(true)
      }

      const stillStored = yield* storage
        .get(getParams(fixture))
        .pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE_A))
      expect(stillStored).toEqual(makeBinding())
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )

  it.live("rolls back a message and its binding in one outer transaction", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const storage = yield* ToolCallBindingStorage
      const sql = yield* SqlClient.SqlClient
      const messageId = MessageId.make("binding-rollback-message")
      const toolCallId = ToolCallId.make("binding-rollback-call")
      const sessionId = SessionId.make("binding-session-rollback")
      const branchId = BranchId.make("binding-branch-rollback")

      yield* sessions.createSession(
        new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
      const message = Message.cases.regular.make({
        id: messageId,
        sessionId,
        branchId,
        role: "assistant",
        parts: [
          Prompt.toolCallPart({
            id: toolCallId,
            name: "@test/tool",
            params: {},
            providerExecuted: false,
          }),
        ],
        createdAt: FIXED_NOW,
      })

      const rolledBack = yield* Effect.gen(function* () {
        yield* messages.createMessage(message)
        yield* storage.save({
          assistantMessageId: messageId,
          toolCallId,
          sessionId,
          branchId,
          binding: makeBinding(),
          createdAt: FIXED_NOW.getTime(),
        })
        return yield* Effect.fail("rollback")
      }).pipe(sql.withTransaction, Effect.exit)
      expect(Exit.isFailure(rolledBack)).toBe(true)
      expect(yield* messages.getMessage(messageId)).toBeUndefined()
      expect(
        yield* storage.get({
          assistantMessageId: messageId,
          toolCallId,
          sessionId,
          branchId,
        }),
      ).toBeUndefined()
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )

  it.live("deletes bindings with their assistant message", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("cascade")
      const storage = yield* ToolCallBindingStorage
      const sql = yield* SqlClient.SqlClient
      yield* storage.save(saveParams(fixture))

      yield* sql`DELETE FROM messages WHERE id = ${fixture.messageId}`
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM tool_call_bindings
        WHERE assistant_message_id = ${fixture.messageId}
      `
      expect(rows[0]?.count).toBe(0)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )

  it.live("rejects malformed binding JSON at the read boundary", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("malformed")
      const sql = yield* SqlClient.SqlClient
      const storage = yield* ToolCallBindingStorage
      yield* sql`
        INSERT INTO tool_call_bindings (
          assistant_message_id,
          tool_call_id,
          binding_json,
          created_at
        ) VALUES (
          ${fixture.messageId},
          ${fixture.toolCallId},
          ${"not-json"},
          ${FIXED_NOW.getTime()}
        )
      `

      const malformed = yield* storage.get(getParams(fixture)).pipe(Effect.exit)
      expect(Exit.isFailure(malformed)).toBe(true)
      if (Exit.isFailure(malformed)) {
        expect(Schema.is(StorageError)(Cause.squash(malformed.cause))).toBe(true)
      }
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )

  it.live("round-trips a visible non-replayable dynamic source", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("dynamic")
      const storage = yield* ToolCallBindingStorage
      const dynamic = makeToolBindingIdentity({
        ...makeBinding(),
        source: ToolBindingSource.cases.DynamicNonReplayable.make({
          sourceRevision: ToolSourceRevision.make("dynamic-source/1"),
        }),
      })

      yield* storage.save(saveParams(fixture, dynamic))
      const loaded = yield* storage.get(getParams(fixture))
      expect(loaded?.source._tag).toBe("DynamicNonReplayable")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
})
