/* eslint-disable */
import { describe, it, expect, test } from "effect-bun-test"
import { Cause, Effect, Stream } from "effect"
import { EventEnvelope, TurnCompleted } from "@gent/core/domain/event"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { GentConnectionError } from "@gent/sdk"
import { runHeadless } from "../../src/headless-runner"
import { createMockClient } from "../../src/../tests/render-harness"
describe("runHeadless", () => {
  it.live("stops after TurnCompleted even if the event stream stays open", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-test")
      const branchId = BranchId.make("branch-test")
      let sent = false
      const completed = EventEnvelope.make({
        id: 1 as EventEnvelope["id"],
        event: TurnCompleted.make({
          sessionId,
          branchId,
          durationMs: 42,
        }),
        createdAt: Date.now(),
      })
      const client = createMockClient({
        session: {
          events: () => Stream.concat(Stream.make(completed), Stream.never),
        },
        message: {
          send: () => {
            sent = true
            return Effect.void
          },
        },
      })
      const exit = yield* Effect.exit(
        runHeadless(client, sessionId, branchId, "Say hi").pipe(Effect.timeout("250 millis")),
      )
      expect(exit._tag).toBe("Success")
      expect(sent).toBe(true)
    }),
  )
  it.live(
    "retries reuse the same sendRequestId so the server-side dedup collapses them onto one mutation",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-test")
        const branchId = BranchId.make("branch-test")
        const observedRequestIds: Array<string> = []
        let sendAttempts = 0
        const completed = EventEnvelope.make({
          id: 1 as EventEnvelope["id"],
          event: TurnCompleted.make({
            sessionId,
            branchId,
            durationMs: 1,
          }),
          createdAt: Date.now(),
        })
        const client = createMockClient({
          session: {
            events: () => Stream.concat(Stream.make(completed), Stream.never),
          },
          message: {
            send: (input: { requestId?: string }) => {
              observedRequestIds.push(input.requestId ?? "<missing>")
              sendAttempts += 1
              // Fail the first two attempts with a transport-shape error so the
              // retry policy fires; succeed on the third.
              if (sendAttempts < 3) {
                return Effect.fail(new Error("RpcClientError: transient socket close"))
              }
              return Effect.void
            },
          },
        })
        const exit = yield* Effect.exit(
          runHeadless(client, sessionId, branchId, "Say hi").pipe(Effect.timeout("5 seconds")),
        )
        expect(exit._tag).toBe("Success")
        expect(sendAttempts).toBe(3)
        // Same id across all attempts: server-side dedup collapses retries onto
        // a single mutation. If the runner generated a fresh id each retry, the
        // server would treat each as a new send and double-deliver.
        expect(observedRequestIds.length).toBe(3)
        expect(new Set(observedRequestIds).size).toBe(1)
        // Never empty — runner must always supply an id.
        expect(observedRequestIds[0]).not.toBe("<missing>")
      }),
  )
  it.live("fails when the event stream ends before turn completion", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-test")
      const branchId = BranchId.make("branch-test")
      const client = createMockClient({
        session: {
          events: () => Stream.empty,
        },
        message: {
          send: () => Effect.void,
        },
      })
      const exit = yield* Effect.exit(runHeadless(client, sessionId, branchId, "Say hi"))
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      expect(Cause.squash(exit.cause)).toBeInstanceOf(GentConnectionError)
      expect(String(Cause.squash(exit.cause))).toContain(
        "headless event stream ended before turn completion",
      )
    }),
  )
})
