import {
  ErrorOccurred,
  EventId,
  StreamEnded,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
  type SessionRuntimeState,
} from "@gent/core/test-utils"
import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Option, Schema, Sink, Stdio, Stream } from "effect"
import { AgentEvent, BranchId, EventEnvelope, SessionId, ToolCallId } from "@gent/core/protocol"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import { GentConnectionError, emptyQueueSnapshot } from "@gent/sdk"
import { renderHeadlessToolCall, runHeadless } from "../src/headless"
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
const capturedErrors: string[] = []
const stdout = Sink.forEach((chunk: string | Uint8Array): Effect.Effect<void> =>
  Effect.sync(() => {
    capturedWrites.push(String(chunk))
  }),
)
const stderr = Sink.forEach((chunk: string | Uint8Array): Effect.Effect<void> =>
  Effect.sync(() => {
    capturedErrors.push(String(chunk))
  }),
)
const headlessTest = it.live.layer(Stdio.layerTest({ stdout: () => stdout, stderr: () => stderr }))
const noUser = { approveAll: false }

const sessionId = SessionId.make("session-headless")
const branchId = BranchId.make("branch-headless")

/**
 * A subscription's events: the stored history, the synchronization marker a
 * subscription sends after it, then the live events, and an open stream.
 */
const subscription = (history: ReadonlyArray<AgentEvent>, live: ReadonlyArray<AgentEvent>) => {
  const marker = AgentEvent.cases.StreamSynchronized.make({
    sessionId,
    branchId,
    lastEventId: EventId.make(history.length),
  })
  const envelopes = [...history, marker, ...live].map((event, index) =>
    EventEnvelope.make({ id: EventId.make(index + 1), event, createdAt: 0 }),
  )
  return Stream.concat(Stream.fromIterable(envelopes), Stream.never)
}
const chunk = (text: string) =>
  AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: text })
const completed = (fields: { readonly unanswered?: boolean } = {}) =>
  TurnCompleted.make({ sessionId, branchId, durationMs: 1, ...fields })
const errorOccurred = (error: string) => ErrorOccurred.make({ sessionId, branchId, error })
const runtimeState = (tag: "Idle" | "Running"): SessionRuntimeState => {
  if (tag === "Idle") return { _tag: "Idle", queue: emptyQueueSnapshot() }
  return { _tag: "Running", queue: emptyQueueSnapshot() }
}

const captureStdout = <A, E>(
  effect: Effect.Effect<A, E, Stdio.Stdio>,
): Effect.Effect<{ readonly result: A; readonly stdout: string }, E, Stdio.Stdio> =>
  Effect.gen(function* () {
    capturedWrites.length = 0
    capturedErrors.length = 0
    const result = yield* effect
    return { result, stdout: capturedWrites.join("") }
  })

/** Live envelopes of an older test, behind the synchronization marker. */
const synchronizedAt = (...envelopes: ReadonlyArray<EventEnvelope>) =>
  Stream.make(
    EventEnvelope.make({
      id: EventId.make(0),
      event: AgentEvent.cases.StreamSynchronized.make({
        sessionId,
        branchId,
        lastEventId: EventId.make(0),
      }),
      createdAt: 0,
    }),
    ...envelopes,
  )

describe("runHeadless", () => {
  headlessTest("an error notice does not end the turn; the answer after it prints", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        session: {
          events: () =>
            subscription(
              [],
              [
                errorOccurred("Context compaction failed; continuing"),
                chunk("the answer"),
                completed(),
              ],
            ),
        },
        message: { send: () => Effect.void },
      })
      const captured = yield* captureStdout(
        runHeadless(client, sessionId, branchId, "Say hi", noUser).pipe(
          Effect.timeout("2 seconds"),
        ),
      )
      expect(captured.stdout).toContain("the answer")
      expect(capturedErrors.join("")).toBe("\nError: Context compaction failed; continuing\n")
    }),
  )

  headlessTest("an error notice alone leaves the run waiting for its turn", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        session: {
          events: () => subscription([], [errorOccurred("Context compaction failed; continuing")]),
        },
        message: { send: () => Effect.void },
      })
      // Absence of an end: the run is still open when the bound expires.
      const outcome = yield* runHeadless(client, sessionId, branchId, "Say hi", noUser).pipe(
        Effect.timeoutOption("150 millis"),
      )
      expect(Option.isNone(outcome)).toBe(true)
    }),
  )

  headlessTest("a failed stream with no answer fails the run", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        session: {
          events: () =>
            subscription(
              [],
              [
                StreamEnded.make({ sessionId, branchId, outcome: "Failed" }),
                errorOccurred("provider unavailable"),
                completed(),
              ],
            ),
        },
        message: { send: () => Effect.void },
      })
      const exit = yield* Effect.exit(
        runHeadless(client, sessionId, branchId, "Say hi", noUser).pipe(
          Effect.timeout("2 seconds"),
        ),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      expect(String(Cause.squash(exit.cause))).toContain("HeadlessUnansweredError")
    }),
  )

  headlessTest("a failed stream after an answer still exits cleanly", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        session: {
          events: () =>
            subscription(
              [],
              [chunk("partial answer"), errorOccurred("provider unavailable"), completed()],
            ),
        },
        message: { send: () => Effect.void },
      })
      const exit = yield* Effect.exit(
        runHeadless(client, sessionId, branchId, "Say hi", noUser).pipe(
          Effect.timeout("2 seconds"),
        ),
      )
      expect(exit._tag).toBe("Success")
    }),
  )

  headlessTest("a failed turn phase with no TurnCompleted fails once the loop is idle", () =>
    Effect.gen(function* () {
      const subscriptions: Array<string> = []
      const client = createMockClient({
        session: {
          events: (input: { readonly after?: number }) => {
            const after = Option.fromNullishOr(input.after)
            subscriptions.push(
              Option.match(after, { onNone: () => "live", onSome: (id) => `after ${id}` }),
            )
            if (Option.isNone(after)) return subscription([], [errorOccurred("storage is busy")])
            // The stored events since the run began hold no TurnCompleted.
            return subscription([errorOccurred("storage is busy")], [])
          },
          watchRuntime: () =>
            Stream.concat(
              Stream.make(runtimeState("Idle"), runtimeState("Running"), runtimeState("Idle")),
              Stream.never,
            ),
        },
        message: { send: () => Effect.void },
      })
      const exit = yield* Effect.exit(
        runHeadless(client, sessionId, branchId, "Say hi", noUser).pipe(
          Effect.timeout("2 seconds"),
        ),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      expect(String(Cause.squash(exit.cause))).toContain("HeadlessUnansweredError")
      expect(subscriptions).toEqual(["live", "after 0"])
    }),
  )

  headlessTest("an idle loop after a notice waits for the stored TurnCompleted to arrive", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        session: {
          events: (input: { readonly after?: number }) => {
            const notice = errorOccurred("Context compaction failed; continuing")
            // The live stream lags: its TurnCompleted has not arrived yet.
            if (Option.isNone(Option.fromNullishOr(input.after))) return subscription([], [notice])
            return subscription([notice, chunk("the answer"), completed()], [])
          },
          watchRuntime: () =>
            Stream.concat(
              Stream.make(runtimeState("Idle"), runtimeState("Running"), runtimeState("Idle")),
              Stream.never,
            ),
        },
        message: { send: () => Effect.void },
      })
      const outcome = yield* runHeadless(client, sessionId, branchId, "Say hi", noUser).pipe(
        Effect.timeoutOption("150 millis"),
      )
      expect(Option.isNone(outcome)).toBe(true)
    }),
  )

  headlessTest("a resumed session's history neither prints nor settles the run", () =>
    Effect.gen(function* () {
      let sent = false
      const client = createMockClient({
        session: {
          events: () =>
            subscription(
              [chunk("old answer"), completed({ unanswered: true })],
              [chunk("new answer"), completed()],
            ),
        },
        message: {
          send: () =>
            Effect.sync(() => {
              sent = true
            }),
        },
      })
      const captured = yield* captureStdout(
        runHeadless(client, sessionId, branchId, "Say hi", noUser).pipe(
          Effect.timeout("2 seconds"),
        ),
      )
      expect(sent).toBe(true)
      expect(captured.stdout).toContain("new answer")
      expect(captured.stdout).not.toContain("old answer")
    }),
  )

  const presented = AgentEvent.cases.InteractionPresented.make({
    sessionId,
    branchId,
    requestId: InteractionRequestId.make("req-headless"),
    text: "Run a destructive command?",
  })
  const answerInteraction = (options: { readonly approveAll: boolean }) =>
    Effect.gen(function* () {
      const answers: Array<{ readonly approved: boolean; readonly notes?: string }> = []
      const client = createMockClient({
        session: { events: () => subscription([], [presented, chunk("done"), completed()]) },
        message: { send: () => Effect.void },
        interaction: {
          respondInteraction: (input: { readonly approved: boolean; readonly notes?: string }) =>
            Effect.sync(() => {
              answers.push(input)
            }),
        },
      })
      const captured = yield* captureStdout(
        runHeadless(client, sessionId, branchId, "Say hi", options).pipe(
          Effect.timeout("2 seconds"),
        ),
      )
      return { answers, stdout: captured.stdout }
    })

  headlessTest("an interaction is declined when no flag approves it", () =>
    Effect.gen(function* () {
      const { answers, stdout: printed } = yield* answerInteraction({ approveAll: false })
      expect(answers).toHaveLength(1)
      expect(answers[0]?.approved).toBe(false)
      expect(answers[0]?.notes).toContain("--approve-all")
      expect(printed).toContain("[interaction: declined, no user to answer]")
    }),
  )

  headlessTest("--approve-all approves an interaction", () =>
    Effect.gen(function* () {
      const { answers, stdout: printed } = yield* answerInteraction({ approveAll: true })
      expect(answers).toHaveLength(1)
      expect(answers[0]?.approved).toBe(true)
      expect(answers[0]?.notes).toBeUndefined()
      expect(printed).toContain("[interaction: approved by --approve-all]")
    }),
  )

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
          events: () => Stream.concat(synchronizedAt(completed), Stream.never),
        },
        message: {
          send: () => {
            sent = true
            return Effect.void
          },
        },
      })
      const exit = yield* Effect.exit(
        runHeadless(client, sessionId, branchId, "Say hi", noUser).pipe(
          Effect.timeout("250 millis"),
        ),
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
            events: () => Stream.concat(synchronizedAt(completed), Stream.never),
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
          runHeadless(client, sessionId, branchId, "Say hi", noUser).pipe(
            Effect.timeout("5 seconds"),
          ),
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
      const exit = yield* Effect.exit(runHeadless(client, sessionId, branchId, "Say hi", noUser))
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
          events: () => Stream.concat(synchronizedAt(started, succeeded, completed), Stream.never),
        },
        message: {
          send: () => Effect.void,
        },
      })

      const captured = yield* captureStdout(
        runHeadless(client, sessionId, branchId, "Say hi", noUser).pipe(
          Effect.timeout("5 seconds"),
        ),
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
        input: Option.some({ code: "await tools.read({path: 'a.txt'})" }),
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

  headlessTest("prints each operation a cell admitted once, when it ends", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-cell-ops")
      const branchId = BranchId.make("branch-cell-ops")
      const cell = ToolCallId.make("cell-call")
      const read = ToolCallId.make("read-call")
      const events = [
        ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: cell,
          toolName: "cell",
          input: { code: "x" },
        }),
        ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: read,
          toolName: "read",
          input: { path: "a.txt" },
          parentToolCallId: cell,
        }),
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId: read,
          toolName: "read",
          output: "READ-BODY",
          parentToolCallId: cell,
        }),
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId: cell,
          toolName: "cell",
          output: encodeCellOutput({
            display: "ok",
            operations: [{ tool: "read", outcome: "succeeded", summary: "1 line" }],
          }),
        }),
        TurnCompleted.make({ sessionId, branchId, durationMs: 1 }),
      ].map((event, index) =>
        EventEnvelope.make({ id: EventId.make(index + 1), event, createdAt: 0 }),
      )
      const client = createMockClient({
        session: { events: () => Stream.concat(synchronizedAt(...events), Stream.never) },
        message: { send: () => Effect.void },
      })
      const { stdout: printed } = yield* captureStdout(
        runHeadless(client, sessionId, branchId, "run a cell", noUser).pipe(
          Effect.timeout("2 seconds"),
        ),
      )
      // The op prints its terminal block once; no running line, and no receipt repeats it.
      expect(printed.match(/read/g)).toHaveLength(1)
      expect(printed).toContain("  [tool done: read]")
      expect(printed).toContain("READ-BODY")
      expect(printed).toContain("[tool done: cell]")
    }),
  )
})
