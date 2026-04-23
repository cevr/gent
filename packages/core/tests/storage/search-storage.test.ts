import { describe, it, expect } from "effect-bun-test"
import { test as bunTest } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { SearchStorage, sanitizeFts5Query } from "@gent/core/storage/search-storage"
import { Session, Branch, Message, TextPart } from "@gent/core/domain/message"
import { SessionId, BranchId, MessageId } from "@gent/core/domain/ids"

const test = it.live.layer(Storage.TestWithSql())

// Fixture helpers

let counter = 0
const nextId = () => `test-${++counter}` as string

const createFixture = (opts?: { sessionName?: string }) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const sessionId = SessionId.make(nextId())
    const branchId = BranchId.make(nextId())
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
      Message.cases.regular.make({
        id: MessageId.make(nextId()),
        sessionId,
        branchId,
        role,
        parts: [new TextPart({ type: "text", text })],
        createdAt: createdAt ?? new Date(),
      }),
    )
  })

describe("searchMessages", () => {
  test("finds message by keyword in text part content", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      yield* addMessage(sessionId, branchId, "user", "implement the authentication flow")

      const searchStore = yield* SearchStorage
      const results = yield* searchStore.searchMessages("authentication")
      expect(results.length).toBeGreaterThan(0)
      expect(results.some((r) => r.sessionId === sessionId)).toBe(true)
    }))

  test("indexes reconstructed chunk text rather than the legacy parts blob", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      const message = yield* addMessage(sessionId, branchId, "user", "chunk projection keyword")
      const sql = yield* SqlClient.SqlClient
      const legacyRows = yield* sql<{
        parts: string
      }>`SELECT parts FROM messages WHERE id = ${message.id}`

      const searchStore = yield* SearchStorage
      const results = yield* searchStore.searchMessages("projection keyword")

      expect(legacyRows[0]?.parts).toBe("[]")
      expect(results.some((r) => r.sessionId === sessionId)).toBe(true)
    }))

  test("returns snippet with match context", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      yield* addMessage(sessionId, branchId, "assistant", "the database migration is complete")

      const searchStore = yield* SearchStorage
      const results = yield* searchStore.searchMessages("migration")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.snippet).toBeDefined()
    }))

  test("filters by dateAfter (recent messages only)", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      const oldDate = new Date(Date.now() - 86400000 * 30)
      const recentDate = new Date()

      yield* addMessage(sessionId, branchId, "user", "old unique searchterm alpha", oldDate)
      yield* addMessage(sessionId, branchId, "user", "new unique searchterm beta", recentDate)

      const searchStore = yield* SearchStorage
      const results = yield* searchStore.searchMessages("searchterm", {
        dateAfter: Date.now() - 86400000,
      })
      expect(results.every((r) => r.createdAt > Date.now() - 86400000)).toBe(true)
    }))

  test("filters by sessionId", () =>
    Effect.gen(function* () {
      const first = yield* createFixture({ sessionName: "first" })
      const second = yield* createFixture({ sessionName: "second" })

      yield* addMessage(first.sessionId, first.branchId, "user", "shared-session-filter-term")
      yield* addMessage(second.sessionId, second.branchId, "user", "shared-session-filter-term")

      const searchStore = yield* SearchStorage
      const results = yield* searchStore.searchMessages("shared-session-filter-term", {
        sessionId: first.sessionId,
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results.every((result) => result.sessionId === first.sessionId)).toBe(true)
    }))

  test("filters by dateBefore (older messages only)", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      const oldDate = new Date(Date.now() - 86400000 * 30)
      const recentDate = new Date()

      yield* addMessage(sessionId, branchId, "user", "datebefore searchterm alpha", oldDate)
      yield* addMessage(sessionId, branchId, "user", "datebefore searchterm beta", recentDate)

      const cutoff = Date.now() - 86400000
      const searchStore = yield* SearchStorage
      const results = yield* searchStore.searchMessages("datebefore searchterm", {
        dateBefore: cutoff,
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results.every((result) => result.createdAt < cutoff)).toBe(true)
    }))

  test("respects limit parameter", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      for (let i = 0; i < 5; i++) {
        yield* addMessage(sessionId, branchId, "user", `limitword item ${i}`)
      }

      const searchStore = yield* SearchStorage
      const results = yield* searchStore.searchMessages("limitword", { limit: 2 })
      expect(results.length).toBeLessThanOrEqual(2)
    }))

  test("returns empty array for no matches", () =>
    Effect.gen(function* () {
      const searchStore = yield* SearchStorage
      const results = yield* searchStore.searchMessages("xyznonexistentkeyword999")
      expect(results).toEqual([])
    }))

  test("joins session name in results", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture({ sessionName: "My Test Session" })
      yield* addMessage(sessionId, branchId, "user", "unique namedtest content")

      const searchStore = yield* SearchStorage
      const results = yield* searchStore.searchMessages("namedtest")
      const match = results.find((r) => r.sessionId === sessionId)
      expect(match).toBeDefined()
      expect(match!.sessionName).toBe("My Test Session")
    }))

  test("handles trailing FTS5 operator without SQL error", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      yield* addMessage(sessionId, branchId, "user", "hello world or something")

      const searchStore = yield* SearchStorage
      // "hello OR" → '"hello" "OR"' — matches because message contains "or"
      const results = yield* searchStore.searchMessages("hello OR")
      expect(results.some((r) => r.sessionId === sessionId)).toBe(true)
    }))

  test("handles query with embedded FTS5 operators", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      yield* addMessage(sessionId, branchId, "user", "cats and dogs not animals")

      const searchStore = yield* SearchStorage
      // Operators treated as literal words — message contains "and", "not"
      const results = yield* searchStore.searchMessages("cats AND NOT dogs")
      expect(results.some((r) => r.sessionId === sessionId)).toBe(true)
    }))

  test("handles query with quotes and special characters", () =>
    Effect.gen(function* () {
      const { sessionId, branchId } = yield* createFixture()
      yield* addMessage(sessionId, branchId, "user", "special punctuation test here")

      const searchStore = yield* SearchStorage
      // Quotes, asterisks, and other FTS5 syntax chars should be stripped safely
      const results = yield* searchStore.searchMessages('"special" test*')
      expect(results.some((r) => r.sessionId === sessionId)).toBe(true)
    }))

  test("returns empty array for query that is only operators", () =>
    Effect.gen(function* () {
      const searchStore = yield* SearchStorage
      const results = yield* searchStore.searchMessages("OR AND NOT")
      expect(results).toEqual([])
    }))

  test("returns empty array for empty query", () =>
    Effect.gen(function* () {
      const searchStore = yield* SearchStorage
      const results = yield* searchStore.searchMessages("")
      expect(results).toEqual([])
    }))
})

describe("sanitizeFts5Query", () => {
  bunTest("wraps plain keywords in double quotes", () => {
    expect(sanitizeFts5Query("hello world")).toBe('"hello" "world"')
  })

  bunTest("quotes FTS5 operators as literal terms", () => {
    expect(sanitizeFts5Query("hello OR world")).toBe('"hello" "OR" "world"')
    expect(sanitizeFts5Query("NOT bad")).toBe('"NOT" "bad"')
    expect(sanitizeFts5Query("a AND b")).toBe('"a" "AND" "b"')
    expect(sanitizeFts5Query("NEAR something")).toBe('"NEAR" "something"')
  })

  bunTest("quotes operators case-insensitively as literals", () => {
    expect(sanitizeFts5Query("hello or world")).toBe('"hello" "or" "world"')
    expect(sanitizeFts5Query("not bad")).toBe('"not" "bad"')
  })

  bunTest("removes special FTS5 characters", () => {
    expect(sanitizeFts5Query('hello* "world" test^')).toBe('"hello" "world" "test"')
    expect(sanitizeFts5Query("(group) col:umn")).toBe('"group" "col" "umn"')
  })

  bunTest("quotes-only-operator input as literals", () => {
    expect(sanitizeFts5Query("OR AND NOT")).toBe('"OR" "AND" "NOT"')
  })

  bunTest("returns empty string for empty input", () => {
    expect(sanitizeFts5Query("")).toBe("")
  })

  bunTest("handles trailing operator as literal", () => {
    expect(sanitizeFts5Query("hello OR")).toBe('"hello" "OR"')
  })

  bunTest("handles punctuation-heavy input", () => {
    expect(sanitizeFts5Query("it's a +test- {thing}")).toBe('"it" "s" "a" "test" "thing"')
  })
})

describe("getSessionDetail", () => {
  test("returns all branches with messages", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const { sessionId, branchId } = yield* createFixture()
      yield* addMessage(sessionId, branchId, "user", "hello")
      yield* addMessage(sessionId, branchId, "assistant", "world")

      // Add second branch
      const branchId2 = BranchId.make(nextId())
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
    }))

  test("returns messages in chronological order", () =>
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
    }))

  test("errors on missing session", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const result = yield* Effect.result(storage.getSessionDetail(SessionId.make("nonexistent")))
      expect(result._tag).toBe("Failure")
    }))
})

describe("getChildSessions", () => {
  test("returns direct children of a parent session", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const parent = yield* createFixture({ sessionName: "parent" })

      // Create two child sessions
      const child1Id = SessionId.make(nextId())
      const child2Id = SessionId.make(nextId())
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
    }))

  test("returns empty array when no children", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const parent = yield* createFixture()
      const children = yield* storage.getChildSessions(parent.sessionId)
      expect(children.length).toBe(0)
    }))

  test("does not return grandchildren", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const parent = yield* createFixture({ sessionName: "root" })
      const now = new Date()

      // Child
      const childId = SessionId.make(nextId())
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
      const grandchildId = SessionId.make(nextId())
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
    }))
})

describe("getSessionAncestors", () => {
  test("walks from child to root", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const now = new Date()

      // Root -> Parent -> Child
      const rootId = SessionId.make(nextId())
      const parentId = SessionId.make(nextId())
      const childId = SessionId.make(nextId())

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
    }))

  test("returns single session for root", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const root = yield* createFixture({ sessionName: "lone-root" })
      const ancestors = yield* storage.getSessionAncestors(root.sessionId)
      expect(ancestors.length).toBe(1)
      expect(ancestors[0]!.id).toBe(root.sessionId)
    }))
})
