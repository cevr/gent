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

const userMessage = (params: { id: MessageId; sessionId: SessionId; branchId: BranchId }) =>
  Message.Regular.make({
    id: params.id,
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "user",
    parts: [new TextPart({ type: "text", text: "hi" })],
    createdAt: fixedNow,
    isPartial: false,
    transient: false,
    metadata: undefined,
  })

const submitPayload = (params: { id: MessageId; sessionId: SessionId; branchId: BranchId }) => ({
  message: userMessage(params),
  agentOverride: undefined,
  runSpec: undefined,
  interactive: undefined,
})

const cancelCommand = (sessionId: SessionId, branchId: BranchId) =>
  Schema.decodeSync(SteerCommand)({ _tag: "Cancel", sessionId, branchId })

const steerPayload = (params: {
  sessionId: SessionId
  branchId: BranchId
  commandId: ActorCommandId
}) => ({
  commandId: params.commandId,
  command: cancelCommand(params.sessionId, params.branchId),
})

const interruptPayload = (params: {
  sessionId: SessionId
  branchId: BranchId
  commandId: ActorCommandId
}) => params

describe("AgentLoop actor identity", () => {
  it.effect("Submit dedup keys by message id, mailboxes by message (sessionId, branchId)", () =>
    Effect.gen(function* () {
      const exec1 = yield* AgentLoop.Submit.executionId(
        submitPayload({ id: messageOne, sessionId: sessionA, branchId: branchMain }),
      )
      const exec1Again = yield* AgentLoop.Submit.executionId(
        submitPayload({ id: messageOne, sessionId: sessionA, branchId: branchMain }),
      )
      const exec2 = yield* AgentLoop.Submit.executionId(
        submitPayload({ id: messageTwo, sessionId: sessionA, branchId: branchMain }),
      )
      const execOtherBranch = yield* AgentLoop.Submit.executionId(
        submitPayload({ id: messageOne, sessionId: sessionA, branchId: branchSecond }),
      )
      const execOtherSession = yield* AgentLoop.Submit.executionId(
        submitPayload({ id: messageOne, sessionId: sessionB, branchId: branchMain }),
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
        submitPayload({ id: messageOne, sessionId: sessionA, branchId: branchMain }),
      )
      const followUpExec = yield* AgentLoop.QueueFollowUp.executionId(
        submitPayload({ id: messageOne, sessionId: sessionA, branchId: branchMain }),
      )

      // Same entityId + primaryKey but different tag → distinct ExecId.
      expect(submitExec).not.toBe(followUpExec)
      expect(String(submitExec)).toBe(`session-a:branch-main\x00Submit\x00msg-1`)
      expect(String(followUpExec)).toBe(`session-a:branch-main\x00QueueFollowUp\x00msg-1`)
    }),
  )

  it.effect("Steer routes via command target, dedups by commandId", () =>
    Effect.gen(function* () {
      const execAlpha = yield* AgentLoop.Steer.executionId(
        steerPayload({ sessionId: sessionA, branchId: branchMain, commandId: cmdAlpha }),
      )
      const execAlphaAgain = yield* AgentLoop.Steer.executionId(
        steerPayload({ sessionId: sessionA, branchId: branchMain, commandId: cmdAlpha }),
      )
      const execBeta = yield* AgentLoop.Steer.executionId(
        steerPayload({ sessionId: sessionA, branchId: branchMain, commandId: cmdBeta }),
      )
      const execOtherBranch = yield* AgentLoop.Steer.executionId(
        steerPayload({ sessionId: sessionA, branchId: branchSecond, commandId: cmdAlpha }),
      )

      expect(execAlpha).toBe(execAlphaAgain)
      expect(execAlpha).not.toBe(execBeta)
      expect(execAlpha).not.toBe(execOtherBranch)
      expect(String(execAlpha)).toBe(`session-a:branch-main\x00Steer\x00cmd-alpha`)
    }),
  )

  it.effect("Interrupt dedup keys by commandId", () =>
    Effect.gen(function* () {
      const execAlpha = yield* AgentLoop.Interrupt.executionId(
        interruptPayload({ sessionId: sessionA, branchId: branchMain, commandId: cmdAlpha }),
      )
      const execBeta = yield* AgentLoop.Interrupt.executionId(
        interruptPayload({ sessionId: sessionA, branchId: branchMain, commandId: cmdBeta }),
      )

      expect(execAlpha).not.toBe(execBeta)
      expect(String(execAlpha)).toBe(`session-a:branch-main\x00Interrupt\x00cmd-alpha`)
    }),
  )

  it.effect("Steer and Interrupt with same commandId do not collide (different tags)", () =>
    Effect.gen(function* () {
      const steerExec = yield* AgentLoop.Steer.executionId(
        steerPayload({ sessionId: sessionA, branchId: branchMain, commandId: cmdAlpha }),
      )
      const interruptExec = yield* AgentLoop.Interrupt.executionId(
        interruptPayload({ sessionId: sessionA, branchId: branchMain, commandId: cmdAlpha }),
      )
      expect(steerExec).not.toBe(interruptExec)
    }),
  )
})
