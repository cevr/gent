import { describe, expect, it } from "effect-bun-test"
import { Effect, Struct } from "effect"
import { DelegateTool } from "../../src/delegate/delegate-tool.js"
import { BranchId, RequestId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { runToolWithCtx, testToolContext } from "@gent/core-internal/test-utils"
import { AllBuiltinAgents } from "../helpers/builtin-agents.js"

describe("DelegateTool background mode", () => {
  it.live("admits a durable child under the tool call id and returns its handle", () =>
    Effect.gen(function* () {
      const started: Array<{ requestId: RequestId; prompt: string }> = []
      const ctx = testToolContext({
        toolCallId: ToolCallId.make("delegate-call"),
        Agent: {
          listAgents: Effect.succeed(AllBuiltinAgents),
          start: (params) =>
            Effect.sync(() => {
              started.push({ requestId: params.requestId, prompt: params.prompt })
              return {
                sessionId: SessionId.make("child-session"),
                branchId: BranchId.make("child-branch"),
              }
            }),
        },
      })
      const result = yield* runToolWithCtx(
        DelegateTool,
        { todo: "analyze the codebase", background: true },
        ctx,
      )
      // The handle returns now. The result arrives later as a message on the parent branch.
      expect(result).toEqual({
        requestId: RequestId.make("delegate-call"),
        sessionId: SessionId.make("child-session"),
        branchId: BranchId.make("child-branch"),
        status: "running",
      })
      expect(started).toEqual([
        { requestId: RequestId.make("delegate-call"), prompt: "analyze the codebase" },
      ])
    }),
  )

  it.live("refuses background delegation without a host-owned tool call", () =>
    Effect.gen(function* () {
      const ctx = Struct.omit(
        testToolContext({ Agent: { listAgents: Effect.succeed(AllBuiltinAgents) } }),
        ["toolCallId"],
      )
      const error = yield* runToolWithCtx(
        DelegateTool,
        { todo: "analyze the codebase", background: true },
        ctx,
      ).pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "AgentRunError",
        message: "Background delegation requires a host-owned tool call",
      })
    }),
  )
})
