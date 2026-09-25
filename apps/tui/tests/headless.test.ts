import {
  ErrorOccurred,
  EventId,
  MessageReceived,
  StreamEnded,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
} from "@gent/core/test-utils"
import { describe, it, expect, test } from "effect-bun-test"
import { Cause, Deferred, Effect, Exit, Option, Schema, Sink, Stdio, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  AgentEvent,
  BranchId,
  dateFromMillis,
  EventEnvelope,
  Message,
  MessageId,
  SessionId,
  ToolCallId,
  GentConnectionError,
} from "@gent/core/protocol"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import { makeCliTeardown, renderHeadlessToolCall, runHeadless } from "../src/headless"
import { createMockClient } from "./render-harness-boundary"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { SocketCloseError } from "effect/unstable/socket/Socket"
class HeadlessRunnerTestError extends Schema.TaggedError<HeadlessRunnerTestError>()(
  "HeadlessRunnerTestError",
  { message: Schema.String },
) {}
const BashOutputJson = Schema.fromJsonString(
  Schema.Struct({
    stdout: Schema.String,
    stderr: Schema.String,
    exitCode: Schema.Finite,
    status: Schema.optional(Schema.Literals(["background"])),
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
const PROMPT = "Say hi"
const OWN_TURN = MessageId.make("own-turn")
const OLDER_TURN = MessageId.make("older-turn")

/** The client-sent message that opens a turn, as its `MessageReceived` carries it. */
const opening = (id: MessageId, text: string) =>
  MessageReceived.make({
    message: Message.cases.regular.make({
      id,
      sessionId,
      branchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(0),
      metadata: { fromClient: true },
    }),
  })
const chunk = (text: string) =>
  AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: text })
const completed = (
  fields: {
    readonly unanswered?: boolean
    readonly interrupted?: boolean
    readonly streamFailed?: boolean
    readonly messageId?: MessageId
  } = {},
) => TurnCompleted.make({ sessionId, branchId, durationMs: 1, messageId: OWN_TURN, ...fields })
const errorOccurred = (error: string) => ErrorOccurred.make({ sessionId, branchId, error })
/** An error the turn continues past, such as a compaction fallback. */
const errorNotice = (error: string) =>
  ErrorOccurred.make({ sessionId, branchId, error, notice: true })

/**
 * A branch as one run sees it: the stored history, the synchronization
 * marker, the live events that come before the run's prompt is sent (an
 * older turn still running), and, once the run sends, its own turn: the
 * opening message, then `ownTurn`. The stream stays open. `send` fails with
 * `sendFailure` when one is given, as a failed turn phase fails it.
 */
const branchClient = (input: {
  readonly history?: ReadonlyArray<AgentEvent>
  readonly beforeSend?: ReadonlyArray<AgentEvent>
  readonly ownTurn: ReadonlyArray<AgentEvent>
  readonly sendFailure?: HeadlessRunnerTestError
  readonly respondInteraction?: (answer: {
    readonly approved: boolean
    readonly notes?: string
  }) => Effect.Effect<void>
}) => {
  const sent = Deferred.makeUnsafe<void>()
  const history = input.history ?? []
  const envelopes = (events: ReadonlyArray<AgentEvent>, from: number) =>
    events.map((event, index) =>
      EventEnvelope.make({ id: EventId.make(from + index), event, createdAt: 0 }),
    )
  const marker = AgentEvent.cases.StreamSynchronized.make({
    sessionId,
    branchId,
    lastEventId: EventId.make(history.length),
  })
  const before = [...history, marker, ...(input.beforeSend ?? [])]
  const after = [opening(OWN_TURN, PROMPT), ...input.ownTurn]
  return createMockClient({
    session: {
      events: () =>
        Stream.fromIterable(envelopes(before, 1)).pipe(
          Stream.concat(
            Stream.fromEffect(Deferred.await(sent)).pipe(
              Stream.flatMap(() => Stream.fromIterable(envelopes(after, before.length + 1))),
            ),
          ),
          Stream.concat(Stream.never),
        ),
    },
    message: {
      send: () =>
        Deferred.done(sent, Exit.void).pipe(
          Effect.andThen(
            Option.match(Option.fromUndefinedOr(input.sendFailure), {
              onNone: () => Effect.void,
              onSome: (failure) => Effect.fail(failure),
            }),
          ),
        ),
    },
    interaction: {
      respondInteraction: (answer: { readonly approved: boolean; readonly notes?: string }) =>
        Option.match(Option.fromUndefinedOr(input.respondInteraction), {
          onNone: () => Effect.void,
          onSome: (respond) => respond(answer),
        }),
    },
  })
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

const run = (
  client: ReturnType<typeof createMockClient>,
  options: { readonly approveAll: boolean } = noUser,
) => runHeadless(client, sessionId, branchId, PROMPT, options).pipe(Effect.timeout("2 seconds"))

describe("runHeadless", () => {
  headlessTest("an error notice does not end the turn; the answer after it prints", () =>
    Effect.gen(function* () {
      const client = branchClient({
        ownTurn: [
          errorOccurred("Context compaction failed; continuing"),
          chunk("the answer"),
          completed(),
        ],
      })
      const captured = yield* captureStdout(run(client))
      expect(captured.stdout).toContain("the answer")
      // The run's end owns stderr: an answered turn reports its notice once.
      expect(capturedErrors.join("")).toBe("Warning: Context compaction failed; continuing\n")
    }),
  )

  headlessTest("an error notice alone leaves the run waiting for its turn", () =>
    Effect.gen(function* () {
      const client = branchClient({
        ownTurn: [errorOccurred("Context compaction failed; continuing")],
      })
      // Absence of an end: the run is still open when the bound expires.
      const outcome = yield* runHeadless(client, sessionId, branchId, PROMPT, noUser).pipe(
        Effect.timeoutOption("150 millis"),
      )
      expect(Option.isNone(outcome)).toBe(true)
    }),
  )

  headlessTest("a notice does not fail a turn that ends without answer text", () =>
    Effect.gen(function* () {
      const client = branchClient({
        ownTurn: [errorNotice("compaction fell back to truncation"), completed()],
      })
      capturedErrors.length = 0
      const exit = yield* Effect.exit(run(client))
      expect(exit._tag).toBe("Success")
      expect(capturedErrors.join("")).toBe("Warning: compaction fell back to truncation\n")
    }),
  )

  headlessTest("a notice alone leaves the run waiting for its turn", () =>
    Effect.gen(function* () {
      const client = branchClient({
        ownTurn: [errorNotice("compaction fell back")],
      })
      const outcome = yield* runHeadless(client, sessionId, branchId, PROMPT, noUser).pipe(
        Effect.timeoutOption("150 millis"),
      )
      expect(Option.isNone(outcome)).toBe(true)
    }),
  )

  headlessTest("a failed stream with no answer fails the run with one stderr line", () =>
    Effect.gen(function* () {
      const client = branchClient({
        ownTurn: [
          StreamEnded.make({ sessionId, branchId, outcome: "Failed" }),
          errorOccurred("provider unavailable:\n  rate limited"),
          completed(),
        ],
      })
      capturedErrors.length = 0
      const exit = yield* Effect.exit(run(client))
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const failure = Cause.squash(exit.cause)
      expect(String(failure)).toContain("HeadlessUnansweredError")
      // The failure is the one report: the run wrote nothing to stderr itself,
      // and the message it hands the CLI is one line.
      expect(capturedErrors).toEqual([])
      expect(failure instanceof Error && failure.message).toBe(
        "the turn ended without an answer: provider unavailable: rate limited",
      )
    }),
  )

  // The receipt says the stream failed, so the text before the failure is a
  // truncated answer: it prints, and the run still exits non-zero.
  headlessTest("a failed stream after partial text prints it and fails the run", () =>
    Effect.gen(function* () {
      const client = branchClient({
        ownTurn: [
          chunk("partial answer"),
          errorOccurred("provider unavailable"),
          completed({ streamFailed: true }),
        ],
      })
      const { result: exit, stdout } = yield* captureStdout(Effect.exit(run(client)))
      expect(stdout).toContain("partial answer")
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      expect(String(Cause.squash(exit.cause))).toContain(
        "the turn ended without an answer: provider unavailable",
      )
    }),
  )

  headlessTest("an interrupted turn fails the run", () =>
    Effect.gen(function* () {
      const client = branchClient({ ownTurn: [completed({ interrupted: true })] })
      const exit = yield* Effect.exit(run(client))
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      expect(String(Cause.squash(exit.cause))).toContain("the turn was interrupted")
    }),
  )

  headlessTest("an interrupted turn fails the run even after partial text", () =>
    Effect.gen(function* () {
      const client = branchClient({
        ownTurn: [chunk("half an answer"), completed({ interrupted: true })],
      })
      const { result: exit, stdout } = yield* captureStdout(Effect.exit(run(client)))
      expect(stdout).toContain("half an answer")
      expect(exit._tag).toBe("Failure")
    }),
  )

  headlessTest("a failed turn phase fails the run through the send that opened it", () =>
    Effect.gen(function* () {
      const client = branchClient({
        ownTurn: [errorOccurred("storage is busy")],
        sendFailure: new HeadlessRunnerTestError({ message: "turn failed: storage is busy" }),
      })
      const exit = yield* Effect.exit(run(client))
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      expect(String(Cause.squash(exit.cause))).toContain("turn failed: storage is busy")
    }),
  )

  headlessTest("an older turn's output and errors before the run's turn are not the run's", () =>
    Effect.gen(function* () {
      const client = branchClient({
        // The branch was running an older turn when the run subscribed.
        beforeSend: [chunk("older output"), errorOccurred("older failure")],
        ownTurn: [chunk("the answer"), completed()],
      })
      const captured = yield* captureStdout(run(client))
      expect(captured.stdout).toContain("the answer")
      expect(captured.stdout).not.toContain("older output")
      expect(capturedErrors).toEqual([])
    }),
  )

  headlessTest("an older turn's TurnCompleted after the send settles nothing", () =>
    Effect.gen(function* () {
      const sent = Deferred.makeUnsafe<void>()
      const events = [
        AgentEvent.cases.StreamSynchronized.make({
          sessionId,
          branchId,
          lastEventId: EventId.make(0),
        }),
      ]
      // After the send: the older turn still streams and completes unanswered,
      // then the run's own turn opens and answers.
      const live = [
        chunk("older output"),
        completed({ messageId: OLDER_TURN, unanswered: true }),
        opening(OWN_TURN, PROMPT),
        chunk("the answer"),
        completed(),
      ]
      const client = createMockClient({
        session: {
          events: () =>
            Stream.fromIterable(
              events.map((event, index) =>
                EventEnvelope.make({ id: EventId.make(index + 1), event, createdAt: 0 }),
              ),
            ).pipe(
              Stream.concat(
                Stream.fromEffect(Deferred.await(sent)).pipe(
                  Stream.flatMap(() =>
                    Stream.fromIterable(
                      live.map((event, index) =>
                        EventEnvelope.make({ id: EventId.make(index + 2), event, createdAt: 0 }),
                      ),
                    ),
                  ),
                ),
              ),
              Stream.concat(Stream.never),
            ),
        },
        message: { send: () => Deferred.done(sent, Exit.void).pipe(Effect.asVoid) },
      })
      const captured = yield* captureStdout(run(client))
      expect(captured.stdout).toContain("the answer")
      expect(captured.stdout).not.toContain("older output")
    }),
  )

  headlessTest("a resumed session's history neither prints nor settles the run", () =>
    Effect.gen(function* () {
      const client = branchClient({
        history: [
          opening(OLDER_TURN, PROMPT),
          chunk("old answer"),
          completed({ messageId: OLDER_TURN, unanswered: true }),
        ],
        ownTurn: [chunk("new answer"), completed()],
      })
      const captured = yield* captureStdout(run(client))
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
      const client = branchClient({
        ownTurn: [presented, chunk("done"), completed()],
        respondInteraction: (answer) =>
          Effect.sync(() => {
            answers.push(answer)
          }),
      })
      const captured = yield* captureStdout(run(client, options))
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
      const exit = yield* Effect.exit(run(branchClient({ ownTurn: [completed()] })))
      expect(exit._tag).toBe("Success")
    }),
  )

  headlessTest(
    "retries reuse the same sendRequestId so the server-side dedup collapses them onto one mutation",
    () =>
      Effect.gen(function* () {
        const observedRequestIds: Array<string> = []
        let sendAttempts = 0
        const sent = Deferred.makeUnsafe<void>()
        const marker = AgentEvent.cases.StreamSynchronized.make({
          sessionId,
          branchId,
          lastEventId: EventId.make(0),
        })
        const live = [opening(OWN_TURN, PROMPT), completed()]
        const client = createMockClient({
          session: {
            events: () =>
              Stream.make(
                EventEnvelope.make({ id: EventId.make(1), event: marker, createdAt: 0 }),
              ).pipe(
                Stream.concat(
                  Stream.fromEffect(Deferred.await(sent)).pipe(
                    Stream.flatMap(() =>
                      Stream.fromIterable(
                        live.map((event, index) =>
                          EventEnvelope.make({ id: EventId.make(index + 2), event, createdAt: 0 }),
                        ),
                      ),
                    ),
                  ),
                ),
                Stream.concat(Stream.never),
              ),
          },
          message: {
            send: (input: { requestId?: string }) => {
              observedRequestIds.push(input.requestId ?? "<missing>")
              sendAttempts += 1
              // Fail the first two attempts with a lost connection so the
              // retry policy fires; succeed on the third.
              if (sendAttempts < 3) {
                return Effect.fail(
                  new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) }),
                )
              }
              return Deferred.done(sent, Exit.void).pipe(Effect.asVoid)
            },
          },
        })
        const exit = yield* Effect.exit(
          runHeadless(client, sessionId, branchId, PROMPT, noUser).pipe(
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
      const client = createMockClient({
        session: {
          events: () => Stream.empty,
        },
        message: {
          send: () => Effect.void,
        },
      })
      const exit = yield* Effect.exit(runHeadless(client, sessionId, branchId, PROMPT, noUser))
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
      const toolCallId = ToolCallId.make("tool-call-test")
      const outputLines = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")
      const client = branchClient({
        ownTurn: [
          ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId,
            toolName: "bash",
            input: { command: "printf many-lines" },
          }),
          ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId,
            toolName: "bash",
            output: encodeBashOutput({ stdout: outputLines, stderr: "", exitCode: 0 }),
          }),
          completed(),
        ],
      })

      const captured = yield* captureStdout(run(client))
      expect(captured.stdout).toContain("[tool: bash] printf many-lines")
      expect(captured.stdout).toContain("[tool done: bash exit 0]")
      expect(captured.stdout).toContain("line 0")
      expect(captured.stdout).toContain("line 19")
      expect(captured.stdout).toContain("[8 lines truncated]")
      expect(captured.stdout).not.toContain('"stdout"')
    }),
  )

  headlessTest("a background bash command prints as in background, not as an exit code", () =>
    Effect.sync(() => {
      const background = renderHeadlessToolCall({
        toolName: "bash",
        status: "completed",
        input: Option.some({ command: "sleep 100" }),
        output: Option.some(
          encodeBashOutput({ stdout: "", stderr: "", exitCode: 0, status: "background" }),
        ),
        summary: Option.none(),
      })
      expect(background).toContain("[tool done: bash in background]")
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
      const cell = ToolCallId.make("cell-call")
      const read = ToolCallId.make("read-call")
      const client = branchClient({
        ownTurn: [
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
          completed(),
        ],
      })
      const { stdout: printed } = yield* captureStdout(run(client))
      // The op prints its terminal block once; no running line, and no receipt repeats it.
      expect(printed.match(/read/g)).toHaveLength(1)
      expect(printed).toContain("  [tool done: read]")
      expect(printed).toContain("READ-BODY")
      expect(printed).toContain("[tool done: cell]")
    }),
  )
})

// ── process exit ────────────────────────────────────────────────────────────

/** The code a teardown hands the process for `exit`. */
const exitCodeOf = (
  teardown: ReturnType<typeof makeCliTeardown>,
  exit: Exit.Exit<unknown, unknown>,
): number => {
  let code = -1
  teardown(exit, (value) => {
    code = value
  })
  return code
}

const interruptedBy = (signal: Option.Option<"SIGINT" | "SIGTERM">, headless: boolean) =>
  makeCliTeardown({ signal: () => signal, headless: () => headless })

describe("CLI teardown", () => {
  test("a signal ends a headless run non-zero: 130 for SIGINT, 143 for SIGTERM", () => {
    const interrupted = Exit.failCause(Cause.interrupt())
    expect(exitCodeOf(interruptedBy(Option.some("SIGINT"), true), interrupted)).toBe(130)
    expect(exitCodeOf(interruptedBy(Option.some("SIGTERM"), true), interrupted)).toBe(143)
  })

  test("a signal ends the TUI cleanly", () => {
    const interrupted = Exit.failCause(Cause.interrupt())
    expect(exitCodeOf(interruptedBy(Option.some("SIGINT"), false), interrupted)).toBe(0)
  })

  test("a headless run that answered exits 0, and one that failed exits 1", () => {
    const teardown = interruptedBy(Option.none(), true)
    expect(exitCodeOf(teardown, Exit.void)).toBe(0)
    expect(exitCodeOf(teardown, Exit.fail("unanswered"))).toBe(1)
  })
})
