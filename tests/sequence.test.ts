import { describe, test, expect } from "bun:test"
import { Effect, Stream } from "effect"
import {
  SequenceRecorder,
  createRecordingTestLayer,
  assertSequence,
  mockTextResponse,
} from "@gent/test-utils"
import { Provider } from "@gent/providers"
import { EventStore, StreamStarted } from "@gent/core"
import { AskUserHandler } from "@gent/tools"

describe("Sequence Recording", () => {
  describe("SequenceRecorder", () => {
    test("records and retrieves calls", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const recorder = yield* SequenceRecorder
          yield* recorder.record({
            service: "TestService",
            method: "testMethod",
            args: { foo: "bar" },
          })

          const calls = yield* recorder.getCalls()
          expect(calls.length).toBe(1)
          expect(calls[0]?.service).toBe("TestService")
          expect(calls[0]?.method).toBe("testMethod")
        }).pipe(Effect.provide(SequenceRecorder.Live)),
      )
    })

    test("clears recorded calls", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const recorder = yield* SequenceRecorder
          yield* recorder.record({ service: "A", method: "b" })
          yield* recorder.clear()

          const calls = yield* recorder.getCalls()
          expect(calls.length).toBe(0)
        }).pipe(Effect.provide(SequenceRecorder.Live)),
      )
    })
  })

  describe("Recording Layers", () => {
    const TestLayer = createRecordingTestLayer({
      providerResponses: [mockTextResponse("Hello!")],
      askUserResponses: ["yes", "no"],
    })

    test("records Provider.stream calls", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* Provider
          const recorder = yield* SequenceRecorder

          const stream = yield* provider.stream({
            model: "test/model",
            messages: [],
          })
          yield* Stream.runDrain(stream)

          const calls = yield* recorder.getCalls()
          const providerCalls = calls.filter((c) => c.service === "Provider")
          expect(providerCalls.length).toBe(1)
          expect(providerCalls[0]?.method).toBe("stream")
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    test("records EventStore.publish calls", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const eventStore = yield* EventStore
          const recorder = yield* SequenceRecorder

          yield* eventStore.publish(new StreamStarted({ sessionId: "s1", branchId: "b1" }))

          const calls = yield* recorder.getCalls()
          const eventCalls = calls.filter((c) => c.service === "EventStore")
          expect(eventCalls.length).toBe(1)
          expect((eventCalls[0]?.args as any)?._tag).toBe("StreamStarted")
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    test("records AskUserHandler.ask calls", async () => {
      const testCtx = {
        sessionId: "test-session",
        branchId: "test-branch",
        toolCallId: "test-tool",
      }

      await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* AskUserHandler
          const recorder = yield* SequenceRecorder

          const response1 = yield* handler.ask({ question: "Continue?" }, testCtx)
          const response2 = yield* handler.ask({ question: "Sure?" }, testCtx)

          expect(response1).toBe("yes")
          expect(response2).toBe("no")

          const calls = yield* recorder.getCalls()
          const askCalls = calls.filter((c) => c.service === "AskUserHandler")
          expect(askCalls.length).toBe(2)
        }).pipe(Effect.provide(TestLayer)),
      )
    })
  })

  describe("assertSequence", () => {
    test("matches calls in order", () => {
      const calls = [
        { service: "A", method: "x", timestamp: 1 },
        { service: "B", method: "y", timestamp: 2 },
        { service: "C", method: "z", timestamp: 3 },
      ]

      expect(() =>
        assertSequence(calls, [
          { service: "A", method: "x" },
          { service: "C", method: "z" },
        ]),
      ).not.toThrow()
    })

    test("throws on missing call", () => {
      const calls = [{ service: "A", method: "x", timestamp: 1 }]

      expect(() => assertSequence(calls, [{ service: "B", method: "y" }])).toThrow(
        /Expected call not found/,
      )
    })

    test("matches with args filter", () => {
      const calls = [
        { service: "Provider", method: "stream", args: { model: "gpt-4" }, timestamp: 1 },
        { service: "Provider", method: "stream", args: { model: "claude" }, timestamp: 2 },
      ]

      expect(() =>
        assertSequence(calls, [
          { service: "Provider", method: "stream", match: { model: "claude" } },
        ]),
      ).not.toThrow()
    })
  })
})
