import { describe, expect, it, test } from "effect-bun-test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { RelationshipStorage } from "@gent/core-internal/storage/relationship-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { Branch, dateFromMillis, Message, Session } from "@gent/core-internal/domain/message"
import {
  BranchId,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"

const FIXED_NOW_MILLIS = 1_767_225_600_000
const FIXED_NOW = dateFromMillis(FIXED_NOW_MILLIS)

describe("Messages", () => {
  it.live("creates and retrieves messages", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("msg-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("msg-branch"),
          sessionId: SessionId.make("msg-session"),
          createdAt: FIXED_NOW,
        }),
      )
      const message = Message.cases.regular.make({
        id: MessageId.make("msg-1"),
        sessionId: SessionId.make("msg-session"),
        branchId: BranchId.make("msg-branch"),
        role: "user",
        parts: [Prompt.textPart({ text: "Hello" })],
        createdAt: FIXED_NOW,
      })
      yield* messages.createMessage(message)
      const retrieved = yield* messages.getMessage(MessageId.make("msg-1"))
      expect(retrieved).toBeDefined()
      expect(retrieved?.role).toBe("user")
      expect(retrieved?.parts[0]?.type).toBe("text")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("round-trips all persisted transcript part types", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const toolCallId = ToolCallId.make("all-parts-tc")
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("all-parts-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("all-parts-branch"),
          sessionId: SessionId.make("all-parts-session"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("all-parts-msg"),
          sessionId: SessionId.make("all-parts-session"),
          branchId: BranchId.make("all-parts-branch"),
          role: "assistant",
          parts: [
            Prompt.textPart({ text: "hello" }),
            Prompt.reasoningPart({ text: "thinking" }),
            Prompt.filePart({
              data: "data:image/webp;base64,abc",
              mediaType: "image/webp",
            }),
            Prompt.toolCallPart({
              id: toolCallId,
              name: "inspect",
              params: { target: "image" },
              providerExecuted: false,
            }),
            Prompt.toolResultPart({
              id: toolCallId,
              name: "inspect",
              isFailure: false,
              result: { ok: true },
            }),
          ],
          createdAt: FIXED_NOW,
        }),
      )
      const retrieved = yield* messages.getMessage(MessageId.make("all-parts-msg"))
      expect(retrieved?.parts.map((part) => part.type)).toEqual([
        "text",
        "reasoning",
        "file",
        "tool-call",
        "tool-result",
      ])
      expect(retrieved?.parts[2]).toEqual(
        expect.objectContaining({
          type: "file",
          data: "data:image/webp;base64,abc",
          mediaType: "image/webp",
        }),
      )
      expect(retrieved?.parts[3]).toEqual(
        expect.objectContaining({
          type: "tool-call",
          id: toolCallId,
          name: "inspect",
          params: { target: "image" },
          providerExecuted: false,
        }),
      )
      expect(retrieved?.parts[4]).toEqual(
        expect.objectContaining({
          type: "tool-result",
          id: toolCallId,
          name: "inspect",
          isFailure: false,
          result: { ok: true },
        }),
      )
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("stores message parts in shared content chunks", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sql = yield* SqlClient.SqlClient
      const sharedPart = Prompt.textPart({ text: "dedupe me" })
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("chunk-s"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("chunk-b"),
          sessionId: SessionId.make("chunk-s"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("chunk-a"),
          sessionId: SessionId.make("chunk-s"),
          branchId: BranchId.make("chunk-b"),
          role: "user",
          parts: [sharedPart],
          createdAt: dateFromMillis(1000),
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("chunk-b-msg"),
          sessionId: SessionId.make("chunk-s"),
          branchId: BranchId.make("chunk-b"),
          role: "assistant",
          parts: [sharedPart],
          createdAt: dateFromMillis(2000),
        }),
      )
      const chunkRows = yield* sql<{
        count: number
      }>`SELECT COUNT(*) as count FROM content_chunks`
      const refRows = yield* sql<{
        count: number
      }>`SELECT COUNT(*) as count FROM message_chunks`
      const messagesResult = yield* messages.listMessages(BranchId.make("chunk-b"))
      expect(chunkRows[0]?.count).toBe(1)
      expect(refRows[0]?.count).toBe(2)
      expect(messagesResult.map((message) => message.parts)).toEqual([[sharedPart], [sharedPart]])
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("counts messages in a branch", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("count-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("count-branch"),
          sessionId: SessionId.make("count-session"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("count-msg-1"),
          sessionId: SessionId.make("count-session"),
          branchId: BranchId.make("count-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "one" })],
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("count-msg-2"),
          sessionId: SessionId.make("count-session"),
          branchId: BranchId.make("count-branch"),
          role: "assistant",
          parts: [Prompt.textPart({ text: "two" })],
          createdAt: FIXED_NOW,
        }),
      )
      const count = yield* branches.countMessages(BranchId.make("count-branch"))
      expect(count).toBe(2)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("lists messages for a branch", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("list-msg-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("list-msg-branch"),
          sessionId: SessionId.make("list-msg-session"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("lm1"),
          sessionId: SessionId.make("list-msg-session"),
          branchId: BranchId.make("list-msg-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "First" })],
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("lm2"),
          sessionId: SessionId.make("list-msg-session"),
          branchId: BranchId.make("list-msg-branch"),
          role: "assistant",
          parts: [Prompt.textPart({ text: "Response" })],
          createdAt: FIXED_NOW,
        }),
      )
      const messagesResult = yield* messages.listMessages(BranchId.make("list-msg-branch"))
      expect(messagesResult.length).toBe(2)
      expect(messagesResult[0]?.role).toBe("user")
      expect(messagesResult[1]?.role).toBe("assistant")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("deletes message chunk refs and search projection rows", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sql = yield* SqlClient.SqlClient
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("delete-projection-session"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("delete-projection-branch"),
          sessionId: SessionId.make("delete-projection-session"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("delete-projection-a"),
          sessionId: SessionId.make("delete-projection-session"),
          branchId: BranchId.make("delete-projection-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "delete projection alpha" })],
          createdAt: dateFromMillis(1000),
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("delete-projection-b"),
          sessionId: SessionId.make("delete-projection-session"),
          branchId: BranchId.make("delete-projection-branch"),
          role: "assistant",
          parts: [Prompt.textPart({ text: "delete projection beta" })],
          createdAt: dateFromMillis(2000),
        }),
      )
      yield* messages.deleteMessages(BranchId.make("delete-projection-branch"))
      const messagesResult = yield* sql<{
        count: number
      }>`SELECT COUNT(*) as count FROM messages`
      const refs = yield* sql<{
        count: number
      }>`SELECT COUNT(*) as count FROM message_chunks`
      const chunks = yield* sql<{
        count: number
      }>`SELECT COUNT(*) as count FROM content_chunks`
      const fts = yield* sql<{
        count: number
      }>`SELECT COUNT(*) as count FROM messages_fts`
      expect(messagesResult[0]?.count).toBe(0)
      expect(refs[0]?.count).toBe(0)
      expect(chunks[0]?.count).toBe(0)
      expect(fts[0]?.count).toBe(0)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("updates session updatedAt when creating message", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const start = dateFromMillis(0)
      const messageTime = dateFromMillis(1000)
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("session-updated-at"),
          createdAt: start,
          updatedAt: start,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("branch-updated-at"),
          sessionId: SessionId.make("session-updated-at"),
          createdAt: start,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("msg-updated-at"),
          sessionId: SessionId.make("session-updated-at"),
          branchId: BranchId.make("branch-updated-at"),
          role: "user",
          parts: [Prompt.textPart({ text: "Ping" })],
          createdAt: messageTime,
        }),
      )
      const session = yield* sessions.getSession(SessionId.make("session-updated-at"))
      expect(session?.updatedAt.getTime()).toBe(messageTime.getTime())
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("rolls back message insert when session timestamp update fails", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sql = yield* SqlClient.SqlClient
      const start = dateFromMillis(0)
      const messageTime = dateFromMillis(1000)
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("tx-message-session"),
          createdAt: start,
          updatedAt: start,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("tx-message-branch"),
          sessionId: SessionId.make("tx-message-session"),
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
        messages.createMessage(
          Message.cases.regular.make({
            id: MessageId.make("tx-message"),
            sessionId: SessionId.make("tx-message-session"),
            branchId: BranchId.make("tx-message-branch"),
            role: "user",
            parts: [Prompt.textPart({ text: "rollback" })],
            createdAt: messageTime,
          }),
        ),
      )
      expect(error._tag).toBe("StorageError")
      expect(yield* messages.getMessage(MessageId.make("tx-message"))).toBeUndefined()
      const session = yield* sessions.getSession(SessionId.make("tx-message-session"))
      expect(session?.updatedAt.getTime()).toBe(start.getTime())
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("createMessageIfAbsent leaves session timestamp unchanged when insert is ignored", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const start = dateFromMillis(0)
      const firstTime = dateFromMillis(1000)
      const duplicateTime = dateFromMillis(2000)
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("if-absent-session"),
          createdAt: start,
          updatedAt: start,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("if-absent-branch"),
          sessionId: SessionId.make("if-absent-session"),
          createdAt: start,
        }),
      )
      yield* messages.createMessageIfAbsent(
        Message.cases.regular.make({
          id: MessageId.make("if-absent-message"),
          sessionId: SessionId.make("if-absent-session"),
          branchId: BranchId.make("if-absent-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "first" })],
          createdAt: firstTime,
        }),
      )
      yield* messages.createMessageIfAbsent(
        Message.cases.regular.make({
          id: MessageId.make("if-absent-message"),
          sessionId: SessionId.make("if-absent-session"),
          branchId: BranchId.make("if-absent-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "duplicate" })],
          createdAt: duplicateTime,
        }),
      )
      const session = yield* sessions.getSession(SessionId.make("if-absent-session"))
      expect(session?.updatedAt.getTime()).toBe(firstTime.getTime())
      const message = yield* messages.getMessage(MessageId.make("if-absent-message"))
      expect(message?.parts).toEqual([Prompt.textPart({ text: "first" })])
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("orders messages by createdAt then id", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const timestamp = FIXED_NOW
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("order-session"),
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("order-branch"),
          sessionId: SessionId.make("order-session"),
          createdAt: timestamp,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("b"),
          sessionId: SessionId.make("order-session"),
          branchId: BranchId.make("order-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "Second" })],
          createdAt: timestamp,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("a"),
          sessionId: SessionId.make("order-session"),
          branchId: BranchId.make("order-branch"),
          role: "user",
          parts: [Prompt.textPart({ text: "First" })],
          createdAt: timestamp,
        }),
      )
      const messagesResult = yield* messages.listMessages(BranchId.make("order-branch"))
      expect(messagesResult[0]?.id).toBe(MessageId.make("a"))
      expect(messagesResult[1]?.id).toBe(MessageId.make("b"))
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
})
describe("Message Metadata", () => {
  it.live("metadata round-trips through storage", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("meta-s"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("meta-b"),
          sessionId: SessionId.make("meta-s"),
          createdAt: FIXED_NOW,
        }),
      )
      const message = Message.cases.regular.make({
        id: MessageId.make("meta-msg-1"),
        sessionId: SessionId.make("meta-s"),
        branchId: BranchId.make("meta-b"),
        role: "user",
        parts: [Prompt.textPart({ text: "hello" })],
        createdAt: FIXED_NOW,
        metadata: {
          customType: "review-status",
          extensionId: ExtensionId.make("review-loop"),
          hidden: true,
          details: { iteration: 3 },
        },
      })
      yield* messages.createMessage(message)
      const messagesResult = yield* messages.listMessages(BranchId.make("meta-b"))
      expect(messagesResult.length).toBe(1)
      const m = messagesResult[0]!
      expect(m.metadata).toBeDefined()
      expect(m.metadata!.customType).toBe("review-status")
      expect(m.metadata!.extensionId).toBe("review-loop")
      expect(m.metadata!.hidden).toBe(true)
      expect(
        (
          m.metadata!.details as {
            iteration: number
          }
        ).iteration,
      ).toBe(3)
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("createMessageIfAbsent preserves metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("upsert-s"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("upsert-b"),
          sessionId: SessionId.make("upsert-s"),
          createdAt: FIXED_NOW,
        }),
      )
      const message = Message.cases.regular.make({
        id: MessageId.make("upsert-msg"),
        sessionId: SessionId.make("upsert-s"),
        branchId: BranchId.make("upsert-b"),
        role: "user",
        parts: [Prompt.textPart({ text: "follow-up" })],
        createdAt: FIXED_NOW,
        metadata: { hidden: true, extensionId: ExtensionId.make("review-loop") },
      })
      yield* messages.createMessageIfAbsent(message)
      const messagesResult = yield* messages.listMessages(BranchId.make("upsert-b"))
      expect(messagesResult.length).toBe(1)
      expect(messagesResult[0]!.metadata).toBeDefined()
      expect(messagesResult[0]!.metadata!.hidden).toBe(true)
      expect(messagesResult[0]!.metadata!.extensionId).toBe("review-loop")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("messages without metadata have undefined metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("no-meta-s"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("no-meta-b"),
          sessionId: SessionId.make("no-meta-s"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: MessageId.make("no-meta-msg"),
          sessionId: SessionId.make("no-meta-s"),
          branchId: BranchId.make("no-meta-b"),
          role: "user",
          parts: [Prompt.textPart({ text: "plain" })],
          createdAt: FIXED_NOW,
        }),
      )
      const messagesResult = yield* messages.listMessages(BranchId.make("no-meta-b"))
      expect(messagesResult[0]!.metadata).toBeUndefined()
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  it.live("invalid stored metadata decodes to undefined across read surfaces", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const relationships = yield* RelationshipStorage
      const sql = yield* SqlClient.SqlClient
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("bad-meta-s"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("bad-meta-b"),
          sessionId: SessionId.make("bad-meta-s"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* sql`INSERT INTO messages (id, session_id, branch_id, kind, role, created_at, turn_duration_ms, metadata) VALUES (${"bad-meta-msg"}, ${"bad-meta-s"}, ${"bad-meta-b"}, ${null}, ${"assistant"}, ${FIXED_NOW_MILLIS}, ${null}, ${'{"customType":1}'})`
      const messagesResult = yield* messages.listMessages(BranchId.make("bad-meta-b"))
      expect(messagesResult).toHaveLength(1)
      expect(messagesResult[0]!.metadata).toBeUndefined()
      const message = yield* messages.getMessage(MessageId.make("bad-meta-msg"))
      expect(message?.metadata).toBeUndefined()
      const detail = yield* relationships.getSessionDetail(SessionId.make("bad-meta-s"))
      expect(detail.branches).toHaveLength(1)
      expect(detail.branches[0]!.messages).toHaveLength(1)
      expect(detail.branches[0]!.messages[0]!.metadata).toBeUndefined()
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  test("domain message preserves metadata for transport", () => {
    const message = Message.cases.regular.make({
      id: MessageId.make("info-msg"),
      sessionId: SessionId.make("info-s"),
      branchId: BranchId.make("info-b"),
      role: "assistant",
      parts: [Prompt.textPart({ text: "response" })],
      createdAt: FIXED_NOW,
      metadata: { customType: "review-status", hidden: true },
    })
    expect(message.metadata).toBeDefined()
    expect(message.metadata!.customType).toBe("review-status")
    expect(message.metadata!.hidden).toBe(true)
  })
  it.live("interjection messages round-trip as explicit variants", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      yield* sessions.createSession(
        new Session({
          id: SessionId.make("interjection-s"),
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
      )
      yield* branches.createBranch(
        new Branch({
          id: BranchId.make("interjection-b"),
          sessionId: SessionId.make("interjection-s"),
          createdAt: FIXED_NOW,
        }),
      )
      yield* messages.createMessage(
        Message.cases.interjection.make({
          id: MessageId.make("interjection-msg"),
          sessionId: SessionId.make("interjection-s"),
          branchId: BranchId.make("interjection-b"),
          role: "user",
          parts: [Prompt.textPart({ text: "steer now" })],
          createdAt: FIXED_NOW,
        }),
      )
      const stored = yield* messages.getMessage(MessageId.make("interjection-msg"))
      if (stored === undefined) throw new Error("expected interjection message")
      expect(stored._tag).toBe("interjection")
      expect(stored.role).toBe("user")
    }).pipe(Effect.provide(SqliteStorage.TestWithSql())),
  )
  test("domain message omits metadata when absent", () => {
    const message = Message.cases.regular.make({
      id: MessageId.make("plain-msg"),
      sessionId: SessionId.make("plain-s"),
      branchId: BranchId.make("plain-b"),
      role: "user",
      parts: [Prompt.textPart({ text: "hi" })],
      createdAt: FIXED_NOW,
    })
    expect(message.metadata).toBeUndefined()
  })
})
