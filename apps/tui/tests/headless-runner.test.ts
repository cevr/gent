import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Schema, Stream } from "effect"
import {
  EventEnvelope,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
} from "@gent/core-internal/domain/event"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { GentConnectionError } from "@gent/sdk"
import { runHeadless } from "../src/headless-runner"
import { renderHeadlessToolCall } from "../src/headless-tool-renderers"
import { createMockClient } from "./render-harness-boundary"
class HeadlessRunnerTestError extends Schema.TaggedErrorClass<HeadlessRunnerTestError>()(
  "HeadlessRunnerTestError",
  { message: Schema.String },
) {}
const BashOutputJson = Schema.fromJsonString(
  Schema.Struct({
    stdout: Schema.String,
    stderr: Schema.String,
    exitCode: Schema.Number,
  }),
)
const encodeBashOutput = Schema.encodeSync(BashOutputJson)

const captureStdout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<{ readonly result: A; readonly stdout: string }, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const writes: string[] = []
      const original = process.stdout.write.bind(process.stdout)
      const replacement: typeof process.stdout.write = (chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
        return true
      }
      process.stdout.write = replacement
      return {
        read: () => writes.join(""),
        restore: () => {
          process.stdout.write = original
        },
      }
    }),
    (capture) => effect.pipe(Effect.map((result) => ({ result, stdout: capture.read() }))),
    (capture) => Effect.sync(capture.restore),
  )

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
  it.live("renders named bash tool input and truncated output", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-test")
      const branchId = BranchId.make("branch-test")
      const toolCallId = ToolCallId.make("tool-call-test")
      const started = EventEnvelope.make({
        id: 1 as EventEnvelope["id"],
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
        id: 2 as EventEnvelope["id"],
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
        id: 3 as EventEnvelope["id"],
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

  it.live("renders non-special tools through the generic fallback", () =>
    Effect.sync(() => {
      const rendered = renderHeadlessToolCall({
        toolName: "read",
        status: "completed",
        input: { path: "/tmp/example.txt" },
        output: "plain output",
        summary: undefined,
      })

      expect(rendered).toContain("[tool done: read]")
      expect(rendered).toContain("plain output")
    }),
  )
})
