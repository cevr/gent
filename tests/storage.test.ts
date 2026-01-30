import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Storage } from "@gent/storage"
import { Session, Branch, Message, TextPart, TodoItem, AgentSwitched } from "@gent/core"

const run = <A, E>(effect: Effect.Effect<A, E, Storage>) =>
  Effect.runPromise(Effect.provide(effect, Storage.Test()))

describe("Storage", () => {
  describe("Sessions", () => {
    test("creates and retrieves a session", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          const session = new Session({
            id: "test-session",
            name: "Test Session",
            createdAt: new Date(),
            updatedAt: new Date(),
          })

          yield* storage.createSession(session)
          const retrieved = yield* storage.getSession("test-session")

          expect(retrieved).toBeDefined()
          expect(retrieved?.id).toBe("test-session")
          expect(retrieved?.name).toBe("Test Session")
        }),
      )
    })

    test("lists sessions", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "s1",
              name: "Session 1",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createSession(
            new Session({
              id: "s2",
              name: "Session 2",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )

          const sessions = yield* storage.listSessions()
          expect(sessions.length).toBe(2)
        }),
      )
    })

    test("lists first branch per session", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = Date.now()

          yield* storage.createSession(
            new Session({
              id: "s1",
              createdAt: new Date(now),
              updatedAt: new Date(now),
            }),
          )
          yield* storage.createSession(
            new Session({
              id: "s2",
              createdAt: new Date(now + 1),
              updatedAt: new Date(now + 1),
            }),
          )

          yield* storage.createBranch(
            new Branch({
              id: "s1-b1",
              sessionId: "s1",
              createdAt: new Date(now + 10),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "s1-b0",
              sessionId: "s1",
              createdAt: new Date(now),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "s2-b1",
              sessionId: "s2",
              createdAt: new Date(now + 5),
            }),
          )

          const firstBranches = yield* storage.listFirstBranches()
          const map = new Map(firstBranches.map((row) => [row.sessionId, row.branchId]))

          expect(map.get("s1")).toBe("s1-b0")
          expect(map.get("s2")).toBe("s2-b1")
        }),
      )
    })

    test("updates a session", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          const session = new Session({
            id: "update-test",
            name: "Original",
            createdAt: new Date(),
            updatedAt: new Date(),
          })

          yield* storage.createSession(session)
          yield* storage.updateSession(new Session({ ...session, name: "Updated" }))

          const retrieved = yield* storage.getSession("update-test")
          expect(retrieved?.name).toBe("Updated")
        }),
      )
    })

    test("deletes a session", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          yield* storage.createSession(
            new Session({
              id: "delete-test",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )

          yield* storage.deleteSession("delete-test")
          const retrieved = yield* storage.getSession("delete-test")

          expect(retrieved).toBeUndefined()
        }),
      )
    })
  })

  describe("Events", () => {
    test("getLatestEvent returns latest event by tag", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          const session = new Session({
            id: "event-session",
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          const branch = new Branch({
            id: "event-branch",
            sessionId: "event-session",
            createdAt: new Date(),
          })

          yield* storage.createSession(session)
          yield* storage.createBranch(branch)

          yield* storage.appendEvent(
            new AgentSwitched({
              sessionId: session.id,
              branchId: branch.id,
              fromAgent: "cowork",
              toAgent: "deep",
            }),
          )

          yield* storage.appendEvent(
            new AgentSwitched({
              sessionId: session.id,
              branchId: branch.id,
              fromAgent: "deep",
              toAgent: "cowork",
            }),
          )

          const latest = yield* storage.getLatestEvent({
            sessionId: session.id,
            branchId: branch.id,
            tags: ["AgentSwitched"],
          })

          expect(latest?._tag).toBe("AgentSwitched")
          if (latest && latest._tag === "AgentSwitched") {
            expect(latest.toAgent).toBe("cowork")
          }
        }),
      )
    })
  })

  describe("Branches", () => {
    test("creates and retrieves a branch", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "branch-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )

          const branch = new Branch({
            id: "test-branch",
            sessionId: "branch-session",
            createdAt: new Date(),
          })

          yield* storage.createBranch(branch)
          const retrieved = yield* storage.getBranch("test-branch")

          expect(retrieved).toBeDefined()
          expect(retrieved?.sessionId).toBe("branch-session")
        }),
      )
    })

    test("lists branches for a session", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "multi-branch",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )

          yield* storage.createBranch(
            new Branch({
              id: "b1",
              sessionId: "multi-branch",
              createdAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "b2",
              sessionId: "multi-branch",
              parentBranchId: "b1",
              createdAt: new Date(),
            }),
          )

          const branches = yield* storage.listBranches("multi-branch")
          expect(branches.length).toBe(2)
        }),
      )
    })

    test("updates branch summary", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "summary-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )

          yield* storage.createBranch(
            new Branch({
              id: "summary-branch",
              sessionId: "summary-session",
              createdAt: new Date(),
            }),
          )

          yield* storage.updateBranchSummary("summary-branch", "Short summary")

          const retrieved = yield* storage.getBranch("summary-branch")
          expect(retrieved?.summary).toBe("Short summary")
        }),
      )
    })
  })

  describe("Messages", () => {
    test("creates and retrieves messages", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "msg-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "msg-branch",
              sessionId: "msg-session",
              createdAt: new Date(),
            }),
          )

          const message = new Message({
            id: "msg-1",
            sessionId: "msg-session",
            branchId: "msg-branch",
            role: "user",
            parts: [new TextPart({ type: "text", text: "Hello" })],
            createdAt: new Date(),
          })

          yield* storage.createMessage(message)
          const retrieved = yield* storage.getMessage("msg-1")

          expect(retrieved).toBeDefined()
          expect(retrieved?.role).toBe("user")
          expect(retrieved?.parts[0]?.type).toBe("text")
        }),
      )
    })

    test("counts messages in a branch", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "count-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "count-branch",
              sessionId: "count-session",
              createdAt: new Date(),
            }),
          )

          yield* storage.createMessage(
            new Message({
              id: "count-msg-1",
              sessionId: "count-session",
              branchId: "count-branch",
              role: "user",
              parts: [new TextPart({ type: "text", text: "one" })],
              createdAt: new Date(),
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "count-msg-2",
              sessionId: "count-session",
              branchId: "count-branch",
              role: "assistant",
              parts: [new TextPart({ type: "text", text: "two" })],
              createdAt: new Date(),
            }),
          )

          const count = yield* storage.countMessages("count-branch")
          expect(count).toBe(2)
        }),
      )
    })

    test("lists messages for a branch", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage

          yield* storage.createSession(
            new Session({
              id: "list-msg-session",
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "list-msg-branch",
              sessionId: "list-msg-session",
              createdAt: new Date(),
            }),
          )

          yield* storage.createMessage(
            new Message({
              id: "lm1",
              sessionId: "list-msg-session",
              branchId: "list-msg-branch",
              role: "user",
              parts: [new TextPart({ type: "text", text: "First" })],
              createdAt: new Date(),
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "lm2",
              sessionId: "list-msg-session",
              branchId: "list-msg-branch",
              role: "assistant",
              parts: [new TextPart({ type: "text", text: "Response" })],
              createdAt: new Date(),
            }),
          )

          const messages = yield* storage.listMessages("list-msg-branch")
          expect(messages.length).toBe(2)
          expect(messages[0]?.role).toBe("user")
          expect(messages[1]?.role).toBe("assistant")
        }),
      )
    })

    test("updates session updatedAt when creating message", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          const start = new Date(0)
          const messageTime = new Date(1000)

          yield* storage.createSession(
            new Session({
              id: "session-updated-at",
              createdAt: start,
              updatedAt: start,
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "branch-updated-at",
              sessionId: "session-updated-at",
              createdAt: start,
            }),
          )

          yield* storage.createMessage(
            new Message({
              id: "msg-updated-at",
              sessionId: "session-updated-at",
              branchId: "branch-updated-at",
              role: "user",
              parts: [new TextPart({ type: "text", text: "Ping" })],
              createdAt: messageTime,
            }),
          )

          const session = yield* storage.getSession("session-updated-at")
          expect(session?.updatedAt.getTime()).toBe(messageTime.getTime())
        }),
      )
    })

    test("orders messages by createdAt then id", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          const timestamp = new Date()

          yield* storage.createSession(
            new Session({
              id: "order-session",
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          )
          yield* storage.createBranch(
            new Branch({
              id: "order-branch",
              sessionId: "order-session",
              createdAt: timestamp,
            }),
          )

          yield* storage.createMessage(
            new Message({
              id: "b",
              sessionId: "order-session",
              branchId: "order-branch",
              role: "user",
              parts: [new TextPart({ type: "text", text: "Second" })],
              createdAt: timestamp,
            }),
          )
          yield* storage.createMessage(
            new Message({
              id: "a",
              sessionId: "order-session",
              branchId: "order-branch",
              role: "user",
              parts: [new TextPart({ type: "text", text: "First" })],
              createdAt: timestamp,
            }),
          )

          const messages = yield* storage.listMessages("order-branch")
          expect(messages[0]?.id).toBe("a")
          expect(messages[1]?.id).toBe("b")
        }),
      )
    })
  })

  describe("Todos", () => {
    test("listTodos returns empty for new branch", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          const todos = yield* storage.listTodos("nonexistent")
          expect(todos.length).toBe(0)
        }),
      )
    })

    test("replaceTodos stores and retrieves todos", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = new Date()

          const todos = [
            new TodoItem({
              id: "t1",
              content: "Task 1",
              status: "pending",
              priority: "high",
              createdAt: now,
              updatedAt: now,
            }),
            new TodoItem({
              id: "t2",
              content: "Task 2",
              status: "in_progress",
              createdAt: now,
              updatedAt: now,
            }),
          ]

          yield* storage.replaceTodos("test-branch", todos)
          const retrieved = yield* storage.listTodos("test-branch")

          expect(retrieved.length).toBe(2)
          expect(retrieved[0]?.content).toBe("Task 1")
          expect(retrieved[0]?.priority).toBe("high")
          expect(retrieved[1]?.status).toBe("in_progress")
        }),
      )
    })

    test("replaceTodos replaces existing todos", async () => {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = new Date()

          yield* storage.replaceTodos("branch", [
            new TodoItem({
              id: "old",
              content: "Old",
              status: "pending",
              createdAt: now,
              updatedAt: now,
            }),
          ])

          yield* storage.replaceTodos("branch", [
            new TodoItem({
              id: "new",
              content: "New",
              status: "completed",
              createdAt: now,
              updatedAt: now,
            }),
          ])

          const todos = yield* storage.listTodos("branch")
          expect(todos.length).toBe(1)
          expect(todos[0]?.content).toBe("New")
        }),
      )
    })
  })
})
