import { describe, expect, it } from "effect-bun-test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Cause, Effect, Logger, Option } from "effect"
import { BranchId, MessageId, SessionId } from "../../src/domain/ids"
import { Branch, Message } from "../../src/domain/message"
import { SessionRuntimeError } from "../../src/runtime/session"
import { BranchStorage, MessageStorage, SessionStorage } from "../../src/storage/storage"
import { SessionMutations } from "../../src/domain/extension"
import type { ModelId } from "../../src/domain/agent"
import {
  FIXED_NOW,
  createActiveSessionFixture,
  failingSessionMutationsLayer,
  makeRpcHandlersClient,
  sessionMutationsLayer,
} from "./session-mutations/helpers"

const absentModel = Option.getOrUndefined(Option.none<ModelId>())

describe("session command persistence", () => {
  it.live("message.send surfaces runtime failure and does not log message sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const logMessages: string[] = []
        const captureLogger = Logger.make(({ message }) => {
          let rendered = String(message)
          if (Array.isArray(message)) rendered = message.map((entry) => String(entry)).join(" ")
          logMessages.push(rendered)
        })
        const { client, inWorkspace } = yield* makeRpcHandlersClient(
          {
            sendUserMessage: () =>
              Effect.fail(new SessionRuntimeError({ message: "runtime failed" })),
          },
          Logger.layer([captureLogger]),
        )

        const exit = yield* Effect.exit(
          inWorkspace(
            client["message.send"]({
              sessionId: SessionId.make("send-runtime-failure"),
              branchId: BranchId.make("send-runtime-failure-branch"),
              content: "fail loudly",
            }),
          ),
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
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("rolls back session and branch creation when event publication fails", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage

      const exit = yield* Effect.exit(mutations.createSession({ cwd: "/tmp/rollback" }))

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions).toHaveLength(0)
      expect(yield* branches.listBranches(SessionId.make("missing"))).toHaveLength(0)
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("rolls back forked branch and copied messages when event publication fails", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
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
        mutations.forkSessionBranch({
          sessionId,
          fromBranchId: branchId,
          atMessageId: messageId,
          name: "fork",
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* branches.listBranches(sessionId)).toHaveLength(1)
      expect(yield* messages.listMessages(branchId)).toHaveLength(1)
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
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
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("rolls back active branch switch when event publication fails", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
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
        mutations.switchActiveBranch({
          sessionId,
          fromBranchId,
          toBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(fromBranchId)
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
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
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("rolls back reasoning setting when event publication fails", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
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
        mutations.updateSettings({ sessionId, modelId: absentModel, reasoningLevel: "high" }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.reasoningLevel).toBeUndefined()
    }).pipe(Effect.provide(failingSessionMutationsLayer), Effect.timeout("4 seconds")),
  )

  it.live("rejects session creation with parent branch but no parent session", () =>
    Effect.gen(function* () {
      const mutations = yield* SessionMutations
      const sessions = yield* SessionStorage

      const exit = yield* Effect.exit(
        mutations.createSession({
          parentBranchId: BranchId.make("dangling-parent-branch"),
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions).toHaveLength(0)
    }).pipe(Effect.provide(sessionMutationsLayer), Effect.timeout("4 seconds")),
  )
})
