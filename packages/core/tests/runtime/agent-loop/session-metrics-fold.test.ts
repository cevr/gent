import { describe, expect, test } from "bun:test"
import { AgentEvent } from "../../../src/domain/event"
import { BranchId, MessageId, SessionId } from "../../../src/domain/ids"
import { ModelId } from "../../../src/domain/model"
import { foldSessionMetrics } from "../../../src/runtime/agent/agent-loop.state"

const sessionId = SessionId.make("s")
const branchId = BranchId.make("b")
const wrap = (event: AgentEvent) => ({ event })

describe("session metrics fold", () => {
  test("turns, cost, last input, and the newest context projection add up", () => {
    const metrics = foldSessionMetrics([
      wrap(
        AgentEvent.cases.StreamEnded.make({
          sessionId,
          branchId,
          usage: { inputTokens: 100, outputTokens: 10 },
          costUsd: 0.5,
          model: ModelId.make("test/m"),
          outcome: "ToolCalls",
        }),
      ),
      wrap(
        AgentEvent.cases.ModelContextProjected.make({
          sessionId,
          branchId,
          estimatedTokens: 90,
          availableInputTokens: 1_000,
          contextLimitTokens: 1_100,
          omittedMessages: 0,
          compacted: true,
          handoffMessageId: MessageId.make("context-handoff:b:m"),
        }),
      ),
      wrap(
        AgentEvent.cases.StreamEnded.make({
          sessionId,
          branchId,
          usage: { inputTokens: 40, outputTokens: 4 },
          costUsd: 0.25,
          outcome: "Answered",
        }),
      ),
      wrap(AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 1_500 })),
    ])
    expect(metrics).toEqual({
      turns: 1,
      durationMs: 1_500,
      costUsd: 0.75,
      lastInputTokens: 40,
      context: {
        estimatedTokens: 90,
        availableInputTokens: 1_000,
        contextLimitTokens: 1_100,
        omittedMessages: 0,
        handoffMessageId: MessageId.make("context-handoff:b:m"),
        compactions: 1,
      },
    })
  })

  test("a branch with no projection carries no context block", () => {
    expect(foldSessionMetrics([])).toEqual({
      turns: 0,
      durationMs: 0,
      costUsd: 0,
      lastInputTokens: 0,
    })
  })
})
