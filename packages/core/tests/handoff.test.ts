import { describe, it, expect, test } from "effect-bun-test"
import { Deferred, Effect, Layer, Stream } from "effect"
import {
  EventStore,
  HandoffPresented,
  HandoffConfirmed,
  HandoffRejected,
  type HandoffDecision,
} from "@gent/core/domain/event"
import { HandoffHandler } from "@gent/core/domain/interaction-handlers"
import {
  Message,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ImagePart,
} from "@gent/core/domain/message"
import type { SessionId, BranchId } from "@gent/core/domain/ids"
import { Storage } from "@gent/core/storage/sqlite-storage"
import {
  estimateTokens,
  estimateContextPercent,
  getContextWindow,
} from "@gent/core/runtime/context-estimation"

// ============================================================================
// HandoffHandler
// ============================================================================

describe("HandoffHandler", () => {
  describe("Test layer", () => {
    it.live("returns sequential decisions", () => {
      const layer = HandoffHandler.Test(["confirm", "reject", "confirm"])

      return Effect.gen(function* () {
        const handler = yield* HandoffHandler

        const d1 = yield* handler.present({
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          summary: "test summary",
        })
        expect(d1).toBe("confirm")

        const d2 = yield* handler.present({
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          summary: "test summary 2",
        })
        expect(d2).toBe("reject")

        const d3 = yield* handler.present({
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          summary: "test summary 3",
        })
        expect(d3).toBe("confirm")
      }).pipe(Effect.provide(layer))
    })

    it.live("defaults to confirm", () => {
      const layer = HandoffHandler.Test()

      return Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const decision = yield* handler.present({
          sessionId: "s" as SessionId,
          branchId: "b" as BranchId,
          summary: "summary",
        })
        expect(decision).toBe("confirm")
      }).pipe(Effect.provide(layer))
    })

    it.live("respond returns undefined (no-op in test)", () => {
      const layer = HandoffHandler.Test()

      return Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const result = yield* handler.respond("req-1", "confirm", "child-s" as SessionId)
        expect(result).toBeUndefined()
      }).pipe(Effect.provide(layer))
    })
  })

  describe("Live layer", () => {
    const LiveLayer = Layer.provideMerge(
      HandoffHandler.Live,
      Layer.mergeAll(EventStore.Live, Storage.Memory()),
    )

    it.live("present blocks until respond, then returns decision", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler

        // Fork present (blocks on internal Deferred)
        const decisionDeferred = yield* Deferred.make<HandoffDecision>()
        yield* Effect.forkDetach(
          handler
            .present({
              sessionId: "s1" as SessionId,
              branchId: "b1" as BranchId,
              summary: "Context summary here",
              reason: "context pressure",
            })
            .pipe(Effect.flatMap((d) => Deferred.succeed(decisionDeferred, d))),
        )

        // Should not have resolved yet
        yield* Effect.sleep("10 millis")
        const isDone = yield* Deferred.isDone(decisionDeferred)
        expect(isDone).toBe(false)
      }).pipe(Effect.provide(LiveLayer)),
    )

    it.live("present/respond confirm flow returns entry with summary", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const eventStore = yield* EventStore

        // Use the EventStore PubSub to capture the requestId
        const requestIdDeferred = yield* Deferred.make<string>()

        // Subscribe to events to grab requestId
        yield* Effect.forkDetach(
          eventStore.subscribe({ sessionId: "s1" as SessionId }).pipe(
            Stream.runForEach((env) =>
              Effect.gen(function* () {
                if (env.event._tag === "HandoffPresented") {
                  yield* Deferred.succeed(
                    requestIdDeferred,
                    (env.event as HandoffPresented).requestId,
                  )
                }
              }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
        )

        // Fork present (blocks until respond)
        const decisionDeferred = yield* Deferred.make<HandoffDecision>()
        yield* Effect.forkDetach(
          handler
            .present({
              sessionId: "s1" as SessionId,
              branchId: "b1" as BranchId,
              summary: "Test context",
            })
            .pipe(Effect.flatMap((d) => Deferred.succeed(decisionDeferred, d))),
        )

        // Wait for requestId from event
        const requestId = yield* Deferred.await(requestIdDeferred)
        expect(requestId).toBeTruthy()

        // Respond with confirm
        const entry = yield* handler.respond(requestId, "confirm", "child-session" as SessionId)
        expect(entry).toBeDefined()
        expect(entry?.sessionId).toBe("s1")
        expect(entry?.summary).toBe("Test context")

        // The present Deferred should resolve
        const decision = yield* Deferred.await(decisionDeferred)
        expect(decision).toBe("confirm")
      }).pipe(Effect.provide(LiveLayer)),
    )

    it.live("present/respond reject flow returns entry", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const eventStore = yield* EventStore

        const requestIdDeferred = yield* Deferred.make<string>()

        yield* Effect.forkDetach(
          eventStore.subscribe({ sessionId: "s2" as SessionId }).pipe(
            Stream.runForEach((env) =>
              Effect.gen(function* () {
                if (env.event._tag === "HandoffPresented") {
                  yield* Deferred.succeed(
                    requestIdDeferred,
                    (env.event as HandoffPresented).requestId,
                  )
                }
              }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
        )

        const decisionDeferred = yield* Deferred.make<HandoffDecision>()
        yield* Effect.forkDetach(
          handler
            .present({
              sessionId: "s2" as SessionId,
              branchId: "b2" as BranchId,
              summary: "Rejected context",
            })
            .pipe(Effect.flatMap((d) => Deferred.succeed(decisionDeferred, d))),
        )

        const requestId = yield* Deferred.await(requestIdDeferred)

        // Respond with reject
        const entry = yield* handler.respond(requestId, "reject", undefined, "Not ready yet")
        expect(entry).toBeDefined()
        expect(entry?.summary).toBe("Rejected context")

        const decision = yield* Deferred.await(decisionDeferred)
        expect(decision).toBe("reject")
      }).pipe(Effect.provide(LiveLayer)),
    )

    it.live("respond to unknown requestId returns undefined", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const result = yield* handler.respond("nonexistent", "confirm", "s" as SessionId)
        expect(result).toBeUndefined()
      }).pipe(Effect.provide(LiveLayer)),
    )

    it.live("double respond returns undefined on second call", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const eventStore = yield* EventStore

        const requestIdDeferred = yield* Deferred.make<string>()

        yield* Effect.forkDetach(
          eventStore.subscribe({ sessionId: "s3" as SessionId }).pipe(
            Stream.runForEach((env) =>
              Effect.gen(function* () {
                if (env.event._tag === "HandoffPresented") {
                  yield* Deferred.succeed(
                    requestIdDeferred,
                    (env.event as HandoffPresented).requestId,
                  )
                }
              }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
        )

        yield* Effect.forkDetach(
          handler
            .present({
              sessionId: "s3" as SessionId,
              branchId: "b3" as BranchId,
              summary: "Double respond test",
            })
            .pipe(Effect.flatMap(() => Effect.void)),
        )

        const requestId = yield* Deferred.await(requestIdDeferred)

        // First respond succeeds
        const first = yield* handler.respond(requestId, "confirm", "child" as SessionId)
        expect(first).toBeDefined()

        // Second respond returns undefined (already consumed)
        const second = yield* handler.respond(requestId, "reject")
        expect(second).toBeUndefined()
      }).pipe(Effect.provide(LiveLayer)),
    )
  })
})

// ============================================================================
// Handoff Events — schema roundtrip
// ============================================================================

describe("Handoff Events", () => {
  test("HandoffPresented has correct _tag and fields", () => {
    const event = new HandoffPresented({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      summary: "Context summary",
      reason: "context pressure",
    })

    expect(event._tag).toBe("HandoffPresented")
    expect(event.sessionId).toBe("s1")
    expect(event.summary).toBe("Context summary")
    expect(event.reason).toBe("context pressure")
  })

  test("HandoffConfirmed has correct _tag and fields", () => {
    const event = new HandoffConfirmed({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      childSessionId: "child-s1" as SessionId,
    })

    expect(event._tag).toBe("HandoffConfirmed")
    expect(event.childSessionId).toBe("child-s1")
  })

  test("HandoffRejected has correct _tag and fields", () => {
    const event = new HandoffRejected({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      reason: "Not ready",
    })

    expect(event._tag).toBe("HandoffRejected")
    expect(event.reason).toBe("Not ready")
  })

  test("HandoffPresented without optional reason", () => {
    const event = new HandoffPresented({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      summary: "Just a summary",
    })

    expect(event.reason).toBeUndefined()
  })

  test("HandoffRejected without optional reason", () => {
    const event = new HandoffRejected({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
    })

    expect(event.reason).toBeUndefined()
  })
})

// ============================================================================
// estimateContextPercent / getContextWindow
// ============================================================================

describe("estimateContextPercent", () => {
  test("returns 0 for empty messages", () => {
    // System overhead only: 4000 tokens / 1000000 = 0.4% → 0
    const percent = estimateContextPercent([], "anthropic/claude-opus-4-6")
    expect(percent).toBe(0)
  })

  test("calculates percent against model context window", () => {
    // 800 chars = 200 tokens. + 4000 overhead = 4200 tokens. / 1000000 = 0.42% → 0
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(800) })],
        createdAt: new Date(),
      }),
    ]
    const percent = estimateContextPercent(messages, "anthropic/claude-opus-4-6")
    expect(percent).toBe(0)
  })

  test("larger messages increase percent", () => {
    // 40000 chars = 10000 tokens. + 4000 = 14000. / 1000000 = 1.4% → 1
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(40_000) })],
        createdAt: new Date(),
      }),
    ]
    const percent = estimateContextPercent(messages, "anthropic/claude-opus-4-6")
    expect(percent).toBe(1)
  })

  test("respects different model context windows", () => {
    // 40000 chars = 10000 tokens. + 4000 = 14000. / 1000000 (codex) = 1.4% → 1
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(40_000) })],
        createdAt: new Date(),
      }),
    ]
    const percent = estimateContextPercent(messages, "openai/gpt-5.4")
    expect(percent).toBe(1)
  })

  test("multiple message types contribute to estimate", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(4_000) })],
        createdAt: new Date(),
      }),
      new Message({
        id: "m2",
        sessionId: "s",
        branchId: "b",
        role: "assistant",
        parts: [
          new TextPart({ type: "text", text: "y".repeat(4_000) }),
          new ToolCallPart({
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "test",
            input: { key: "v".repeat(2_000) },
          }),
        ],
        createdAt: new Date(),
      }),
      new Message({
        id: "m3",
        sessionId: "s",
        branchId: "b",
        role: "tool",
        parts: [
          new ToolResultPart({
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "test",
            output: { type: "json", value: { result: "z".repeat(2_000) } },
          }),
        ],
        createdAt: new Date(),
      }),
    ]

    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)

    const percent = estimateContextPercent(messages, "anthropic/claude-opus-4-6")
    expect(percent).toBeGreaterThan(0) // more than just overhead
    expect(percent).toBeLessThan(100)
  })
})

describe("getContextWindow", () => {
  test("returns known model windows", () => {
    expect(getContextWindow("anthropic/claude-opus-4-6")).toBe(1_000_000)
    expect(getContextWindow("openai/gpt-5.4")).toBe(1_000_000)
    expect(getContextWindow("openai/gpt-5.4-mini")).toBe(1_000_000)
  })

  test("returns default for unknown models", () => {
    expect(getContextWindow("unknown/model")).toBe(200_000)
  })
})

// ============================================================================
// estimateTokens — covers all part types
// ============================================================================

describe("estimateTokens", () => {
  test("text parts", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(100) })],
        createdAt: new Date(),
      }),
    ]
    expect(estimateTokens(messages)).toBe(25) // 100/4
  })

  test("tool-call parts use JSON.stringify of input", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "assistant",
        parts: [
          new ToolCallPart({
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "test",
            input: { key: "value" },
          }),
        ],
        createdAt: new Date(),
      }),
    ]
    const tokens = estimateTokens(messages)
    const expectedChars = JSON.stringify({ key: "value" }).length
    expect(tokens).toBe(Math.ceil(expectedChars / 4))
  })

  test("tool-result parts use JSON.stringify of output", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "tool",
        parts: [
          new ToolResultPart({
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "test",
            output: { type: "json", value: { data: "hello" } },
          }),
        ],
        createdAt: new Date(),
      }),
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)
  })

  test("image parts estimate ~250 tokens", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new ImagePart({ type: "image", image: "data:image/png;base64,abc" })],
        createdAt: new Date(),
      }),
    ]
    expect(estimateTokens(messages)).toBe(250) // 1000/4
  })

  test("empty messages return 0", () => {
    expect(estimateTokens([])).toBe(0)
  })

  test("multiple messages sum correctly", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(100) })],
        createdAt: new Date(),
      }),
      new Message({
        id: "m2",
        sessionId: "s",
        branchId: "b",
        role: "assistant",
        parts: [new TextPart({ type: "text", text: "y".repeat(200) })],
        createdAt: new Date(),
      }),
    ]
    expect(estimateTokens(messages)).toBe(75) // (100+200)/4
  })
})
