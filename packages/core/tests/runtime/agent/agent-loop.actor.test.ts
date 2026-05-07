import { describe, it, expect } from "effect-bun-test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Effect, Schema } from "effect"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop.actor"
import {
  ActorCommandId,
  BranchId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "@gent/core/domain/ids"
import { dateFromMillis, Message } from "@gent/core/domain/message"
import { SteerCommand } from "@gent/core/domain/steer"
import { DefaultWorkspaceId } from "@gent/core/server/workspace-rpc"

const sessionA = SessionId.make("session-a")
const sessionB = SessionId.make("session-b")
const branchMain = BranchId.make("branch-main")
const branchSecond = BranchId.make("branch-second")
const messageOne = MessageId.make("msg-1")
const messageTwo = MessageId.make("msg-2")
const cmdAlpha = ActorCommandId.make("cmd-alpha")
const cmdBeta = ActorCommandId.make("cmd-beta")

const fixedNow = dateFromMillis(1_767_225_600_000)
const entity = (sessionId: string, branchId: string) =>
  `${DefaultWorkspaceId}:${sessionId}:${branchId}`

const userMessage = (params: { id: MessageId; sessionId: SessionId; branchId: BranchId }) =>
  Message.Regular.make({
    id: params.id,
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "user",
    parts: [Prompt.textPart({ text: "hi" })],
    createdAt: fixedNow,
    isPartial: false,
    transient: false,
    metadata: undefined,
  })

const submitPayload = (params: { id: MessageId; sessionId: SessionId; branchId: BranchId }) => ({
  workspaceId: DefaultWorkspaceId,
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
  workspaceId: DefaultWorkspaceId,
  commandId: params.commandId,
  command: cancelCommand(params.sessionId, params.branchId),
})

const interruptPayload = (params: {
  sessionId: SessionId
  branchId: BranchId
  commandId: ActorCommandId
}) => ({ ...params, workspaceId: DefaultWorkspaceId })

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
      expect(String(exec1)).toBe(`${entity("session-a", "branch-main")}\x00Submit\x00msg-1`)
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
      expect(String(submitExec)).toBe(`${entity("session-a", "branch-main")}\x00Submit\x00msg-1`)
      expect(String(followUpExec)).toBe(
        `${entity("session-a", "branch-main")}\x00QueueFollowUp\x00msg-1`,
      )
    }),
  )

  it.effect("Submit and Run do not collide despite identical payload", () =>
    Effect.gen(function* () {
      const submitExec = yield* AgentLoop.Submit.executionId(
        submitPayload({ id: messageOne, sessionId: sessionA, branchId: branchMain }),
      )
      const runExec = yield* AgentLoop.Run.executionId(
        submitPayload({ id: messageOne, sessionId: sessionA, branchId: branchMain }),
      )

      expect(submitExec).not.toBe(runExec)
      expect(String(runExec)).toBe(`${entity("session-a", "branch-main")}\x00Run\x00msg-1`)
    }),
  )

  it.effect("Submit routes identical session and branch ids to distinct workspace mailboxes", () =>
    Effect.gen(function* () {
      const workspaceA = "a".repeat(64)
      const workspaceB = "b".repeat(64)
      const payload = submitPayload({ id: messageOne, sessionId: sessionA, branchId: branchMain })
      const execA = yield* AgentLoop.Submit.executionId({
        ...payload,
        workspaceId: workspaceA,
      })
      const execB = yield* AgentLoop.Submit.executionId({
        ...payload,
        workspaceId: workspaceB,
      })

      expect(execA).not.toBe(execB)
      expect(String(execA)).toBe(`${workspaceA}:session-a:branch-main\x00Submit\x00msg-1`)
      expect(String(execB)).toBe(`${workspaceB}:session-a:branch-main\x00Submit\x00msg-1`)
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
      expect(String(execAlpha)).toBe(`${entity("session-a", "branch-main")}\x00Steer\x00cmd-alpha`)
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
      expect(String(execAlpha)).toBe(
        `${entity("session-a", "branch-main")}\x00Interrupt\x00cmd-alpha`,
      )
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

  it.effect("RespondInteraction dedup keys by requestId", () =>
    Effect.gen(function* () {
      const reqOne = InteractionRequestId.make("req-one")
      const reqTwo = InteractionRequestId.make("req-two")
      const execOne = yield* AgentLoop.RespondInteraction.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
        requestId: reqOne,
      })
      const execOneAgain = yield* AgentLoop.RespondInteraction.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
        requestId: reqOne,
      })
      const execTwo = yield* AgentLoop.RespondInteraction.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
        requestId: reqTwo,
      })

      expect(execOne).toBe(execOneAgain)
      expect(execOne).not.toBe(execTwo)
      expect(String(execOne)).toBe(
        `${entity("session-a", "branch-main")}\x00RespondInteraction\x00req-one`,
      )
    }),
  )

  it.effect("DrainQueue dedup keys by commandId", () =>
    Effect.gen(function* () {
      const execAlpha = yield* AgentLoop.DrainQueue.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
        commandId: cmdAlpha,
      })
      const execAlphaAgain = yield* AgentLoop.DrainQueue.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
        commandId: cmdAlpha,
      })
      const execBeta = yield* AgentLoop.DrainQueue.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
        commandId: cmdBeta,
      })

      expect(execAlpha).toBe(execAlphaAgain)
      expect(execAlpha).not.toBe(execBeta)
      expect(String(execAlpha)).toBe(
        `${entity("session-a", "branch-main")}\x00DrainQueue\x00cmd-alpha`,
      )
    }),
  )

  it.effect("GetQueue uses a stable branch-local read key", () =>
    Effect.gen(function* () {
      const execMain = yield* AgentLoop.GetQueue.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
      })
      const execMainAgain = yield* AgentLoop.GetQueue.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
      })
      const execOtherBranch = yield* AgentLoop.GetQueue.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchSecond,
      })

      expect(execMain).toBe(execMainAgain)
      expect(execMain).not.toBe(execOtherBranch)
      expect(String(execMain)).toBe(
        `${entity("session-a", "branch-main")}\x00GetQueue\x00get-queue`,
      )
    }),
  )

  it.effect("GetState uses a stable branch-local read key", () =>
    Effect.gen(function* () {
      const execMain = yield* AgentLoop.GetState.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
      })
      const execMainAgain = yield* AgentLoop.GetState.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
      })
      const execOtherBranch = yield* AgentLoop.GetState.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchSecond,
      })

      expect(execMain).toBe(execMainAgain)
      expect(execMain).not.toBe(execOtherBranch)
      expect(String(execMain)).toBe(
        `${entity("session-a", "branch-main")}\x00GetState\x00get-state`,
      )
    }),
  )

  it.effect("RecordToolResult dedup keys by toolCallId", () =>
    Effect.gen(function* () {
      const callA = ToolCallId.make("tool-call-a")
      const callB = ToolCallId.make("tool-call-b")
      const recordPayload = (toolCallId: ToolCallId) => ({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
        commandId: undefined,
        toolCallId,
        toolName: "echo",
        output: { ok: true },
        isError: undefined,
      })
      const execA = yield* AgentLoop.RecordToolResult.executionId(recordPayload(callA))
      const execAAgain = yield* AgentLoop.RecordToolResult.executionId(recordPayload(callA))
      const execB = yield* AgentLoop.RecordToolResult.executionId(recordPayload(callB))
      expect(execA).toBe(execAAgain)
      expect(execA).not.toBe(execB)
      expect(String(execA)).toBe(
        `${entity("session-a", "branch-main")}\x00RecordToolResult\x00tool-call-a`,
      )
    }),
  )

  it.effect("InvokeTool dedup keys by commandId", () =>
    Effect.gen(function* () {
      const execAlpha = yield* AgentLoop.InvokeTool.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
        commandId: cmdAlpha,
        toolName: "echo",
        input: { text: "hi" },
      })
      const execAlphaAgain = yield* AgentLoop.InvokeTool.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
        commandId: cmdAlpha,
        toolName: "echo",
        input: { text: "different input still dedups by cmd" },
      })
      const execBeta = yield* AgentLoop.InvokeTool.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
        commandId: cmdBeta,
        toolName: "echo",
        input: { text: "hi" },
      })
      expect(execAlpha).toBe(execAlphaAgain)
      expect(execAlpha).not.toBe(execBeta)
      expect(String(execAlpha)).toBe(
        `${entity("session-a", "branch-main")}\x00InvokeTool\x00cmd-alpha`,
      )
    }),
  )

  it.effect("RespondInteraction and Steer with related ids do not collide (different tags)", () =>
    Effect.gen(function* () {
      const respondExec = yield* AgentLoop.RespondInteraction.executionId({
        workspaceId: DefaultWorkspaceId,
        sessionId: sessionA,
        branchId: branchMain,
        requestId: InteractionRequestId.make("cmd-alpha"),
      })
      const steerExec = yield* AgentLoop.Steer.executionId(
        steerPayload({ sessionId: sessionA, branchId: branchMain, commandId: cmdAlpha }),
      )
      // Same primaryKey string but different tags → different ExecIds.
      expect(respondExec).not.toBe(steerExec)
    }),
  )
})
