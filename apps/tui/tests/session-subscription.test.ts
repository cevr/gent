import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { EventEnvelope } from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { runSessionSubscriptionAttempt } from "../src/client/session-subscription"

const noop = () => {}
const log = { debug: noop, info: noop, warn: noop, error: noop }

describe("runSessionSubscriptionAttempt", () => {
  test("does not open an event stream after hydration turns stale", async () => {
    let active = true
    let openCount = 0

    const result = await Effect.runPromise(
      runSessionSubscriptionAttempt({
        sessionId: "session-a" as SessionId,
        branchId: "branch-a" as BranchId,
        lastSeenEventId: null,
        log,
        isActiveSession: () => active,
        getSnapshot: Effect.succeed({
          sessionId: "session-a" as SessionId,
          branchId: "branch-a" as BranchId,
          messages: [],
          lastEventId: null,
          reasoningLevel: undefined,
          runtime: {
            phase: "idle" as const,
            status: "idle" as const,
            agent: "cowork" as const,
            queue: { steering: [], followUp: [] },
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
      }),
    )

    expect(result).toBeUndefined()
    expect(openCount).toBe(0)
  })
})
