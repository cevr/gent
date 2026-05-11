import { describe, expect, it } from "effect-bun-test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Cause, Effect, Logger, Option } from "effect"
import { BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids"
import { Branch, Message } from "@gent/core-internal/domain/message"
import { SessionRuntimeError } from "../../src/runtime/session-runtime"
import { SessionCommands } from "../../src/server/session-commands"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { SessionMutations } from "../../src/domain/session-mutations"
import {
  FIXED_NOW,
  createActiveSessionFixture,
  datePlusMillis,
  failingSessionCommandsLayer,
  sendFailingSessionCommandsLayer,
  sessionCommandsLayer,
} from "./session-commands/helpers"

describe("session command persistence", () => {
  it.live("sendMessage surfaces runtime failure and does not log message sent", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const logMessages: string[] = []
      const captureLogger = Logger.make(({ message }) => {
        logMessages.push(
          Array.isArray(message)
            ? message.map((entry) => String(entry)).join(" ")
            : String(message),
        )
      })

      const exit = yield* Effect.exit(
        commands
          .sendMessage({
            sessionId: SessionId.make("send-runtime-failure"),
            branchId: BranchId.make("send-runtime-failure-branch"),
            content: "fail loudly",
          })
          .pipe(Effect.provide(Logger.layer([captureLogger]))),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(error)).toBe(true)
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(SessionRuntimeError)
          expect(error.value.message).toBe("runtime failed")
        }
      }
      expect(logMessages).not.toContain("session.messageSent")
    }).pipe(Effect.provide(sendFailingSessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("rolls back session and branch creation when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage

      const exit = yield* Effect.exit(commands.createSession({ cwd: "/tmp/rollback" }))

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions()).toHaveLength(0)
      expect(yield* branches.listBranches(SessionId.make("missing"))).toHaveLength(0)
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("rolls back forked branch and copied messages when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("session-rollback")
      const branchId = BranchId.make("branch-source")
      const messageId = MessageId.make("message-source")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "rollback",
      })
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "seed" })],
          createdAt: now,
        }),
      )

      const exit = yield* Effect.exit(
        commands.forkBranch({
          sessionId,
          fromBranchId: branchId,
          atMessageId: messageId,
          name: "fork",
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* branches.listBranches(sessionId)).toHaveLength(1)
      expect(yield* messages.listMessages(branchId)).toHaveLength(1)
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("rolls back session rename when event publication fails", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-rename-rollback")
      const branchId = BranchId.make("branch-rename-rollback")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "before",
      })

      const exit = yield* Effect.exit(mutations.renameSession({ sessionId, name: "after" }))

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.name).toBe("before")
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("rolls back active branch switch when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-switch-rollback")
      const fromBranchId = BranchId.make("branch-switch-from")
      const toBranchId = BranchId.make("branch-switch-to")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: fromBranchId,
        now,
        name: "switch",
      })
      yield* branches.createBranch(new Branch({ id: toBranchId, sessionId, createdAt: now }))

      const exit = yield* Effect.exit(
        commands.switchBranch({
          sessionId,
          fromBranchId,
          toBranchId,
          summarize: false,
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(fromBranchId)
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("rejects active branch switch to a branch outside the session", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-switch-owner")
      const otherSessionId = SessionId.make("session-switch-other")
      const fromBranchId = BranchId.make("branch-switch-owner-from")
      const toBranchId = BranchId.make("branch-switch-owner-foreign")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: fromBranchId,
        now,
        name: "switch owner",
      })
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId: otherSessionId,
        branchId: toBranchId,
        now,
        name: "other",
      })

      const exit = yield* Effect.exit(
        mutations.switchActiveBranch({
          sessionId,
          fromBranchId,
          toBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("NotFoundError")
      }
      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(fromBranchId)
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("rolls back reasoning setting when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-settings-rollback")
      const branchId = BranchId.make("branch-settings-rollback")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "settings",
      })

      const exit = yield* Effect.exit(
        commands.updateSessionReasoningLevel({ sessionId, reasoningLevel: "high" }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.reasoningLevel).toBeUndefined()
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("deletes only non-active branches owned by the session", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-delete-branch")
      const activeBranchId = BranchId.make("branch-delete-active")
      const deletedBranchId = BranchId.make("branch-delete-target")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: activeBranchId,
        now,
        name: "delete branch",
      })
      yield* branches.createBranch(new Branch({ id: deletedBranchId, sessionId, createdAt: now }))

      yield* mutations.deleteBranch({
        sessionId,
        currentBranchId: activeBranchId,
        branchId: deletedBranchId,
      })

      expect(yield* branches.getBranch(deletedBranchId)).toBeUndefined()
      expect(yield* branches.getBranch(activeBranchId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("rejects session creation with parent branch but no parent session", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage

      const exit = yield* Effect.exit(
        commands.createSession({
          parentBranchId: BranchId.make("dangling-parent-branch"),
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions()).toHaveLength(0)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("rejects deleting a branch with child branches", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-delete-parent-branch")
      const activeBranchId = BranchId.make("branch-delete-parent-active")
      const parentBranchId = BranchId.make("branch-delete-parent")
      const childBranchId = BranchId.make("branch-delete-child")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: activeBranchId,
        now,
        name: "delete parent branch",
      })
      yield* branches.createBranch(new Branch({ id: parentBranchId, sessionId, createdAt: now }))
      yield* branches.createBranch(
        new Branch({
          id: childBranchId,
          sessionId,
          parentBranchId,
          createdAt: now,
        }),
      )

      const exit = yield* Effect.exit(
        mutations.deleteBranch({
          sessionId,
          currentBranchId: activeBranchId,
          branchId: parentBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("InvalidStateError")
      }
      expect(yield* branches.getBranch(parentBranchId)).toBeDefined()
      expect(yield* branches.getBranch(childBranchId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("rejects deleting a branch with child sessions", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-delete-child-session-parent")
      const activeBranchId = BranchId.make("branch-delete-child-session-active")
      const parentBranchId = BranchId.make("branch-delete-child-session-parent")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: activeBranchId,
        now,
        name: "delete child session parent",
      })
      yield* branches.createBranch(new Branch({ id: parentBranchId, sessionId, createdAt: now }))
      const child = yield* mutations.createChildSession({
        parentSessionId: sessionId,
        parentBranchId,
        name: "child",
      })

      const exit = yield* Effect.exit(
        mutations.deleteBranch({
          sessionId,
          currentBranchId: activeBranchId,
          branchId: parentBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("InvalidStateError")
      }
      expect(yield* branches.getBranch(parentBranchId)).toBeDefined()
      expect(yield* sessions.getSession(child.sessionId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("rejects deleting the active branch even when it is not the caller branch", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-delete-active")
      const activeBranchId = BranchId.make("branch-active-delete")
      const currentBranchId = BranchId.make("branch-current-delete")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: activeBranchId,
        now,
        name: "delete active",
      })
      yield* branches.createBranch(new Branch({ id: currentBranchId, sessionId, createdAt: now }))

      const exit = yield* Effect.exit(
        mutations.deleteBranch({
          sessionId,
          currentBranchId,
          branchId: activeBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("InvalidStateError")
      }
      expect(yield* branches.getBranch(activeBranchId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("rejects destructive branch mutation across sessions", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const ownerSessionId = SessionId.make("session-delete-owner")
      const otherSessionId = SessionId.make("session-delete-other")
      const currentBranchId = BranchId.make("branch-delete-owner-current")
      const otherBranchId = BranchId.make("branch-delete-other-target")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId: ownerSessionId,
        branchId: currentBranchId,
        now,
        name: "owner",
      })
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId: otherSessionId,
        branchId: otherBranchId,
        now,
        name: "other",
      })

      const exit = yield* Effect.exit(
        mutations.deleteBranch({
          sessionId: ownerSessionId,
          currentBranchId,
          branchId: otherBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("NotFoundError")
      }
      expect(yield* branches.getBranch(otherBranchId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("deleteMessages only mutates branches owned by the session", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("session-delete-messages")
      const branchId = BranchId.make("branch-delete-messages")
      const firstMessageId = MessageId.make("message-delete-1")
      const secondMessageId = MessageId.make("message-delete-2")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "delete messages",
      })
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: firstMessageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "first" })],
          createdAt: now,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: secondMessageId,
          sessionId,
          branchId,
          role: "assistant",
          parts: [Prompt.textPart({ text: "second" })],
          createdAt: datePlusMillis(now, 1),
        }),
      )

      yield* mutations.deleteMessages({ sessionId, branchId, afterMessageId: firstMessageId })

      const remaining = yield* messages.listMessages(branchId)
      expect(remaining.map((message) => message.id)).toEqual([firstMessageId])
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("deleteMessages rejects a cursor from another session", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("session-delete-messages-owner")
      const branchId = BranchId.make("branch-delete-messages-owner")
      const otherSessionId = SessionId.make("session-delete-messages-other")
      const otherBranchId = BranchId.make("branch-delete-messages-other")
      const foreignMessageId = MessageId.make("message-delete-foreign")
      const ownerMessageId = MessageId.make("message-delete-owner")
      const now = FIXED_NOW

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "owner",
      })
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId: otherSessionId,
        branchId: otherBranchId,
        now,
        name: "other",
      })
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: foreignMessageId,
          sessionId: otherSessionId,
          branchId: otherBranchId,
          role: "user",
          parts: [Prompt.textPart({ text: "foreign" })],
          createdAt: now,
        }),
      )
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: ownerMessageId,
          sessionId,
          branchId,
          role: "assistant",
          parts: [Prompt.textPart({ text: "owner" })],
          createdAt: datePlusMillis(now, 1),
        }),
      )

      const exit = yield* Effect.exit(
        mutations.deleteMessages({ sessionId, branchId, afterMessageId: foreignMessageId }),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("NotFoundError")
      }
      expect((yield* messages.listMessages(branchId)).map((message) => message.id)).toEqual([
        ownerMessageId,
      ])
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )
})
