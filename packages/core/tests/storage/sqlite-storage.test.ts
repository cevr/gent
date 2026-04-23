import { describe, it, expect } from "effect-bun-test"
import { test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Storage } from "@gent/core/storage/sqlite-storage"
import {
  Session,
  Branch,
  Message,
  TextPart,
  ImagePart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
} from "@gent/core/domain/message"

import { AgentSwitched, SessionStarted } from "@gent/core/domain/event"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { messageToInfo } from "@gent/core/server/session-utils"

describe("Storage", () => {
  describe("Sessions", () => {
    it.live("creates and retrieves a session", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("lists sessions", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("lists first branch per session", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("updates a session", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("deletes a session", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )
  })

  describe("Events", () => {
    it.live("getLatestEvent returns latest event by tag", () =>
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
            toAgent: "deepwork",
          }),
        )

        yield* storage.appendEvent(
          new AgentSwitched({
            sessionId: session.id,
            branchId: branch.id,
            fromAgent: "deepwork",
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
      }).pipe(Effect.provide(Storage.Test())),
    )
  })

  describe("Branches", () => {
    it.live("creates and retrieves a branch", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("lists branches for a session", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("updates branch summary", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )
  })

  describe("Messages", () => {
    it.live("creates and retrieves messages", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("round-trips all persisted transcript part types", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const toolCallId = ToolCallId.of("all-parts-tc")

        yield* storage.createSession(
          new Session({
            id: "all-parts-session",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: "all-parts-branch",
            sessionId: "all-parts-session",
            createdAt: new Date(),
          }),
        )

        yield* storage.createMessage(
          new Message({
            id: "all-parts-msg",
            sessionId: "all-parts-session",
            branchId: "all-parts-branch",
            role: "assistant",
            parts: [
              new TextPart({ type: "text", text: "hello" }),
              new ReasoningPart({ type: "reasoning", text: "thinking" }),
              new ImagePart({
                type: "image",
                image: "data:image/webp;base64,abc",
                mediaType: "image/webp",
              }),
              new ToolCallPart({
                type: "tool-call",
                toolCallId,
                toolName: "inspect",
                input: { target: "image" },
              }),
              new ToolResultPart({
                type: "tool-result",
                toolCallId,
                toolName: "inspect",
                output: { type: "json", value: { ok: true } },
              }),
            ],
            createdAt: new Date(),
          }),
        )

        const retrieved = yield* storage.getMessage("all-parts-msg")
        expect(retrieved?.parts.map((part) => part.type)).toEqual([
          "text",
          "reasoning",
          "image",
          "tool-call",
          "tool-result",
        ])
        expect(retrieved?.parts[2]).toEqual(
          expect.objectContaining({
            type: "image",
            image: "data:image/webp;base64,abc",
            mediaType: "image/webp",
          }),
        )
        expect(retrieved?.parts[3]).toEqual(
          expect.objectContaining({
            type: "tool-call",
            toolCallId,
            toolName: "inspect",
            input: { target: "image" },
          }),
        )
        expect(retrieved?.parts[4]).toEqual(
          expect.objectContaining({
            type: "tool-result",
            toolCallId,
            toolName: "inspect",
            output: { type: "json", value: { ok: true } },
          }),
        )
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("counts messages in a branch", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("lists messages for a branch", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("updates session updatedAt when creating message", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("rolls back message insert when session timestamp update fails", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const start = new Date(0)
        const messageTime = new Date(1000)

        yield* storage.createSession(
          new Session({
            id: "tx-message-session",
            createdAt: start,
            updatedAt: start,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: "tx-message-branch",
            sessionId: "tx-message-session",
            createdAt: start,
          }),
        )
        yield* sql.unsafe(`
          CREATE TRIGGER tx_fail_session_update
          BEFORE UPDATE ON sessions
          WHEN old.id = 'tx-message-session'
          BEGIN
            SELECT RAISE(ABORT, 'forced session update failure');
          END
        `)

        const error = yield* Effect.flip(
          storage.createMessage(
            new Message({
              id: "tx-message",
              sessionId: "tx-message-session",
              branchId: "tx-message-branch",
              role: "user",
              parts: [new TextPart({ type: "text", text: "rollback" })],
              createdAt: messageTime,
            }),
          ),
        )

        expect(error._tag).toBe("StorageError")
        expect(yield* storage.getMessage("tx-message")).toBeUndefined()
        const session = yield* storage.getSession("tx-message-session")
        expect(session?.updatedAt.getTime()).toBe(start.getTime())
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )

    it.live("createMessageIfAbsent leaves session timestamp unchanged when insert is ignored", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const start = new Date(0)
        const firstTime = new Date(1000)
        const duplicateTime = new Date(2000)

        yield* storage.createSession(
          new Session({
            id: "if-absent-session",
            createdAt: start,
            updatedAt: start,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: "if-absent-branch",
            sessionId: "if-absent-session",
            createdAt: start,
          }),
        )

        yield* storage.createMessageIfAbsent(
          new Message({
            id: "if-absent-message",
            sessionId: "if-absent-session",
            branchId: "if-absent-branch",
            role: "user",
            parts: [new TextPart({ type: "text", text: "first" })],
            createdAt: firstTime,
          }),
        )
        yield* storage.createMessageIfAbsent(
          new Message({
            id: "if-absent-message",
            sessionId: "if-absent-session",
            branchId: "if-absent-branch",
            role: "user",
            parts: [new TextPart({ type: "text", text: "duplicate" })],
            createdAt: duplicateTime,
          }),
        )

        const session = yield* storage.getSession("if-absent-session")
        expect(session?.updatedAt.getTime()).toBe(firstTime.getTime())
        const message = yield* storage.getMessage("if-absent-message")
        expect(message?.parts).toEqual([new TextPart({ type: "text", text: "first" })])
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("orders messages by createdAt then id", () =>
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
      }).pipe(Effect.provide(Storage.Test())),
    )
  })

  describe("Message Metadata", () => {
    it.live("metadata round-trips through storage", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({ id: "meta-s", createdAt: new Date(), updatedAt: new Date() }),
        )
        yield* storage.createBranch(
          new Branch({ id: "meta-b", sessionId: "meta-s", createdAt: new Date() }),
        )

        const message = new Message({
          id: "meta-msg-1",
          sessionId: "meta-s",
          branchId: "meta-b",
          role: "user",
          parts: [new TextPart({ type: "text", text: "hello" })],
          createdAt: new Date(),
          metadata: {
            customType: "review-status",
            extensionId: "review-loop",
            hidden: true,
            details: { iteration: 3 },
          },
        })
        yield* storage.createMessage(message)

        const messages = yield* storage.listMessages("meta-b")
        expect(messages.length).toBe(1)
        const m = messages[0]!
        expect(m.metadata).toBeDefined()
        expect(m.metadata!.customType).toBe("review-status")
        expect(m.metadata!.extensionId).toBe("review-loop")
        expect(m.metadata!.hidden).toBe(true)
        expect((m.metadata!.details as { iteration: number }).iteration).toBe(3)
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("createMessageIfAbsent preserves metadata", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({ id: "upsert-s", createdAt: new Date(), updatedAt: new Date() }),
        )
        yield* storage.createBranch(
          new Branch({ id: "upsert-b", sessionId: "upsert-s", createdAt: new Date() }),
        )

        const message = new Message({
          id: "upsert-msg",
          sessionId: "upsert-s",
          branchId: "upsert-b",
          role: "user",
          parts: [new TextPart({ type: "text", text: "follow-up" })],
          createdAt: new Date(),
          metadata: { hidden: true, extensionId: "review-loop" },
        })
        yield* storage.createMessageIfAbsent(message)

        const messages = yield* storage.listMessages("upsert-b")
        expect(messages.length).toBe(1)
        expect(messages[0]!.metadata).toBeDefined()
        expect(messages[0]!.metadata!.hidden).toBe(true)
        expect(messages[0]!.metadata!.extensionId).toBe("review-loop")
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("messages without metadata have undefined metadata", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(
          new Session({ id: "no-meta-s", createdAt: new Date(), updatedAt: new Date() }),
        )
        yield* storage.createBranch(
          new Branch({ id: "no-meta-b", sessionId: "no-meta-s", createdAt: new Date() }),
        )

        yield* storage.createMessage(
          new Message({
            id: "no-meta-msg",
            sessionId: "no-meta-s",
            branchId: "no-meta-b",
            role: "user",
            parts: [new TextPart({ type: "text", text: "plain" })],
            createdAt: new Date(),
          }),
        )

        const messages = yield* storage.listMessages("no-meta-b")
        expect(messages[0]!.metadata).toBeUndefined()
      }).pipe(Effect.provide(Storage.Test())),
    )

    it.live("invalid stored metadata decodes to undefined across read surfaces", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient

        yield* storage.createSession(
          new Session({ id: "bad-meta-s", createdAt: new Date(), updatedAt: new Date() }),
        )
        yield* storage.createBranch(
          new Branch({ id: "bad-meta-b", sessionId: "bad-meta-s", createdAt: new Date() }),
        )

        yield* sql`INSERT INTO messages (id, session_id, branch_id, kind, role, parts, created_at, turn_duration_ms, metadata) VALUES (${"bad-meta-msg"}, ${"bad-meta-s"}, ${"bad-meta-b"}, ${null}, ${"assistant"}, ${JSON.stringify([{ type: "text", text: "hello" }])}, ${Date.now()}, ${null}, ${'{"customType":1}'})`

        const messages = yield* storage.listMessages("bad-meta-b")
        expect(messages).toHaveLength(1)
        expect(messages[0]!.metadata).toBeUndefined()

        const message = yield* storage.getMessage(MessageId.of("bad-meta-msg"))
        expect(message?.metadata).toBeUndefined()

        const detail = yield* storage.getSessionDetail(SessionId.of("bad-meta-s"))
        expect(detail.branches).toHaveLength(1)
        expect(detail.branches[0]!.messages).toHaveLength(1)
        expect(detail.branches[0]!.messages[0]!.metadata).toBeUndefined()
      }).pipe(Effect.provide(Storage.TestWithSql())),
    )

    test("messageToInfo preserves metadata for transport", () => {
      const message = new Message({
        id: "info-msg",
        sessionId: "info-s",
        branchId: "info-b",
        role: "assistant",
        parts: [new TextPart({ type: "text", text: "response" })],
        createdAt: new Date(),
        metadata: { customType: "review-status", hidden: true },
      })

      const info = messageToInfo(message)
      expect(info.metadata).toBeDefined()
      expect(info.metadata!.customType).toBe("review-status")
      expect(info.metadata!.hidden).toBe(true)
    })

    test("messageToInfo omits metadata when absent", () => {
      const message = new Message({
        id: "plain-msg",
        sessionId: "plain-s",
        branchId: "plain-b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "hi" })],
        createdAt: new Date(),
      })

      const info = messageToInfo(message)
      expect(info.metadata).toBeUndefined()
    })
  })

  describe("Event backward compatibility", () => {
    const layer = Storage.TestWithSql()

    it.live("listEvents skips events with unknown _tag instead of crashing", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient

        const sessionId = SessionId.of("compat-session")
        const branchId = BranchId.of("compat-branch")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )

        yield* storage.appendEvent(new SessionStarted({ sessionId, branchId }))

        // Simulate old DB row with a deleted event type
        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, 'ToolCallCompleted', ${JSON.stringify({ _tag: "ToolCallCompleted", sessionId, branchId, toolCallId: "tc-1", toolName: "bash" })}, ${Date.now()})`

        yield* storage.appendEvent(new SessionStarted({ sessionId, branchId }))

        const events = yield* storage.listEvents({ sessionId, branchId })
        expect(events.length).toBe(2)
        expect(events.every((e) => e.event._tag === "SessionStarted")).toBe(true)
      }).pipe(Effect.provide(layer)),
    )

    it.live("getLatestEvent returns undefined for undecodable events", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient

        const sessionId = SessionId.of("compat-latest")
        const branchId = BranchId.of("compat-latest-b")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat-latest",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )

        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, 'SubagentCompleted', ${JSON.stringify({ _tag: "SubagentCompleted", sessionId, branchId })}, ${Date.now()})`

        const latest = yield* storage.getLatestEvent({
          sessionId,
          branchId,
          tags: ["SubagentCompleted"],
        })
        expect(latest).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )

    it.live("listEvents rewrites legacy subagent rows to AgentRun events", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient

        const sessionId = SessionId.of("compat-agent-run")
        const branchId = BranchId.of("compat-agent-run-b")
        const childSessionId = SessionId.of("compat-agent-run-child")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat-agent-run",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )

        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, 'SubagentSpawned', ${JSON.stringify({ _tag: "SubagentSpawned", parentSessionId: sessionId, childSessionId, agentName: "reviewer", prompt: "inspect", branchId })}, ${Date.now()})`

        const events = yield* storage.listEvents({ sessionId, branchId })
        expect(events).toHaveLength(1)
        expect(events[0]?.event._tag).toBe("AgentRunSpawned")
      }).pipe(Effect.provide(layer)),
    )

    it.live("getLatestEvent resolves legacy subagent tags when queried by AgentRun tag", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient

        const sessionId = SessionId.of("compat-agent-run-latest")
        const branchId = BranchId.of("compat-agent-run-latest-b")
        const childSessionId = SessionId.of("compat-agent-run-latest-child")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat-agent-run-latest",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )

        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, ${branchId}, 'SubagentSucceeded', ${JSON.stringify({ _tag: "SubagentSucceeded", parentSessionId: sessionId, childSessionId, agentName: "reviewer", branchId })}, ${Date.now()})`

        const latest = yield* storage.getLatestEvent({
          sessionId,
          branchId,
          tags: ["AgentRunSucceeded"],
        })
        expect(latest?._tag).toBe("AgentRunSucceeded")
      }).pipe(Effect.provide(layer)),
    )

    it.live("getLatestEventTag includes branchless legacy subagent rows for branch queries", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient

        const sessionId = SessionId.of("compat-agent-run-tagless")
        const branchId = BranchId.of("compat-agent-run-tagless-b")
        const childSessionId = SessionId.of("compat-agent-run-tagless-child")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat-agent-run-tagless",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )

        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, NULL, 'SubagentSucceeded', ${JSON.stringify({ _tag: "SubagentSucceeded", parentSessionId: sessionId, childSessionId, agentName: "reviewer" })}, ${Date.now()})`

        const latestTag = yield* storage.getLatestEventTag({
          sessionId,
          branchId,
          tags: ["AgentRunSucceeded"],
        })
        expect(latestTag).toBe("AgentRunSucceeded")
      }).pipe(Effect.provide(layer)),
    )

    it.live("getLatestEvent includes branchless legacy subagent rows for branch queries", () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const sql = yield* SqlClient.SqlClient

        const sessionId = SessionId.of("compat-agent-run-branchless")
        const branchId = BranchId.of("compat-agent-run-branchless-b")
        const childSessionId = SessionId.of("compat-agent-run-branchless-child")
        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "compat-agent-run-branchless",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        )

        yield* sql`INSERT INTO events (session_id, branch_id, event_tag, event_json, created_at) VALUES (${sessionId}, NULL, 'SubagentFailed', ${JSON.stringify({ _tag: "SubagentFailed", parentSessionId: sessionId, childSessionId, agentName: "reviewer" })}, ${Date.now()})`

        const latest = yield* storage.getLatestEvent({
          sessionId,
          branchId,
          tags: ["AgentRunFailed"],
        })
        expect(latest?._tag).toBe("AgentRunFailed")
      }).pipe(Effect.provide(layer)),
    )
  })
})
