import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { Branch, dateFromMillis, Session } from "@gent/core-internal/domain/message"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { SqlClient } from "effect/unstable/sql"

const FIXED_NOW_MILLIS = 1_767_225_600_000
const FIXED_NOW = dateFromMillis(FIXED_NOW_MILLIS)

describe("Branches", () => {
  it.live("creates and retrieves a branch", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("branch-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      const branch = new Branch({
        id: BranchId.make("test-branch"),
        sessionId: SessionId.make("branch-session"),
        createdAt: FIXED_NOW,
      })
      yield* branches.createBranch(branch)
      const retrieved = yield* branches.getBranch(BranchId.make("test-branch"))
      expect(retrieved).toBeDefined()
      expect(retrieved?.sessionId).toBe(SessionId.make("branch-session"))
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("lists branches for a session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("multi-branch"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("b1"),
          sessionId: SessionId.make("multi-branch"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("b2"),
          sessionId: SessionId.make("multi-branch"),
          parentBranchId: BranchId.make("b1"),
          createdAt: FIXED_NOW,
        }),
      )
      const branchesResult = yield* branches.listBranches(SessionId.make("multi-branch"))
      expect(branchesResult.length).toBe(2)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("fails through StorageError for invalid durable branch row shape", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sql = yield* SqlClient.SqlClient
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("invalid-branch-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* sql`INSERT INTO branches (id, session_id, created_at) VALUES (${"invalid-branch-row"}, ${"invalid-branch-session"}, ${"not-a-number"})`
      const exit = yield* Effect.exit(branches.getBranch(BranchId.make("invalid-branch-row")))
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("updates branch summary", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("summary-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("summary-branch"),
          sessionId: SessionId.make("summary-session"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* branches.updateBranchSummary(BranchId.make("summary-branch"), "Short summary")
      const retrieved = yield* branches.getBranch(BranchId.make("summary-branch"))
      expect(retrieved?.summary).toBe("Short summary")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
})
