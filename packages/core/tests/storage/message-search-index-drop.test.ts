/**
 * Migration 020 removes `messages_fts`.
 *
 * The table was written on every message insert and read by one storage
 * method nothing called. A database written by any earlier build still holds
 * it on disk, so the removal has to be a migration: a schema edit alone would
 * leave the table behind forever. This test writes that old shape to a real
 * file, opens it with the current storage layer, and checks the upgrade.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { Database } from "bun:sqlite"
import { SqlClient } from "effect/unstable/sql"
import { SessionStorage, SqliteStorage } from "../../src/storage/storage"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { dateFromMillis, Session } from "../../src/domain/message"
import { SessionId } from "../../src/domain/ids"
import { CurrentWorkspaceId } from "../../src/server/workspace-rpc"
import { makeTempDirectoryScoped } from "../../src/test-utils/language-model"

const WORKSPACE = "a".repeat(64)
const FIXED_NOW = dateFromMillis(1_767_225_600_000)

const tableExists = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      name: string
    }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`
    return rows.length > 0
  })

describe("message search index removal", () => {
  it.scopedLive("an older database keeps its sessions and loses messages_fts", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDirectoryScoped("gent-fts-drop-")
      const dbPath = `${dir}/data.db`

      // The shape an earlier build left on disk: the virtual table with a row.
      yield* Effect.sync(() => {
        const db = new Database(dbPath)
        db.run(
          `CREATE VIRTUAL TABLE messages_fts USING fts5(content, message_id UNINDEXED, session_id UNINDEXED, branch_id UNINDEXED, role UNINDEXED)`,
        )
        db.run(
          `INSERT INTO messages_fts(content, message_id, session_id, branch_id, role) VALUES ('stale text', 'm1', 's1', 'b1', 'user')`,
        )
        db.close()
      })

      const storage = SqliteStorage.LiveWithSql(dbPath, () => Layer.empty, {}).pipe(
        Layer.provide(GentPlatform.Test()),
        Layer.provide(BunServices.layer),
      )

      yield* Effect.gen(function* () {
        expect(yield* tableExists("messages_fts")).toBe(false)

        // The upgraded database is still a working store.
        const sessions = yield* SessionStorage
        const sessionId = SessionId.make("upgraded-session")
        yield* sessions.createSession(
          new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
        )
        const stored = yield* sessions.getSession(sessionId)
        expect(stored?.id).toBe(sessionId)
      }).pipe(
        Effect.provideService(CurrentWorkspaceId, WORKSPACE),
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the storage layer under test.
        Effect.provide(storage),
      )
    }),
  )
})
