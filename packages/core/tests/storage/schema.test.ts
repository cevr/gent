import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  BranchStorage,
  MessageStorage,
  SessionStorage,
  SqliteStorage,
} from "../../src/storage/storage"
import type { FeatureMigrations } from "../../src/storage/schema"
import { BunServices } from "@effect/platform-bun"
import { Database } from "bun:sqlite"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { Branch, dateFromMillis, Message, Session } from "../../src/domain/message"
import { AgentName } from "../../src/domain/agent"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, MessageId, SessionId } from "../../src/domain/ids"
import { CurrentWorkspaceId } from "../../src/server/workspace-rpc"
import { makeTempDirectoryScoped } from "../../src/test-utils/language-model"

// ── feature-migrations.test ─────────────────────────────────────────────────

/**
 * Core's migration chain leaves room for the tables a feature owns.
 *
 * Core assembles the kernel's tables and nothing else. A feature that owns
 * tables contributes its own migrations at the same seam it contributes its
 * repositories, so core never names them.
 */

const appliedMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    name: string
  }>`SELECT name FROM gent_storage_migrations ORDER BY migration_id`
  return rows.map((row) => row.name)
})

const tableExists = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      name: string
    }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`
    return rows.length > 0
  })

const widgetMigrations: FeatureMigrations = {
  "090_widgets": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE widgets (id TEXT PRIMARY KEY)`)
  }),
}

const kernelOnly = SqliteStorage.TestWithSql(() => Layer.empty, {})
const withWidgets = SqliteStorage.TestWithSql(() => Layer.empty, widgetMigrations)

describe("feature migrations", () => {
  it.live("core builds only the kernel's tables when no feature contributes any", () =>
    Effect.gen(function* () {
      expect(yield* tableExists("widgets")).toBe(false)
      expect(yield* appliedMigrations).not.toContain("widgets")
    }).pipe(Effect.provide(kernelOnly)),
  )

  it.live("a feature's tables join the chain after core's", () =>
    Effect.gen(function* () {
      const names = yield* appliedMigrations
      expect(yield* tableExists("widgets")).toBe(true)
      expect(names.at(-1)).toBe("widgets")
      expect(names.indexOf("widgets")).toBeGreaterThan(names.indexOf("message_insertion_order"))
    }).pipe(Effect.provide(withWidgets)),
  )
})

// ── message-search-index-drop.test ──────────────────────────────────────────

/**
 * Migration 020 removes `messages_fts`.
 *
 * The table was written on every message insert and read by one storage
 * method nothing called. A database written by any earlier build still holds
 * it on disk, so the removal has to be a migration: a schema edit alone would
 * leave the table behind forever. This test writes that old shape to a real
 * file, opens it with the current storage layer, and checks the upgrade.
 */

const WORKSPACE = "a".repeat(64)
const FIXED_NOW = dateFromMillis(1_767_225_600_000)

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

describe("session admission", () => {
  it.scopedLive("a session keeps the admission it was created with", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const sessionId = SessionId.make("admitted-session")
      const admission = {
        agent: AgentName.make("helper"),
        runSpec: { overrides: { deniedTools: ["delegate.start"] } },
      }
      yield* sessions.createSession(
        new Session({ id: sessionId, admission, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
      )
      expect((yield* sessions.getSession(sessionId))?.admission).toEqual(admission)
      const plain = SessionId.make("plain-session")
      yield* sessions.createSession(
        new Session({ id: plain, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
      )
      expect((yield* sessions.getSession(plain))?.admission).toBeUndefined()
    }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE), Effect.provide(kernelOnly)),
  )

  it.scopedLive(
    "an older database gives a session the admission its stored turn or queued turn carried",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTempDirectoryScoped("gent-session-admission-")
        const dbPath = `${dir}/data.db`
        const storage = SqliteStorage.LiveWithSql(dbPath, () => Layer.empty, {}).pipe(
          Layer.provide(GentPlatform.Test()),
          Layer.provide(BunServices.layer),
        )
        const recorded = SessionId.make("recorded-child")
        const queued = SessionId.make("queued-child")
        const plain = SessionId.make("plain-parent")
        // A stored turn names `old`; the turn in flight names `new`.
        const both = SessionId.make("recorded-and-in-flight")
        // Two stored turns disagree; the later one names `new`.
        const history = SessionId.make("two-records")
        const branch = (sessionId: SessionId) => BranchId.make(`${sessionId}-branch`)
        const turn = (sessionId: SessionId) => MessageId.make(`${sessionId}-turn`)
        const laterTurn = MessageId.make(`${history}-z-later`)

        // The shape a build before this migration left: sessions with no
        // admission, and the per-turn admission on a turn record or a queued turn.
        yield* Effect.gen(function* () {
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const messages = yield* MessageStorage
          for (const sessionId of [recorded, queued, plain, both, history]) {
            yield* sessions.createSession(
              new Session({
                id: sessionId,
                createdAt: FIXED_NOW,
                updatedAt: FIXED_NOW,
              }),
            )
            yield* branches.createBranch(
              new Branch({ id: branch(sessionId), sessionId, createdAt: FIXED_NOW }),
            )
            yield* messages.createMessage(
              Message.cases.regular.make({
                id: turn(sessionId),
                sessionId,
                branchId: branch(sessionId),
                role: "user",
                parts: [Prompt.textPart({ text: "task" })],
                createdAt: FIXED_NOW,
              }),
            )
          }
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: laterTurn,
              sessionId: history,
              branchId: branch(history),
              role: "user",
              parts: [Prompt.textPart({ text: "later task" })],
              createdAt: FIXED_NOW,
            }),
          )
          const sql = yield* SqlClient.SqlClient
          const admissionJson =
            '{"agentOverride":"helper","interactive":false,"runSpec":{"overrides":{"deniedTools":["delegate.start"]}}}'
          yield* sql`INSERT INTO turn_records (session_id, branch_id, message_id, step, continuations, pending_tool_calls_json, admission_json, updated_at)
            VALUES (${recorded}, ${branch(recorded)}, ${turn(recorded)}, 1, 0, '[]', ${admissionJson}, 1)`
          const queueJson = `{"steering":[],"followUp":[],"inFlight":{"message":{"_tag":"regular","id":"q"},"agentOverride":"helper","interactive":false}}`
          yield* sql`INSERT INTO agent_loop_queues (workspace_id, session_id, branch_id, queue_json, updated_at)
            VALUES (${WORKSPACE}, ${queued}, ${branch(queued)}, ${queueJson}, 1)`
          const oldJson = '{"agentOverride":"old"}'
          const newJson = '{"agentOverride":"new"}'
          yield* sql`INSERT INTO turn_records (session_id, branch_id, message_id, step, continuations, pending_tool_calls_json, admission_json, updated_at)
            VALUES (${both}, ${branch(both)}, ${turn(both)}, 1, 0, '[]', ${oldJson}, 5)`
          const inFlightJson = `{"steering":[],"followUp":[],"inFlight":{"message":{"_tag":"regular","id":"f"},"agentOverride":"new"}}`
          yield* sql`INSERT INTO agent_loop_queues (workspace_id, session_id, branch_id, queue_json, updated_at)
            VALUES (${WORKSPACE}, ${both}, ${branch(both)}, ${inFlightJson}, 1)`
          // The earlier record sorts first by key and by rowid; only its time says it is older.
          yield* sql`INSERT INTO turn_records (session_id, branch_id, message_id, step, continuations, pending_tool_calls_json, admission_json, updated_at)
            VALUES (${history}, ${branch(history)}, ${turn(history)}, 1, 0, '[]', ${oldJson}, 1)`
          yield* sql`INSERT INTO turn_records (session_id, branch_id, message_id, step, continuations, pending_tool_calls_json, admission_json, updated_at)
            VALUES (${history}, ${branch(history)}, ${laterTurn}, 1, 0, '[]', ${newJson}, 2)`
          yield* sql`UPDATE sessions SET admission_json = NULL`
          yield* sql`DELETE FROM gent_storage_migrations WHERE name = 'session_admission'`
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the storage layer under test.
        }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE), Effect.provide(storage))

        yield* Effect.gen(function* () {
          const sessions = yield* SessionStorage
          // The copied `interactive` key stays in the row and decodes away:
          // whether a turn can ask comes from its origin now.
          expect((yield* sessions.getSession(recorded))?.admission).toEqual({
            agent: AgentName.make("helper"),
            runSpec: { overrides: { deniedTools: ["delegate.start"] } },
          })
          expect((yield* sessions.getSession(queued))?.admission).toEqual({
            agent: AgentName.make("helper"),
          })
          expect((yield* sessions.getSession(plain))?.admission).toBeUndefined()
          // The turn that runs next keeps its agent over an older record.
          expect((yield* sessions.getSession(both))?.admission).toEqual({
            agent: AgentName.make("new"),
          })
          // Among stored turns, the latest one wins.
          expect((yield* sessions.getSession(history))?.admission).toEqual({
            agent: AgentName.make("new"),
          })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the storage layer under test.
        }).pipe(Effect.provideService(CurrentWorkspaceId, WORKSPACE), Effect.provide(storage))
      }),
  )
})
