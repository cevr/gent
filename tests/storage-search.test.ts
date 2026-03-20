import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Storage } from "@gent/storage"
import {
  Session,
  Branch,
  Message,
  TextPart,
  type SessionId,
  type BranchId,
  type MessageId,
} from "@gent/core"

const layer = Storage.Test()

const run = <A, E>(effect: Effect.Effect<A, E, Storage>) =>
  Effect.runPromise(Effect.provide(effect, layer))

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
  test("finds message by keyword in text part content", () =>
    run(
      Effect.gen(function* () {
        const { sessionId, branchId } = yield* createFixture()
        yield* addMessage(sessionId, branchId, "user", "implement the authentication flow")

        const storage = yield* Storage
        const results = yield* storage.searchMessages("authentication")
        expect(results.length).toBeGreaterThan(0)
        expect(results.some((r) => r.sessionId === sessionId)).toBe(true)
      }),
    ))

  test("returns snippet with match context", () =>
    run(
      Effect.gen(function* () {
        const { sessionId, branchId } = yield* createFixture()
        yield* addMessage(sessionId, branchId, "assistant", "the database migration is complete")

        const storage = yield* Storage
        const results = yield* storage.searchMessages("migration")
        expect(results.length).toBeGreaterThan(0)
        expect(results[0]!.snippet).toBeDefined()
      }),
    ))

  test("filters by dateAfter (recent messages only)", () =>
    run(
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
      }),
    ))

  test("respects limit parameter", () =>
    run(
      Effect.gen(function* () {
        const { sessionId, branchId } = yield* createFixture()
        for (let i = 0; i < 5; i++) {
          yield* addMessage(sessionId, branchId, "user", `limitword item ${i}`)
        }

        const storage = yield* Storage
        const results = yield* storage.searchMessages("limitword", { limit: 2 })
        expect(results.length).toBeLessThanOrEqual(2)
      }),
    ))

  test("returns empty array for no matches", () =>
    run(
      Effect.gen(function* () {
        const storage = yield* Storage
        const results = yield* storage.searchMessages("xyznonexistentkeyword999")
        expect(results).toEqual([])
      }),
    ))

  test("joins session name in results", () =>
    run(
      Effect.gen(function* () {
        const { sessionId, branchId } = yield* createFixture({ sessionName: "My Test Session" })
        yield* addMessage(sessionId, branchId, "user", "unique namedtest content")

        const storage = yield* Storage
        const results = yield* storage.searchMessages("namedtest")
        const match = results.find((r) => r.sessionId === sessionId)
        expect(match).toBeDefined()
        expect(match!.sessionName).toBe("My Test Session")
      }),
    ))
})

describe("getSessionDetail", () => {
  test("returns all branches with messages", () =>
    run(
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
      }),
    ))

  test("returns messages in chronological order", () =>
    run(
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
      }),
    ))

  test("errors on missing session", () =>
    run(
      Effect.gen(function* () {
        const storage = yield* Storage
        const result = yield* Effect.result(storage.getSessionDetail("nonexistent" as SessionId))
        expect(result._tag).toBe("Failure")
      }),
    ))
})
