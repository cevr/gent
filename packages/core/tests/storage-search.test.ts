import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { Session, Branch, Message, TextPart } from "@gent/core/domain/message"
import type { SessionId, BranchId, MessageId } from "@gent/core/domain/ids"

const layer = Storage.Test()

// Fixture helpers

let counter = 0
const nextId = () => `test-${++counter}` as string

const createFixture = (opts?: { sessionName?: string }) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const sessionId = nextId() as SessionId
    const branchId = nextId() as BranchId
    const now = new Date()

    const session = yield* storage.createSession(
      new Session({
        id: sessionId,
        name: opts?.sessionName,
        createdAt: now,
        updatedAt: now,
      }),
    )

    const branch = yield* storage.createBranch(
      new Branch({
        id: branchId,
        sessionId,
        name: "main",
        createdAt: now,
      }),
    )

    return { session, branch, sessionId, branchId }
  })

const addMessage = (
  sessionId: SessionId,
  branchId: BranchId,
  role: "user" | "assistant",
  text: string,
  createdAt?: Date,
) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    return yield* storage.createMessage(
      new Message({
        id: nextId() as MessageId,
        sessionId,
        branchId,
        role,
        parts: [new TextPart({ type: "text", text })],
        createdAt: createdAt ?? new Date(),
      }),
    )
  })

describe("searchMessages", () => {
  it.live("finds message by keyword in text part content", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      yield* addMessage(sessionId, branchId, "user", "implement the authentication flow")

      const storage = yield* Storage
      const results = yield* storage.searchMessages("authentication")
      expect(results.length).toBeGreaterThan(0)
      expect(results.some((r) => r.sessionId === sessionId)).toBe(true)
    }).pipe(Effect.provide(layer)),
  )

  it.live("returns snippet with match context", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      yield* addMessage(sessionId, branchId, "assistant", "the database migration is complete")

      const storage = yield* Storage
      const results = yield* storage.searchMessages("migration")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.snippet).toBeDefined()
    }).pipe(Effect.provide(layer)),
  )

  it.live("filters by dateAfter (recent messages only)", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      const oldDate = new Date(Date.now() - 86400000 * 30)
      const recentDate = new Date()

      yield* addMessage(sessionId, branchId, "user", "old unique searchterm alpha", oldDate)
      yield* addMessage(sessionId, branchId, "user", "new unique searchterm beta", recentDate)

      const storage = yield* Storage
      const results = yield* storage.searchMessages("searchterm", {
        dateAfter: Date.now() - 86400000,
      })
      expect(results.every((r) => r.createdAt > Date.now() - 86400000)).toBe(true)
    }).pipe(Effect.provide(layer)),
  )

  it.live("respects limit parameter", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      for (let i = 0; i < 5; i++) {
        yield* addMessage(sessionId, branchId, "user", `limitword item ${i}`)
      }

      const storage = yield* Storage
      const results = yield* storage.searchMessages("limitword", { limit: 2 })
      expect(results.length).toBeLessThanOrEqual(2)
    }).pipe(Effect.provide(layer)),
  )

  it.live("returns empty array for no matches", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const results = yield* storage.searchMessages("xyznonexistentkeyword999")
      expect(results).toEqual([])
    }).pipe(Effect.provide(layer)),
  )

  it.live("joins session name in results", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture({ sessionName: "My Test Session" })
      yield* addMessage(sessionId, branchId, "user", "unique namedtest content")

      const storage = yield* Storage
      const results = yield* storage.searchMessages("namedtest")
      const match = results.find((r) => r.sessionId === sessionId)
      expect(match).toBeDefined()
      expect(match!.sessionName).toBe("My Test Session")
    }).pipe(Effect.provide(layer)),
  )
})

describe("getSessionDetail", () => {
  it.live("returns all branches with messages", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const { sessionId, branchId } = yield* createFixture()
      yield* addMessage(sessionId, branchId, "user", "hello")
      yield* addMessage(sessionId, branchId, "assistant", "world")

      // Add second branch
      const branchId2 = nextId() as BranchId
      yield* storage.createBranch(
        new Branch({
          id: branchId2,
          sessionId,
          parentBranchId: branchId,
          name: "fix",
          createdAt: new Date(),
        }),
      )
      yield* addMessage(sessionId, branchId2, "user", "fix this")

      const tree = yield* storage.getSessionDetail(sessionId)
      expect(tree.branches.length).toBe(2)
      expect(tree.branches[0]!.messages.length).toBe(2)
      expect(tree.branches[1]!.messages.length).toBe(1)
    }).pipe(Effect.provide(layer)),
  )

  it.live("returns messages in chronological order", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      yield* addMessage(sessionId, branchId, "user", "first", new Date(1000))
      yield* addMessage(sessionId, branchId, "assistant", "second", new Date(2000))
      yield* addMessage(sessionId, branchId, "user", "third", new Date(3000))

      const storage = yield* Storage
      const tree = yield* storage.getSessionDetail(sessionId)
      const msgs = tree.branches[0]!.messages
      expect(msgs[0]!.parts[0]!.type === "text" && msgs[0]!.parts[0]!.text).toBe("first")
      expect(msgs[2]!.parts[0]!.type === "text" && msgs[2]!.parts[0]!.text).toBe("third")
    }).pipe(Effect.provide(layer)),
  )

  it.live("errors on missing session", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const result = yield* Effect.result(storage.getSessionDetail("nonexistent" as SessionId))
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.provide(layer)),
  )
})

describe("getChildSessions", () => {
  it.live("returns direct children of a parent session", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const parent = yield* createFixture({ sessionName: "parent" })

      // Create two child sessions
      const child1Id = nextId() as SessionId
      const child2Id = nextId() as SessionId
      const now = new Date()

      yield* storage.createSession(
        new Session({
          id: child1Id,
          name: "child-1",
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
          createdAt: now,
          updatedAt: now,
        }),
      )
      yield* storage.createSession(
        new Session({
          id: child2Id,
          name: "child-2",
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
          createdAt: new Date(now.getTime() + 1000),
          updatedAt: new Date(now.getTime() + 1000),
        }),
      )

      const children = yield* storage.getChildSessions(parent.sessionId)
      expect(children.length).toBe(2)
      expect(children[0]!.id).toBe(child1Id)
      expect(children[1]!.id).toBe(child2Id)
      expect(children[0]!.parentSessionId).toBe(parent.sessionId)
    }).pipe(Effect.provide(layer)),
  )

  it.live("returns empty array when no children", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const parent = yield* createFixture()
      const children = yield* storage.getChildSessions(parent.sessionId)
      expect(children.length).toBe(0)
    }).pipe(Effect.provide(layer)),
  )

  it.live("does not return grandchildren", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const parent = yield* createFixture({ sessionName: "root" })
      const now = new Date()

      // Child
      const childId = nextId() as SessionId
      yield* storage.createSession(
        new Session({
          id: childId,
          name: "child",
          parentSessionId: parent.sessionId,
          createdAt: now,
          updatedAt: now,
        }),
      )

      // Grandchild
      const grandchildId = nextId() as SessionId
      yield* storage.createSession(
        new Session({
          id: grandchildId,
          name: "grandchild",
          parentSessionId: childId,
          createdAt: now,
          updatedAt: now,
        }),
      )

      const children = yield* storage.getChildSessions(parent.sessionId)
      expect(children.length).toBe(1)
      expect(children[0]!.id).toBe(childId)
    }).pipe(Effect.provide(layer)),
  )
})

describe("getSessionAncestors", () => {
  it.live("walks from child to root", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const now = new Date()

      // Root -> Parent -> Child
      const rootId = nextId() as SessionId
      const parentId = nextId() as SessionId
      const childId = nextId() as SessionId

      yield* storage.createSession(
        new Session({ id: rootId, name: "root", createdAt: now, updatedAt: now }),
      )
      yield* storage.createSession(
        new Session({
          id: parentId,
          name: "parent",
          parentSessionId: rootId,
          createdAt: now,
          updatedAt: now,
        }),
      )
      yield* storage.createSession(
        new Session({
          id: childId,
          name: "child",
          parentSessionId: parentId,
          createdAt: now,
          updatedAt: now,
        }),
      )

      const ancestors = yield* storage.getSessionAncestors(childId)
      expect(ancestors.length).toBe(3)
      expect(ancestors[0]!.id).toBe(childId)
      expect(ancestors[1]!.id).toBe(parentId)
      expect(ancestors[2]!.id).toBe(rootId)
    }).pipe(Effect.provide(layer)),
  )

  it.live("returns single session for root", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const root = yield* createFixture({ sessionName: "lone-root" })
      const ancestors = yield* storage.getSessionAncestors(root.sessionId)
      expect(ancestors.length).toBe(1)
      expect(ancestors[0]!.id).toBe(root.sessionId)
    }).pipe(Effect.provide(layer)),
  )
})
