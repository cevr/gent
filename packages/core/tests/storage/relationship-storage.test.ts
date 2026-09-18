/**
 * The thread a session belongs to.
 *
 * A thread is the work, not one session's parent line. A compaction handoff
 * continues the work and stays in the thread; a delegate run or a `/btw` side
 * question is its own work and starts its own thread.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Option } from "effect"
import { RelationshipStorage, SessionStorage, SqliteStorage } from "../../src/storage/storage"
import { dateFromMillis, Session } from "../../src/domain/message"
import { SessionId } from "../../src/domain/ids"

/**
 * Create a session the way one of the two child writers would.
 *
 * `threadId` is what separates them: a compaction handoff passes the parent's
 * thread, a spawn passes nothing and storage roots a new thread at the session.
 */
const makeSession = (
  id: string,
  options: { readonly parent?: string; readonly thread?: string; readonly at: number },
) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStorage
    const parentFields = Option.match(Option.fromUndefinedOr(options.parent), {
      onNone: () => ({}),
      onSome: (parent) => ({ parentSessionId: SessionId.make(parent) }),
    })
    const threadFields = Option.match(Option.fromUndefinedOr(options.thread), {
      onNone: () => ({}),
      onSome: (thread) => ({ threadId: SessionId.make(thread) }),
    })
    return yield* sessions.createSession(
      new Session({
        id: SessionId.make(id),
        name: id,
        ...parentFields,
        ...threadFields,
        createdAt: dateFromMillis(options.at),
        updatedAt: dateFromMillis(options.at),
      }),
    )
  })

const ids = (sessions: ReadonlyArray<Session>) => sessions.map((session) => String(session.id))

describe("thread sessions", () => {
  it.live("reaches a sibling handoff the parent line never saw", () =>
    Effect.gen(function* () {
      const root = yield* makeSession("root", { at: 1_000 })
      // Two handoffs off one root: the context window ran out twice.
      yield* makeSession("first", { parent: "root", thread: String(root.threadId), at: 2_000 })
      yield* makeSession("second", { parent: "root", thread: String(root.threadId), at: 3_000 })
      const relationships = yield* RelationshipStorage

      const thread = yield* relationships.getThreadSessions(SessionId.make("first"))
      expect(ids(thread)).toEqual(["root", "first", "second"])
    }).pipe(Effect.provide(SqliteStorage.TestWithSql(() => Layer.empty, {}))),
  )

  it.live("leaves a spawned session out of the thread it was launched from", () =>
    Effect.gen(function* () {
      const root = yield* makeSession("root", { at: 1_000 })
      yield* makeSession("handoff", { parent: "root", thread: String(root.threadId), at: 2_000 })
      // A delegate run passes no thread, so it starts its own.
      yield* makeSession("delegate", { parent: "root", at: 3_000 })
      const relationships = yield* RelationshipStorage

      const thread = yield* relationships.getThreadSessions(SessionId.make("root"))
      expect(ids(thread)).toEqual(["root", "handoff"])
    }).pipe(Effect.provide(SqliteStorage.TestWithSql(() => Layer.empty, {}))),
  )

  it.live("gives a spawned session its own thread, including its handoffs", () =>
    Effect.gen(function* () {
      yield* makeSession("root", { at: 1_000 })
      const delegate = yield* makeSession("delegate", { parent: "root", at: 2_000 })
      // The delegate outgrew its own window and handed off.
      yield* makeSession("delegate-handoff", {
        parent: "delegate",
        thread: String(delegate.threadId),
        at: 3_000,
      })
      const relationships = yield* RelationshipStorage

      // Asked from inside the spawn, the answer is the spawn's own work —
      // not the parent's thread with the spawn filtered out of it.
      const thread = yield* relationships.getThreadSessions(SessionId.make("delegate"))
      expect(ids(thread)).toEqual(["delegate", "delegate-handoff"])
    }).pipe(Effect.provide(SqliteStorage.TestWithSql(() => Layer.empty, {}))),
  )

  it.live("roots a thread at a session created without one", () =>
    Effect.gen(function* () {
      const root = yield* makeSession("root", { at: 1_000 })
      expect(String(root.threadId)).toBe("root")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql(() => Layer.empty, {}))),
  )
})
