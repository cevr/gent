import { describe, expect, it } from "effect-bun-test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Effect, Ref } from "effect"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { Branch, dateFromMillis, Message, Session } from "@gent/core-internal/domain/message"
import { SessionStarted } from "@gent/core-internal/domain/event"
import { BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids"

const FIXED_NOW_MILLIS = 1_767_225_600_000
const FIXED_NOW = dateFromMillis(FIXED_NOW_MILLIS)

describe("Concurrent writes", () => {
  // The storage layer adds no in-memory locking on top of the SQL
  // client; the contract under test is that N concurrent calls through
  // the Effect surface produce N committed rows with no lost writes.
  //
  // Negative control: each test wraps the per-item write with a
  // `maxConcurrent` Ref counter — increment-on-enter, decrement-on-exit
  // — and asserts the observed peak was > 1. If a future refactor
  // accidentally drops `concurrency: "unbounded"` to `1`, the peak
  // collapses to 1 and the assertion fails. This proves the test
  // exercises real fiber interleaving rather than accidental
  // serialization.
  const trackedConcurrency = <A, E, R>(
    active: Ref.Ref<number>,
    peak: Ref.Ref<number>,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(active, (m) => m + 1)
        yield* Ref.update(peak, (p) => (n > p ? n : p))
        // Yield to the scheduler so peer fibers in `Effect.forEach`
        // get a chance to enter before this one completes its body.
        // Without this, bun:sqlite's synchronous calls cause each
        // fiber to run start-to-finish on the event loop, collapsing
        // observed concurrency to 1.
        yield* Effect.yieldNow
      }),
      () => body,
      () => Ref.update(active, (n) => n - 1),
    )
  it.live("createSession with N concurrent fibers produces N independent rows", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const N = 16
      const ids = Array.from({ length: N }, (_, i) => SessionId.make(`cs-${i}`))
      const active = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      yield* Effect.forEach(
        ids,
        (id) =>
          trackedConcurrency(
            active,
            peak,
            sessions.createSession(new Session({ id, createdAt: FIXED_NOW, updatedAt: FIXED_NOW })),
          ),
        { concurrency: "unbounded" },
      )
      const sessionsResult = yield* sessions.listSessions()
      const seen = new Set(sessionsResult.map((s) => s.id))
      for (const id of ids) {
        expect(seen.has(id)).toBe(true)
      }
      // Negative control: real interleaving, not accidental serialization.
      expect(yield* Ref.get(peak)).toBeGreaterThan(1)
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("appendEvent with N concurrent fibers produces N envelopes with unique ids", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const events = yield* EventStorage
      const sessionId = SessionId.make("ce-session")
      const branchId = BranchId.make("ce-branch")
      yield* sessions.createSession(
        new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
      const N = 32
      const active = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      const envelopes = yield* Effect.forEach(
        Array.from({ length: N }, () => 0),
        () =>
          trackedConcurrency(
            active,
            peak,
            events.appendEvent(SessionStarted.make({ sessionId, branchId })),
          ),
        { concurrency: "unbounded" },
      )
      expect(envelopes.length).toBe(N)
      const idSet = new Set(envelopes.map((e) => e.id))
      expect(idSet.size).toBe(N)
      const persisted = yield* events.listEvents({ sessionId, branchId })
      expect(persisted.length).toBe(N)
      expect(yield* Ref.get(peak)).toBeGreaterThan(1)
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("createMessage with N concurrent fibers produces N rows with no lost writes", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("cm-session")
      const branchId = BranchId.make("cm-branch")
      yield* sessions.createSession(
        new Session({ id: sessionId, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: FIXED_NOW }))
      const N = 24
      const ids = Array.from({ length: N }, (_, i) => MessageId.make(`cm-${i}`))
      const active = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      yield* Effect.forEach(
        ids,
        (id) =>
          trackedConcurrency(
            active,
            peak,
            messages.createMessage(
              Message.Regular.make({
                id,
                sessionId,
                branchId,
                role: "user",
                parts: [Prompt.textPart({ text: id })],
                createdAt: FIXED_NOW,
              }),
            ),
          ),
        { concurrency: "unbounded" },
      )
      const persisted = yield* messages.listMessages(branchId)
      expect(persisted.length).toBe(N)
      const seen = new Set(persisted.map((m) => m.id))
      for (const id of ids) {
        expect(seen.has(id)).toBe(true)
      }
      expect(yield* Ref.get(peak)).toBeGreaterThan(1)
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(SqliteStorage.TestWithSql())),
  )
})
