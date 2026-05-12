import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { EventDecodeError, EventStorage } from "@gent/core-internal/storage/event-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { Branch, dateFromMillis, Session } from "@gent/core-internal/domain/message"
import { AgentSwitched, SessionStarted } from "@gent/core-internal/domain/event"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { AgentName } from "@gent/core-internal/domain/agent"

const FIXED_NOW_MILLIS = 1_767_225_600_000
const FIXED_NOW = dateFromMillis(FIXED_NOW_MILLIS)

describe("Events", () => {
  it.live("getLatestEvent returns latest event by tag", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const events = yield* EventStorage
      const session = new Session({
        id: SessionId.make("event-session"),
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      })
      const branch = new Branch({
        id: BranchId.make("event-branch"),
        sessionId: SessionId.make("event-session"),
        createdAt: FIXED_NOW,
      })
      yield* sessions.createSession(session)
      yield* branches.createBranch(branch)
      yield* events.appendEvent(
        AgentSwitched.make({
          sessionId: session.id,
          branchId: branch.id,
          fromAgent: AgentName.make("cowork"),
          toAgent: AgentName.make("deepwork"),
        }),
      )
      yield* events.appendEvent(
        AgentSwitched.make({
          sessionId: session.id,
          branchId: branch.id,
          fromAgent: AgentName.make("deepwork"),
          toAgent: AgentName.make("cowork"),
        }),
      )
      const latest = yield* events.getLatestEvent({
        sessionId: session.id,
        branchId: branch.id,
        tags: ["AgentSwitched"],
      })
      expect(latest?._tag).toBe("AgentSwitched")
      if (latest && latest._tag === "AgentSwitched") {
        expect(latest.toAgent).toBe(AgentName.make("cowork"))
      }
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
})

describe("Event decoding", () => {
  const layer = SqliteStorage.TestWithSql()
  it.live("listEvents fails with a tagged decode error for unknown _tag", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const events = yield* EventStorage
      const sql = yield* SqlClient.SqlClient
      const sessionId = SessionId.make("unknown-event-session")
      const branchId = BranchId.make("unknown-event-branch")
      const unknownEventJson =
        '{"_tag":"__test_unknown__","sessionId":"unknown-event-session","branchId":"unknown-event-branch","toolCallId":"tc-1","toolName":"bash"}'
      yield* sessions.createSession(
        new Session({
          id: sessionId,
          name: "unknown-event",
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
      yield* events.appendEvent(SessionStarted.make({ sessionId, branchId }))
      yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, '__test_unknown__', ${unknownEventJson}, ${FIXED_NOW_MILLIS})`
      const error = yield* events.listEvents({ sessionId, branchId }).pipe(Effect.flip)
      expect(error._tag).toBe("EventDecodeError")
      if (error._tag !== "EventDecodeError") return
      expect(error).toBeInstanceOf(EventDecodeError)
      expect(error.eventId).toBeDefined()
      expect(error.operation).toBe("listEvents")
    }).pipe(Effect.provide(layer)),
  )
  it.live("getLatestEvent fails with a tagged decode error for undecodable events", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const events = yield* EventStorage
      const sql = yield* SqlClient.SqlClient
      const sessionId = SessionId.make("unknown-event-latest")
      const branchId = BranchId.make("unknown-event-latest-b")
      const unknownEventJson =
        '{"_tag":"__test_unknown__","sessionId":"unknown-event-latest","branchId":"unknown-event-latest-b"}'
      yield* sessions.createSession(
        new Session({
          id: sessionId,
          name: "unknown-event-latest",
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
      yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, 'SessionStarted', ${unknownEventJson}, ${FIXED_NOW_MILLIS})`
      const error = yield* events
        .getLatestEvent({
          sessionId,
          branchId,
          tags: ["SessionStarted"],
        })
        .pipe(Effect.flip)
      expect(error._tag).toBe("EventDecodeError")
      if (error._tag !== "EventDecodeError") return
      expect(error).toBeInstanceOf(EventDecodeError)
      expect(error.eventId).toBeDefined()
      expect(error.operation).toBe("getLatestEvent")
    }).pipe(Effect.provide(layer)),
  )
})
