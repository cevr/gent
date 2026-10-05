import { describe, expect, it, test } from "effect-bun-test"
import { Effect } from "effect"
import {
  entityIdOf,
  foldSessionMetrics,
  parseEntityId,
  stepSessionMetrics,
} from "../../src/domain/agent-loop"
import {
  BranchId,
  MessageId,
  SessionId,
  DefaultWorkspaceId,
  WorkspaceId,
} from "../../src/domain/ids"
import { AgentEvent } from "../../src/domain/event"
import { ModelId, ProviderId } from "../../src/domain/agent"
import { CredentialSlot } from "../../src/domain/driver"

// ── entity id ───────────────────────────────────────────────────────────────

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

// ── session metrics fold ────────────────────────────────────────────────────

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
      lastCredential: { model: ModelId.make("test/m") },
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

  test("the newest ended step's credential is the last one used; an old row's reads as unknown", () => {
    const unknown = wrap(
      AgentEvent.cases.StreamEnded.make({
        sessionId,
        branchId,
        model: ModelId.make("anthropic/claude-sonnet-5-5"),
        outcome: "Answered",
      }),
    )
    const personal = wrap(
      AgentEvent.cases.StreamEnded.make({
        sessionId,
        branchId,
        model: ModelId.make("anthropic/claude-sonnet-5-5"),
        outcome: "Answered",
        credential: {
          provider: ProviderId.make("anthropic"),
          slot: CredentialSlot.make("personal"),
        },
      }),
    )
    expect(foldSessionMetrics([]).lastCredential).toBeUndefined()
    expect(foldSessionMetrics([personal]).lastCredential).toEqual({
      model: ModelId.make("anthropic/claude-sonnet-5-5"),
      receipt: { provider: ProviderId.make("anthropic"), slot: CredentialSlot.make("personal") },
    })
    // A row written before receipts names its model, not its credential.
    expect(foldSessionMetrics([personal, unknown]).lastCredential).toEqual({
      model: ModelId.make("anthropic/claude-sonnet-5-5"),
    })
    // A step that ended with no model (a failed request) leaves the last one.
    const failed = wrap(
      AgentEvent.cases.StreamEnded.make({ sessionId, branchId, interrupted: true }),
    )
    expect(foldSessionMetrics([personal, failed]).lastCredential?.receipt?.slot).toBe(
      CredentialSlot.make("personal"),
    )
  })

  test("a projection's input count waits for its own step, so a model switch never mixes windows", () => {
    const projected = (contextLimitTokens: number) =>
      wrap(
        AgentEvent.cases.ModelContextProjected.make({
          sessionId,
          branchId,
          estimatedTokens: 5_000,
          availableInputTokens: contextLimitTokens - 5_000,
          contextLimitTokens,
          omittedMessages: 0,
          compacted: false,
        }),
      )
    const ended = (inputTokens: number) =>
      wrap(
        AgentEvent.cases.StreamEnded.make({
          sessionId,
          branchId,
          usage: { inputTokens, outputTokens: 1 },
          outcome: "Answered",
        }),
      )
    // The old model's step reported 150k of its 200k window.
    const before = [projected(200_000), ended(150_000)]
    expect(foldSessionMetrics(before).lastInputTokens).toBe(150_000)
    // The switched model's step is projected and still streaming: its count is not in yet.
    const streaming = [...before, projected(1_000_000)]
    expect(foldSessionMetrics(streaming).lastInputTokens).toBe(0)
    expect(foldSessionMetrics(streaming).context?.contextLimitTokens).toBe(1_000_000)
    // Its own step ends: the count belongs to the window it is divided by.
    expect(foldSessionMetrics([...streaming, ended(20_000)]).lastInputTokens).toBe(20_000)
  })

  test("a snapshot's fold stepped by the live events equals the fold of the whole log", () => {
    const projected = (compacted: boolean) =>
      wrap(
        AgentEvent.cases.ModelContextProjected.make({
          sessionId,
          branchId,
          estimatedTokens: 5_000,
          availableInputTokens: 95_000,
          contextLimitTokens: 100_000,
          omittedMessages: 0,
          compacted,
          costUsd: 0.125,
        }),
      )
    const ended = wrap(
      AgentEvent.cases.StreamEnded.make({
        sessionId,
        branchId,
        usage: { inputTokens: 7_000, outputTokens: 1 },
        costUsd: 0.25,
        outcome: "Answered",
      }),
    )
    const done = wrap(AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 10 }))
    const log = [projected(true), ended, done, projected(true), ended, projected(false)]
    for (let cut = 0; cut <= log.length; cut++) {
      const hydrated = foldSessionMetrics(log.slice(0, cut))
      const live = log
        .slice(cut)
        .reduce((metrics, { event }) => stepSessionMetrics(metrics, event), hydrated)
      expect(live).toEqual(foldSessionMetrics(log))
    }
    // The newest projection sets the gauge's window before its step ends.
    expect(foldSessionMetrics(log).lastInputTokens).toBe(0)
    expect(foldSessionMetrics(log).context?.compactions).toBe(2)
  })

  test("a running turn's effort is its step's level from the stream's start until the turn completes", () => {
    const started = (
      step: number,
      receipt: { readonly reasoningLevel: "low" } | { readonly reasoningDefault: true },
    ) =>
      wrap(
        AgentEvent.cases.StreamStarted.make({
          sessionId,
          branchId,
          messageId: MessageId.make("m"),
          step,
          ...receipt,
        }),
      )
    const low = { reasoningLevel: "low" } as const
    const ended = wrap(
      AgentEvent.cases.StreamEnded.make({
        sessionId,
        branchId,
        reasoningLevel: "low",
        outcome: "ToolCalls",
      }),
    )
    const done = wrap(AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 10 }))
    // The step's end and the next step keep the level; only the turn's end clears it.
    expect(foldSessionMetrics([started(1, low)]).turnEffort).toEqual({ level: "low" })
    expect(foldSessionMetrics([started(1, low), ended, started(2, low)]).turnEffort).toEqual({
      level: "low",
    })
    expect(foldSessionMetrics([started(1, low), ended, done]).turnEffort).toBeUndefined()
    // A request that names no level runs at the model's default: no level to show.
    expect(foldSessionMetrics([started(1, { reasoningDefault: true })]).turnEffort).toEqual({})
  })

  test("an effort route is held apart from the model route, and both are charged", () => {
    const route = {
      sessionId,
      branchId,
      messageId: MessageId.make("m"),
      model: ModelId.make("anthropic/claude-opus-5"),
      reason: "picked",
      durationMs: 1,
      costUsd: 0.001,
    }
    const metrics = foldSessionMetrics([
      wrap(
        AgentEvent.cases.ModelRouted.make({
          ...route,
          selected: ModelId.make("router/auto"),
          effort: "high",
        }),
      ),
      wrap(
        AgentEvent.cases.ModelRouted.make({
          ...route,
          selected: ModelId.make("router/effort"),
          effort: "low",
          effortOnly: true,
        }),
      ),
    ])
    expect(metrics.routed).toMatchObject({ selected: "router/auto", effort: "high" })
    expect(metrics.effortRouted).toEqual({
      model: ModelId.make("anthropic/claude-opus-5"),
      effort: "low",
      reason: "picked",
    })
    expect(metrics.costUsd).toBeCloseTo(0.002, 12)
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
