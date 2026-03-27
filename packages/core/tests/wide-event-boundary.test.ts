/**
 * Wide event boundary integration tests.
 *
 * Proves the gent-specific context factories produce correct WideEventContext shapes
 * and that withWideEvent flows through Effect's logger.
 */

import { describe, it, expect } from "effect-bun-test"
import { Effect, MutableRef } from "effect"
import {
  WideEvent,
  withWideEvent,
  WideEventLogger,
  turnBoundary,
  toolBoundary,
  providerStreamBoundary,
  rpcBoundary,
  subagentBoundary,
} from "../src/runtime/wide-event-boundary"
import type { LogEvent } from "../src/runtime/wide-event-boundary"
import type { SessionId, BranchId, ToolCallId } from "../src/domain/ids"

const captured = () => MutableRef.make<Array<LogEvent>>([])

const getAnnotations = (ref: MutableRef.MutableRef<Array<LogEvent>>, index = 0) =>
  MutableRef.get(ref)[index]!.annotations

describe("wide-event-boundary", () => {
  describe("context factories", () => {
    it.live("turnBoundary produces agent-loop context with session envelope", () =>
      Effect.gen(function* () {
        const ref = captured()

        yield* WideEvent.set({ model: "claude-4" }).pipe(
          withWideEvent(turnBoundary("sess-1" as SessionId, "br-1" as BranchId, "cowork")),
          Effect.provide(WideEventLogger.Capture(ref)),
        )

        const a = getAnnotations(ref)
        expect(a["service"]).toBe("agent-loop")
        expect(a["method"]).toBe("turn")
        expect(a["actor"]).toBe("cowork")
        expect(a["sessionId"]).toBe("sess-1")
        expect(a["branchId"]).toBe("br-1")
        expect(a["model"]).toBe("claude-4")
        expect(a["status"]).toBe("ok")
        expect(typeof a["durationMs"]).toBe("number")
      }),
    )

    it.live("toolBoundary produces tool-runner context", () =>
      Effect.gen(function* () {
        const ref = captured()

        yield* Effect.void.pipe(
          withWideEvent(toolBoundary("bash", "tc-123" as ToolCallId)),
          Effect.provide(WideEventLogger.Capture(ref)),
        )

        const a = getAnnotations(ref)
        expect(a["service"]).toBe("tool-runner")
        expect(a["method"]).toBe("bash")
        expect(a["toolCallId"]).toBe("tc-123")
      }),
    )

    it.live("providerStreamBoundary produces provider context", () =>
      Effect.gen(function* () {
        const ref = captured()

        yield* WideEvent.set({ inputTokens: 100, outputTokens: 50 }).pipe(
          withWideEvent(providerStreamBoundary("claude-opus-4-6")),
          Effect.provide(WideEventLogger.Capture(ref)),
        )

        const a = getAnnotations(ref)
        expect(a["service"]).toBe("provider")
        expect(a["method"]).toBe("stream")
        expect(a["model"]).toBe("claude-opus-4-6")
        expect(a["inputTokens"]).toBe(100)
        expect(a["outputTokens"]).toBe(50)
      }),
    )

    it.live("rpcBoundary produces rpc context", () =>
      Effect.gen(function* () {
        const ref = captured()

        yield* WideEvent.set({ sessionId: "sess-1" }).pipe(
          withWideEvent(rpcBoundary("sendMessage")),
          Effect.provide(WideEventLogger.Capture(ref)),
        )

        const a = getAnnotations(ref)
        expect(a["service"]).toBe("rpc")
        expect(a["method"]).toBe("sendMessage")
        expect(a["sessionId"]).toBe("sess-1")
      }),
    )

    it.live("subagentBoundary produces subagent context", () =>
      Effect.gen(function* () {
        const ref = captured()

        yield* WideEvent.set({ childSessionId: "child-1" }).pipe(
          withWideEvent(subagentBoundary("researcher", "parent-1" as SessionId)),
          Effect.provide(WideEventLogger.Capture(ref)),
        )

        const a = getAnnotations(ref)
        expect(a["service"]).toBe("subagent")
        expect(a["method"]).toBe("run")
        expect(a["actor"]).toBe("researcher")
        expect(a["parentSessionId"]).toBe("parent-1")
        expect(a["childSessionId"]).toBe("child-1")
      }),
    )
  })

  describe("emission guarantees", () => {
    it.live("emits on error with errorType and errorMessage", () =>
      Effect.gen(function* () {
        const ref = captured()

        yield* Effect.fail({ _tag: "AgentLoopError", message: "turn failed" }).pipe(
          withWideEvent(turnBoundary("sess-1" as SessionId, "br-1" as BranchId, "cowork")),
          Effect.catchIf(
            () => true,
            () => Effect.void,
          ),
          Effect.provide(WideEventLogger.Capture(ref)),
        )

        const a = getAnnotations(ref)
        expect(a["status"]).toBe("error")
        expect(a["errorType"]).toBe("AgentLoopError")
        expect(a["errorMessage"]).toBe("turn failed")
        expect(a["sessionId"]).toBe("sess-1")
      }),
    )

    it.live("nested boundaries (tool inside turn) emit separate events", () =>
      Effect.gen(function* () {
        const ref = captured()

        yield* Effect.gen(function* () {
          yield* WideEvent.set({ agent: "cowork" })

          yield* WideEvent.set({ toolResult: "ok" }).pipe(
            withWideEvent(toolBoundary("read", "tc-1" as ToolCallId)),
          )
        }).pipe(
          withWideEvent(turnBoundary("sess-1" as SessionId, "br-1" as BranchId, "cowork")),
          Effect.provide(WideEventLogger.Capture(ref)),
        )

        const events = MutableRef.get(ref)
        expect(events).toHaveLength(2)

        // Tool emits first (inner boundary)
        const toolEvent = events[0]!.annotations
        expect(toolEvent["service"]).toBe("tool-runner")
        expect(toolEvent["method"]).toBe("read")

        // Turn emits second (outer boundary)
        const turnEvent = events[1]!.annotations
        expect(turnEvent["service"]).toBe("agent-loop")
        expect(turnEvent["agent"]).toBe("cowork")
        // Tool fields should NOT leak to turn boundary
        expect(turnEvent["toolResult"]).toBeUndefined()
      }),
    )
  })
})
