import { describe, expect, test } from "bun:test"
import { Cause, Effect, Stream } from "effect"
import { EventEnvelope, TurnCompleted } from "@gent/core/domain/event"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { GentConnectionError } from "@gent/sdk"
import { runHeadless } from "../src/headless-runner"
import { createMockClient } from "./render-harness"

describe("runHeadless", () => {
  test("stops after TurnCompleted even if the event stream stays open", async () => {
    const sessionId = SessionId.make("session-test")
    const branchId = BranchId.make("branch-test")
    let sent = false

    const completed = new EventEnvelope({
      id: 1 as EventEnvelope["id"],
      event: new TurnCompleted({
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

    const exit = await Effect.runPromiseExit(
      runHeadless(client, sessionId, branchId, "Say hi").pipe(Effect.timeout("250 millis")),
    )

    expect(exit._tag).toBe("Success")
    expect(sent).toBe(true)
  })

  test("fails when the event stream ends before turn completion", async () => {
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

    const exit = await Effect.runPromiseExit(runHeadless(client, sessionId, branchId, "Say hi"))

    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") return
    expect(Cause.squash(exit.cause)).toBeInstanceOf(GentConnectionError)
    expect(String(Cause.squash(exit.cause))).toContain(
      "headless event stream ended before turn completion",
    )
  })
})
