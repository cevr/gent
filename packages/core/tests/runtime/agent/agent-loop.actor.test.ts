import { describe, it, expect } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop.actor"
import { ActorCommandId, BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { dateFromMillis, Message, TextPart } from "@gent/core/domain/message"
import { SteerCommand } from "@gent/core/domain/steer"

const sessionA = SessionId.make("session-a")
const sessionB = SessionId.make("session-b")
const branchMain = BranchId.make("branch-main")
const branchSecond = BranchId.make("branch-second")
const messageOne = MessageId.make("msg-1")
const messageTwo = MessageId.make("msg-2")
const cmdAlpha = ActorCommandId.make("cmd-alpha")
const cmdBeta = ActorCommandId.make("cmd-beta")

const fixedNow = dateFromMillis(1_767_225_600_000)

const userMessage = (id: MessageId): Message =>
  Message.Regular.make({
    id,
    sessionId: sessionA,
    branchId: branchMain,
    role: "user",
    parts: [new TextPart({ type: "text", text: "hi" })],
    createdAt: fixedNow,
    isPartial: false,
    transient: false,
    metadata: undefined,
  })

const submitPayload = (sessionId: SessionId, branchId: BranchId, messageId: MessageId) => ({
  sessionId,
  branchId,
  message: userMessage(messageId),
  agentOverride: undefined,
  runSpec: undefined,
  interactive: undefined,
})

const cancelCommand = (sessionId: SessionId, branchId: BranchId) =>
  Schema.decodeSync(SteerCommand)({ _tag: "Cancel", sessionId, branchId })

const steerPayload = (sessionId: SessionId, branchId: BranchId, commandId: ActorCommandId) => ({
  sessionId,
  branchId,
  commandId,
  command: cancelCommand(sessionId, branchId),
})

const interruptPayload = (sessionId: SessionId, branchId: BranchId, commandId: ActorCommandId) => ({
  sessionId,
  branchId,
  commandId,
})

describe("AgentLoop actor identity", () => {
  it.effect("Submit dedup keys by message id, mailboxes by (sessionId, branchId)", () =>
    Effect.gen(function* () {
      const exec1 = yield* AgentLoop.Submit.executionId(
        submitPayload(sessionA, branchMain, messageOne),
      )
      const exec1Again = yield* AgentLoop.Submit.executionId(
        submitPayload(sessionA, branchMain, messageOne),
      )
      const exec2 = yield* AgentLoop.Submit.executionId(
        submitPayload(sessionA, branchMain, messageTwo),
      )
      const execOtherBranch = yield* AgentLoop.Submit.executionId(
        submitPayload(sessionA, branchSecond, messageOne),
      )
      const execOtherSession = yield* AgentLoop.Submit.executionId(
        submitPayload(sessionB, branchMain, messageOne),
      )

      // Same payload → same ExecId (dedup).
      expect(exec1).toBe(exec1Again)

      // Different message → different ExecId.
      expect(exec1).not.toBe(exec2)

      // Different branch → different ExecId.
      expect(exec1).not.toBe(execOtherBranch)

      // Different session → different ExecId.
      expect(exec1).not.toBe(execOtherSession)

      // ExecId format: `entityId\x00tag\x00primaryKey`.
      expect(String(exec1)).toBe(`session-a:branch-main\x00Submit\x00msg-1`)
    }),
  )

  it.effect("Submit and QueueFollowUp do not collide despite identical payload", () =>
    Effect.gen(function* () {
      const submitExec = yield* AgentLoop.Submit.executionId(
        submitPayload(sessionA, branchMain, messageOne),
      )
      const followUpExec = yield* AgentLoop.QueueFollowUp.executionId(
        submitPayload(sessionA, branchMain, messageOne),
      )

      // Same entityId + primaryKey but different tag → distinct ExecId.
      expect(submitExec).not.toBe(followUpExec)
      expect(String(submitExec)).toBe(`session-a:branch-main\x00Submit\x00msg-1`)
      expect(String(followUpExec)).toBe(`session-a:branch-main\x00QueueFollowUp\x00msg-1`)
    }),
  )

  it.effect("Steer dedup keys by commandId", () =>
    Effect.gen(function* () {
      const execAlpha = yield* AgentLoop.Steer.executionId(
        steerPayload(sessionA, branchMain, cmdAlpha),
      )
      const execAlphaAgain = yield* AgentLoop.Steer.executionId(
        steerPayload(sessionA, branchMain, cmdAlpha),
      )
      const execBeta = yield* AgentLoop.Steer.executionId(
        steerPayload(sessionA, branchMain, cmdBeta),
      )

      expect(execAlpha).toBe(execAlphaAgain)
      expect(execAlpha).not.toBe(execBeta)
      expect(String(execAlpha)).toBe(`session-a:branch-main\x00Steer\x00cmd-alpha`)
    }),
  )

  it.effect("Interrupt dedup keys by commandId", () =>
    Effect.gen(function* () {
      const execAlpha = yield* AgentLoop.Interrupt.executionId(
        interruptPayload(sessionA, branchMain, cmdAlpha),
      )
      const execBeta = yield* AgentLoop.Interrupt.executionId(
        interruptPayload(sessionA, branchMain, cmdBeta),
      )

      expect(execAlpha).not.toBe(execBeta)
      expect(String(execAlpha)).toBe(`session-a:branch-main\x00Interrupt\x00cmd-alpha`)
    }),
  )
})
