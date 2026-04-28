/* eslint-disable */
import { describe, it, expect, test } from "effect-bun-test"
import { Effect, Stream } from "effect"
import type { EventEnvelope } from "@gent/core/domain/event"
import { AgentName } from "@gent/core/domain/agent"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { emptyQueueSnapshot } from "@gent/sdk"
import { runSessionSubscriptionAttempt } from "../../src/client/session-subscription"
const noop = () => {}
const log = { debug: noop, info: noop, warn: noop, error: noop }
describe("runSessionSubscriptionAttempt", () => {
  it.live("does not open an event stream after hydration turns stale", () =>
    Effect.gen(function* () {
      let active = true
      let openCount = 0
      const result = yield* runSessionSubscriptionAttempt({
        sessionId: SessionId.make("session-a"),
        branchId: BranchId.make("branch-a"),
        lastSeenEventId: null,
        log,
        isActiveSession: () => active,
        getSnapshot: Effect.succeed({
          sessionId: SessionId.make("session-a"),
          branchId: BranchId.make("branch-a"),
          messages: [],
          lastEventId: null,
          reasoningLevel: undefined,
          runtime: {
            _tag: "Idle" as const,
            agent: AgentName.make("cowork"),
            queue: emptyQueueSnapshot(),
          },
          metrics: {
            turns: 0,
            tokens: 0,
            toolCalls: 0,
            retries: 0,
            durationMs: 0,
            costUsd: 0,
            lastInputTokens: 0,
          },
        }),
        hydrateSnapshot: () => {
          active = false
        },
        openEvents: () => {
          openCount++
          return Stream.empty as Stream.Stream<EventEnvelope>
        },
        processEvent: () => {},
      })
      expect(result).toBeUndefined()
      expect(openCount).toBe(0)
    }),
  )
})
