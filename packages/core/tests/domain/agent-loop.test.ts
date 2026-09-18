import { describe, expect, it, test } from "effect-bun-test"
import { Effect } from "effect"
import { entityIdOf, foldSessionMetrics, parseEntityId } from "../../src/domain/agent-loop"
import { BranchId, MessageId, SessionId } from "../../src/domain/ids"
import { DefaultWorkspaceId, WorkspaceId } from "../../src/server/workspace-rpc"
import { AgentEvent } from "../../src/domain/event"
import { ModelId } from "../../src/domain/agent"

// ── ../runtime/agent/agent-loop.entity-id.test ──────────────────────────────

const cases: ReadonlyArray<{ readonly session: string; readonly branch: string }> = [
  { session: "session-a", branch: "branch-main" },
  // Pairs that would collide under naive `${session}:${branch}` encoding.
  { session: "a:", branch: "x" },
  { session: "a", branch: ":x" },
  // Slash and percent — legal in branded strings, must round-trip.
  { session: "a/b", branch: "c%d" },
  // Empty branch is legal (branded String has no length lower bound).
  { session: "lone-session", branch: "" },
]

describe("agent-loop.entity-id", () => {
  it.effect("encode + parse round-trips for all cases", () =>
    Effect.gen(function* () {
      for (const { session, branch } of cases) {
        const sid = SessionId.make(session)
        const bid = BranchId.make(branch)
        const encoded = entityIdOf(DefaultWorkspaceId, sid, bid)
        const decoded = yield* parseEntityId(encoded)
        expect(decoded.workspaceId).toBe(DefaultWorkspaceId)
        expect(decoded.sessionId).toBe(sid)
        expect(decoded.branchId).toBe(bid)
      }
    }),
  )

  test("does not collide on tricky pairs", () => {
    const a = entityIdOf(DefaultWorkspaceId, SessionId.make("a:"), BranchId.make("x"))
    const b = entityIdOf(DefaultWorkspaceId, SessionId.make("a"), BranchId.make(":x"))
    expect(a).not.toBe(b)
  })

  test("does not collide across workspaces", () => {
    const a = entityIdOf(
      WorkspaceId.make("a".repeat(64)),
      SessionId.make("same"),
      BranchId.make("same"),
    )
    const b = entityIdOf(
      WorkspaceId.make("b".repeat(64)),
      SessionId.make("same"),
      BranchId.make("same"),
    )
    expect(a).not.toBe(b)
  })

  it.effect("rejects entity ids with no separator", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parseEntityId("no-separator"))
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("rejects entity ids with malformed percent encoding", () =>
    Effect.gen(function* () {
      // `%ZZ` is not a valid percent-encoding; decodeURIComponent throws.
      const exit = yield* Effect.exit(parseEntityId("%ZZ:x"))
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("rejects workspace ids that do not satisfy the workspace schema", () =>
    Effect.gen(function* () {
      const encoded = `${"g".repeat(64)}:session:branch`
      const exit = yield* Effect.exit(parseEntityId(encoded))
      expect(exit._tag).toBe("Failure")
    }),
  )
})

// ── ../runtime/agent-loop/session-metrics-fold.test ─────────────────────────

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
