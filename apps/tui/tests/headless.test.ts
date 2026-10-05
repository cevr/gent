import {
  ApprovalService,
  ConfigService,
  createRpcHarness,
  ErrorOccurred,
  EventId,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  MessageReceived,
  RuntimeEnvironment,
  StreamEnded,
  textStep,
  toolCallStep,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
  TEST_MODEL_ID,
} from "@gent/core/test-utils"
import { BunPlatformLive } from "@gent/core/host-bun"
import { BuiltinExtensions } from "@gent/extensions"
import { BunServices } from "@effect/platform-bun"
import { describe, it, expect, test } from "effect-bun-test"
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import * as Prompt from "effect/ai/Prompt"
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
  userMessageIdForRequest,
} from "@gent/core/protocol"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import {
  type ExitSignal,
  type HeadlessOptions,
  makeCliTeardown,
  renderHeadlessToolCall,
  runHeadless,
  waitForHeadlessReady,
} from "../src/headless"
import { createMockClient } from "./render-harness-boundary"
import { RpcClientError } from "effect/rpc/RpcClientError"
import { SocketCloseError } from "effect/socket/Socket"
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
/** Where the headless session runs: its tool paths read from here. */
const PLACE = { cwd: "/work/proj", home: "/home/test" }
const noUser: HeadlessOptions = { approveAll: false, place: PLACE }

const sessionId = SessionId.make("session-headless")
const branchId = BranchId.make("branch-headless")
const PROMPT = "Say hi"
/**
 * Stands for the run's own message in a fixture. The server names that message
 * by the send's request id, so `branchClient` replaces this id with
 * `userMessageIdForRequest(requestId)` once the run sends.
 */
const OWN_TURN = MessageId.make("own-turn")
const OLDER_TURN = MessageId.make("older-turn")
const OTHER_CLIENT_TURN = MessageId.make("other-client-turn")

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
 * older turn still running), and, once the run sends, the `afterSend` events
 * and then its own turn: the opening message, then `ownTurn`. The opening
 * message and each `TurnCompleted` that names `OWN_TURN` carry the id the
 * send's request id names, as the server writes them. The stream stays open.
 * Each send runs `sendAttempt` first; the turn opens when the attempt
 * succeeds. `send` fails with `sendFailure` when one is given, as a failed
 * turn phase fails it.
 */
const branchClient = (input: {
  readonly history?: ReadonlyArray<AgentEvent>
  readonly beforeSend?: ReadonlyArray<AgentEvent>
  readonly afterSend?: ReadonlyArray<AgentEvent>
  readonly ownTurn: ReadonlyArray<AgentEvent>
  readonly sendAttempt?: (send: {
    readonly requestId?: string
    readonly unattended?: boolean
  }) => Effect.Effect<void, RpcClientError>
  readonly sendFailure?: HeadlessRunnerTestError
  readonly respondInteraction?: (answer: {
    readonly approved: boolean
    readonly notes?: string
  }) => Effect.Effect<void>
}) => {
  // Settles with the id of the run's own message.
  const sent = Deferred.makeUnsafe<MessageId>()
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
  const after = (own: MessageId) => [
    ...(input.afterSend ?? []),
    opening(own, PROMPT),
    ...input.ownTurn.map((event) => {
      if (event._tag !== "TurnCompleted" || event.messageId !== OWN_TURN) return event
      return TurnCompleted.make({ ...event, messageId: own })
    }),
  ]
  return createMockClient({
    session: {
      events: () =>
        Stream.fromIterable(envelopes(before, 1)).pipe(
          Stream.concat(
            Stream.fromEffect(Deferred.await(sent)).pipe(
              Stream.flatMap((own) =>
                Stream.fromIterable(envelopes(after(own), before.length + 1)),
              ),
            ),
          ),
          Stream.concat(Stream.never),
        ),
    },
    message: {
      send: (send: { readonly requestId?: string; readonly unattended?: boolean }) =>
        Option.match(Option.fromUndefinedOr(input.sendAttempt), {
          onNone: () => Effect.void,
          onSome: (attempt) => attempt(send),
        }).pipe(
          Effect.andThen(
            Deferred.succeed(sent, userMessageIdForRequest(send.requestId ?? "<missing>")),
          ),
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

const run = (client: ReturnType<typeof createMockClient>, options: HeadlessOptions = noUser) =>
  runHeadless(client, sessionId, branchId, PROMPT, options).pipe(Effect.timeout("2 seconds"))

describe("runHeadless", () => {
  headlessTest("an error before the answer does not end the turn; the answer after it prints", () =>
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

  headlessTest("an error alone, plain or a notice, leaves the run waiting for its turn", () =>
    Effect.gen(function* () {
      for (const event of [
        errorOccurred("Context compaction failed; continuing"),
        errorNotice("compaction fell back"),
      ]) {
        const client = branchClient({ ownTurn: [event] })
        // Absence of an end: the run is still open when the bound expires.
        const outcome = yield* runHeadless(client, sessionId, branchId, PROMPT, noUser).pipe(
          Effect.timeoutOption("150 millis"),
        )
        expect(Option.isNone(outcome)).toBe(true)
      }
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

  headlessTest("a failed stream with no answer fails the run with a one-line message", () =>
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

  headlessTest("an interrupted turn fails the run even after partial text", () =>
    Effect.gen(function* () {
      const client = branchClient({
        ownTurn: [chunk("half an answer"), completed({ interrupted: true })],
      })
      const { result: exit, stdout } = yield* captureStdout(Effect.exit(run(client)))
      expect(stdout).toContain("half an answer")
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      expect(String(Cause.squash(exit.cause))).toContain("the turn was interrupted")
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
      const client = branchClient({
        // After the send, the older turn still streams and completes unanswered.
        afterSend: [chunk("older output"), completed({ messageId: OLDER_TURN, unanswered: true })],
        ownTurn: [chunk("the answer"), completed()],
      })
      const captured = yield* captureStdout(run(client))
      expect(captured.stdout).toContain("the answer")
      expect(captured.stdout).not.toContain("older output")
    }),
  )

  headlessTest("another client's message with the prompt's text is not the run's turn", () =>
    Effect.gen(function* () {
      const client = branchClient({
        // After the send, another client's message with the same text runs first.
        afterSend: [
          opening(OTHER_CLIENT_TURN, PROMPT),
          chunk("other client output"),
          completed({ messageId: OTHER_CLIENT_TURN, unanswered: true }),
        ],
        ownTurn: [chunk("the answer"), completed()],
      })
      const { result: exit, stdout } = yield* captureStdout(Effect.exit(run(client)))
      expect(exit._tag).toBe("Success")
      expect(stdout).toContain("the answer")
      expect(stdout).not.toContain("other client output")
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
  const answerInteraction = (options: HeadlessOptions) =>
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
      const { answers, stdout: printed } = yield* answerInteraction({
        approveAll: false,
        place: PLACE,
      })
      expect(answers).toHaveLength(1)
      expect(answers[0]?.approved).toBe(false)
      expect(answers[0]?.notes).toContain("--approve-all")
      expect(printed).toContain("[interaction: declined, no user to answer]")
    }),
  )

  headlessTest("--approve-all approves an interaction", () =>
    Effect.gen(function* () {
      const { answers, stdout: printed } = yield* answerInteraction({
        approveAll: true,
        place: PLACE,
      })
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

  headlessTest("a retried send is one message on the server, not two", () =>
    Effect.gen(function* () {
      const observedRequestIds: Array<string> = []
      let sendAttempts = 0
      const client = branchClient({
        ownTurn: [completed()],
        sendAttempt: (send) => {
          observedRequestIds.push(send.requestId ?? "<missing>")
          sendAttempts += 1
          // Fail the first two attempts with a lost connection so the
          // retry policy fires; succeed on the third.
          if (sendAttempts < 3) {
            return Effect.fail(new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) }))
          }
          return Effect.void
        },
      })
      const exit = yield* Effect.exit(
        runHeadless(client, sessionId, branchId, PROMPT, noUser).pipe(Effect.timeout("5 seconds")),
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

  // The server keeps the mark on the message: a usage limit the turn hits
  // arms no auto-resume, since nobody would watch the turn it starts.
  headlessTest("the run's message says no user watches the turn it opens", () =>
    Effect.gen(function* () {
      const sends: Array<boolean> = []
      const client = branchClient({
        ownTurn: [completed()],
        sendAttempt: (send) => Effect.sync(() => sends.push(send.unattended === true)),
      })
      const exit = yield* Effect.exit(run(client))
      expect(exit._tag).toBe("Success")
      expect(sends).toEqual([true])
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
      const background = renderHeadlessToolCall(
        {
          toolName: "bash",
          status: "completed",
          input: Option.some({ command: "sleep 100" }),
          output: Option.some(
            encodeBashOutput({ stdout: "", stderr: "", exitCode: 0, status: "background" }),
          ),
          summary: Option.none(),
        },
        PLACE,
      )
      expect(background).toContain("[tool done: bash in background]")
    }),
  )

  headlessTest("renders non-special tools through the generic fallback", () =>
    Effect.sync(() => {
      const rendered = renderHeadlessToolCall(
        {
          toolName: "read",
          status: "completed",
          input: Option.some({ path: "/tmp/example.txt" }),
          output: Option.some("plain output"),
          summary: Option.none(),
        },
        PLACE,
      )

      expect(rendered).toContain("[tool done: read]")
      expect(rendered).toContain("plain output")
    }),
  )

  // A headless run has no user: it records each background question and the
  // assumption the model goes on with, and answers none of them.
  headlessTest("a background question prints one line that says its assumption stands", () =>
    Effect.sync(() => {
      const rendered = renderHeadlessToolCall(
        {
          toolName: "ask_user_async",
          status: "completed",
          input: Option.some({
            questions: [
              { question: "Which cache backend?", assume: "in-memory LRU" },
              { question: "Which port?", assume: "8080" },
            ],
          }),
          output: Option.some(
            encodeCellOutput({
              asked: [
                { id: "call_7:0", assume: "in-memory LRU" },
                { id: "call_7:1", assume: "8080" },
              ],
              note: "Continue on your assumption.",
            }),
          ),
          summary: Option.none(),
        },
        PLACE,
      )

      expect(rendered).toBe(
        [
          "[question call_7:0: Which cache backend? · assuming in-memory LRU · no user, the assumption stands]",
          "[question call_7:1: Which port? · assuming 8080 · no user, the assumption stands]",
        ].join("\n"),
      )
    }),
  )

  headlessTest("renders cell operation receipts under the cell", () =>
    Effect.sync(() => {
      const rendered = renderHeadlessToolCall(
        {
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
        },
        PLACE,
      )

      expect(rendered).toBe("[tool done: cell]\n  ✓ read 12 lines\nok")
    }),
  )

  headlessTest("a running tool names its path from the session cwd, as the TUI does", () =>
    Effect.gen(function* () {
      const read = ToolCallId.make("read-in-session")
      const client = branchClient({
        ownTurn: [
          ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: read,
            toolName: "read",
            input: { path: `${PLACE.cwd}/src/app.ts` },
          }),
          completed(),
        ],
      })
      const { stdout: printed } = yield* captureStdout(run(client))
      expect(printed).toContain("[tool: read] src/app.ts")
      expect(printed).not.toContain(PLACE.cwd)
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

const interruptedBy = (signal: Option.Option<ExitSignal>, headless: boolean) =>
  makeCliTeardown({ signal: () => signal, interactive: () => !headless })

// A real server: the extension admin verb asks, and a headless run with no
// user declines, so nothing is written.
describe("headless extension admin", () => {
  headlessTest("a headless run declines an extension admin verb, and no config is written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* makeTempDirectoryScoped("gent-headless-admin-home-")
      const cwd = yield* makeTempDirectoryScoped("gent-headless-admin-cwd-")
      const userConfig = path.join(home, ".gent", "config.json")
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("extensions.disable", { id: "@gent/agents", scope: "user" }),
        textStep("left as it was"),
      ])
      const admin = new Set(["@gent/agents", "@gent/extension-admin"])
      const { client, sessionId, branchId } = yield* createRpcHarness({
        agents: [],
        extensionInputs: BuiltinExtensions.filter((extension) => admin.has(extension.manifest.id)),
        providerLayer,
        home,
        cwd,
        approvalLayer: ApprovalService.Live,
        // The user config on disk names no model: the session names its own.
        modelId: TEST_MODEL_ID,
        configServiceLayer: ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home })),
          Layer.provide(BunPlatformLive),
        ),
      })
      yield* runHeadless(client, sessionId, branchId, "turn the agents off", {
        approveAll: false,
        place: { cwd, home },
      }).pipe(Effect.timeout("8 seconds"))
      yield* controls.assertDone
      // The server writes a default user config at start; the verb adds nothing to it.
      const written = yield* fs.readFileString(userConfig).pipe(Effect.orElseSucceed(() => ""))
      expect(written).not.toContain("disabledExtensions")
      const events = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.takeUntil(({ event }) => event._tag === "TurnCompleted"),
        Stream.runCollect,
      )
      const output = Array.from(events).flatMap(({ event }) => {
        if (event._tag !== "ToolCallSucceeded") return []
        return [event.output]
      })
      expect(output).toHaveLength(1)
      const verb = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ applied: Schema.Boolean, detail: Schema.String })),
      )(output.join(""))
      expect(verb).toMatchObject({ applied: false, detail: expect.stringContaining("declined") })
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
  )
})

describe("headless readiness", () => {
  // A scripted caller never waits forever: a connection that never becomes
  // ready ends the run at the bound, as a connection error.
  it.live("a connection that never becomes ready ends the run at the bound", () =>
    Effect.gen(function* () {
      const waiting = yield* waitForHeadlessReady(Effect.never).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust("15 seconds")
      const error = yield* Fiber.join(waiting)
      expect(error).toBeInstanceOf(GentConnectionError)
    }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("4 seconds")),
  )
})

describe("CLI teardown", () => {
  test("a signal ends a headless run with 128 plus its signal number", () => {
    const interrupted = Exit.failCause(Cause.interrupt())
    expect(exitCodeOf(interruptedBy(Option.some("SIGHUP"), true), interrupted)).toBe(129)
    expect(exitCodeOf(interruptedBy(Option.some("SIGINT"), true), interrupted)).toBe(130)
    expect(exitCodeOf(interruptedBy(Option.some("SIGTERM"), true), interrupted)).toBe(143)
  })

  test("a signal ends the TUI cleanly", () => {
    const interrupted = Exit.failCause(Cause.interrupt())
    expect(exitCodeOf(interruptedBy(Option.some("SIGINT"), false), interrupted)).toBe(0)
    expect(exitCodeOf(interruptedBy(Option.some("SIGHUP"), false), interrupted)).toBe(0)
  })

  test("a headless run that answered exits 0, and one that failed exits 1", () => {
    const teardown = interruptedBy(Option.none(), true)
    expect(exitCodeOf(teardown, Exit.void)).toBe(0)
    expect(exitCodeOf(teardown, Exit.fail("unanswered"))).toBe(1)
  })
})
