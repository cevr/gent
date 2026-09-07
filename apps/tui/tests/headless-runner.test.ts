import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Option, Schema, Sink, Stdio, Stream } from "effect"
import {
  EventEnvelope,
  EventId,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
} from "@gent/core-internal/domain/event"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { GentConnectionError } from "@gent/sdk"
import { runHeadless } from "../src/headless-runner"
import { renderHeadlessToolCall } from "../src/headless-tool-renderers"
import { createMockClient } from "./render-harness-boundary"
class HeadlessRunnerTestError extends Schema.TaggedError<HeadlessRunnerTestError>()(
  "HeadlessRunnerTestError",
  { message: Schema.String },
) {}
const BashOutputJson = Schema.fromJsonString(
  Schema.Struct({
    stdout: Schema.String,
    stderr: Schema.String,
    exitCode: Schema.Finite,
  }),
)
const encodeBashOutput = Schema.encodeSync(BashOutputJson)
const encodeCellOutput = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const capturedWrites: string[] = []
const stdout = Sink.forEach((chunk: string | Uint8Array): Effect.Effect<void> =>
  Effect.sync(() => {
    capturedWrites.push(String(chunk))
  }),
)
const headlessTest = it.live.layer(Stdio.layerTest({ stdout: () => stdout }))

const captureStdout = <A, E>(
  effect: Effect.Effect<A, E, Stdio.Stdio>,
): Effect.Effect<{ readonly result: A; readonly stdout: string }, E, Stdio.Stdio> =>
  Effect.gen(function* () {
    capturedWrites.length = 0
    const result = yield* effect
    return { result, stdout: capturedWrites.join("") }
  })

describe("runHeadless", () => {
  headlessTest("stops after TurnCompleted even if the event stream stays open", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-test")
      const branchId = BranchId.make("branch-test")
      let sent = false
      const completed = EventEnvelope.make({
        id: EventId.make(1),
        event: TurnCompleted.make({
          sessionId,
          branchId,
          durationMs: 42,
        }),
        createdAt: 0,
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
  headlessTest(
    "retries reuse the same sendRequestId so the server-side dedup collapses them onto one mutation",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-test")
        const branchId = BranchId.make("branch-test")
        const observedRequestIds: Array<string> = []
        let sendAttempts = 0
        const completed = EventEnvelope.make({
          id: EventId.make(1),
          event: TurnCompleted.make({
            sessionId,
            branchId,
            durationMs: 1,
          }),
          createdAt: 0,
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
                return Effect.fail(
                  new HeadlessRunnerTestError({
                    message: "RpcClientError: transient socket close",
                  }),
                )
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
  headlessTest("fails when the event stream ends before turn completion", () =>
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
  headlessTest("renders named bash tool input and truncated output", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-test")
      const branchId = BranchId.make("branch-test")
      const toolCallId = ToolCallId.make("tool-call-test")
      const started = EventEnvelope.make({
        id: EventId.make(1),
        event: ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "bash",
          input: { command: "printf many-lines" },
        }),
        createdAt: 0,
      })
      const outputLines = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")
      const succeeded = EventEnvelope.make({
        id: EventId.make(2),
        event: ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "bash",
          output: encodeBashOutput({ stdout: outputLines, stderr: "", exitCode: 0 }),
        }),
        createdAt: 0,
      })
      const completed = EventEnvelope.make({
        id: EventId.make(3),
        event: TurnCompleted.make({
          sessionId,
          branchId,
          durationMs: 1,
        }),
        createdAt: 0,
      })
      const client = createMockClient({
        session: {
          events: () => Stream.concat(Stream.make(started, succeeded, completed), Stream.never),
        },
        message: {
          send: () => Effect.void,
        },
      })

      const captured = yield* captureStdout(
        runHeadless(client, sessionId, branchId, "Say hi").pipe(Effect.timeout("5 seconds")),
      )
      expect(captured.stdout).toContain("[tool: bash] printf many-lines")
      expect(captured.stdout).toContain("[tool done: bash exit 0]")
      expect(captured.stdout).toContain("line 0")
      expect(captured.stdout).toContain("line 19")
      expect(captured.stdout).toContain("[8 lines truncated]")
      expect(captured.stdout).not.toContain('"stdout"')
    }),
  )

  headlessTest("renders non-special tools through the generic fallback", () =>
    Effect.sync(() => {
      const rendered = renderHeadlessToolCall({
        toolName: "read",
        status: "completed",
        input: Option.some({ path: "/tmp/example.txt" }),
        output: Option.some("plain output"),
        summary: Option.none(),
      })

      expect(rendered).toContain("[tool done: read]")
      expect(rendered).toContain("plain output")
    }),
  )

  headlessTest("renders cell operation receipts under the cell", () =>
    Effect.sync(() => {
      const rendered = renderHeadlessToolCall({
        toolName: "cell",
        status: "completed",
        input: Option.some({ code: "await tools.call('read', {path: 'a.txt'})" }),
        output: Option.some(
          encodeCellOutput({
            display: "ok",
            operations: [{ tool: "read", outcome: "succeeded", summary: "12 lines" }],
          }),
        ),
        summary: Option.none(),
      })

      expect(rendered).toBe("[tool done: cell]\n  ✓ read 12 lines\nok")
    }),
  )
})
