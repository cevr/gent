import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Runtime,
  Schedule,
  Schema,
  Stdio,
  Stream,
} from "effect"
import {
  formatHeadTail,
  type AgentEvent,
  type BranchId,
  type Message,
  type SessionId,
  GentConnectionError,
  type GentNamespacedClient,
} from "@gent/core/protocol"
import {
  CellOperationReceipts,
  formatGenericToolText,
  parseBashOutput,
  toolArgSummary,
  isConnectionLoss,
  randomId,
  type ToolInput,
} from "./utils.js"

// ── headless tool renderers ─────────────────────────────────────────────────

interface HeadlessToolCall {
  readonly toolName: string
  readonly input: Option.Option<ToolInput>
  readonly status: "running" | "completed" | "error"
  readonly summary: Option.Option<string>
  readonly output: Option.Option<string>
  /** A cell whose admitted calls already printed as their own lines; its receipts would repeat them. */
  readonly operationsPrinted?: boolean
}

type HeadlessToolRenderer = (toolCall: HeadlessToolCall) => Option.Option<string>

const inputSummary = (toolName: string, input: Option.Option<ToolInput>): string =>
  Option.match(input, {
    onNone: () => "",
    onSome: (value) => toolArgSummary(toolName, value),
  })

const outputText = (toolCall: HeadlessToolCall): Option.Option<string> =>
  toolCall.output.pipe(
    Option.orElse(() => toolCall.summary),
    Option.flatMap((text) => Option.fromNullishOr(formatGenericToolText(text))),
  )

const JsonObject = Schema.fromJsonString(Schema.JsonObject)

const parseJsonObject = (text: Option.Option<string>) =>
  text.pipe(Option.flatMap(Schema.decodeUnknownOption(JsonObject)))

const decodeString = Schema.decodeUnknownOption(Schema.String)

const getString = (record: Schema.JsonObject, key: string): string =>
  Option.getOrElse(decodeString(record[key]), () => "")

const renderGeneric: HeadlessToolRenderer = (toolCall) => {
  const summary = inputSummary(toolCall.toolName, toolCall.input)
  if (toolCall.status === "running") {
    if (summary.length > 0) return Option.some(`[tool: ${toolCall.toolName}] ${summary}`)
    return Option.some(`[tool: ${toolCall.toolName}]`)
  }

  const text = outputText(toolCall)
  let suffix = ""
  if (toolCall.status === "error") suffix = " (error)"
  if (Option.isNone(text) || text.value.trim().length === 0) {
    return Option.some(`[tool done: ${toolCall.toolName}${suffix}]`)
  }
  return Option.some(
    `[tool done: ${toolCall.toolName}${suffix}]\n${formatHeadTail(text.value.split("\n"), 12)}`,
  )
}

const BashHeadlessToolRenderer: HeadlessToolRenderer = (toolCall) => {
  const command = inputSummary("bash", toolCall.input)
  if (toolCall.status === "running") {
    if (command.length > 0) return Option.some(`[tool: bash] ${command}`)
    return Option.some("[tool: bash]")
  }

  const parsed = parseBashOutput(Option.getOrUndefined(toolCall.output))
  if (Option.isNone(parsed)) return renderGeneric(toolCall)

  const { stdout, stderr, exitCode } = parsed.value
  // A background command has not ended: it has no exit code yet.
  let exit = ` exit ${exitCode}`
  if (Option.contains(parsed.value.status, "background")) exit = " in background"
  let combined = stdout
  if (stderr.length > 0) combined = `${stdout}\n${stderr}`
  const lines = combined.split("\n").filter((line) => line.length > 0)
  let status = "done"
  if (toolCall.status === "error") status = "error"
  const renderedOutput = formatHeadTail(lines, 12)

  if (renderedOutput.length === 0) return Option.some(`[tool ${status}: bash${exit}]`)
  return Option.some(`[tool ${status}: bash${exit}]\n${renderedOutput}`)
}

const decodeReceipts = Schema.decodeUnknownOption(CellOperationReceipts)

const receiptGlyph = (outcome: "succeeded" | "failed" | "incomplete") => {
  if (outcome === "succeeded") return "✓"
  if (outcome === "failed") return "✕"
  return "?"
}

const CellHeadlessToolRenderer: HeadlessToolRenderer = (toolCall) => {
  const firstLine = inputSummary("cell", toolCall.input)
  if (toolCall.status === "running") {
    if (firstLine.length > 0) return Option.some(`[tool: cell] ${firstLine}`)
    return Option.some("[tool: cell]")
  }

  const parsed = parseJsonObject(toolCall.output)
  if (Option.isNone(parsed)) return renderGeneric(toolCall)

  let status = "done"
  if (toolCall.status === "error") status = "error"
  const lines: string[] = [`[tool ${status}: cell]`]
  let receipts = Option.match(decodeReceipts(parsed.value), {
    onNone: () => [],
    onSome: (value) => value.operations ?? [],
  })
  if (toolCall.operationsPrinted === true) receipts = []
  for (const receipt of receipts) {
    let line = `  ${receiptGlyph(receipt.outcome)} ${receipt.tool}`
    if (receipt.summary.length > 0) line = `${line} ${receipt.summary}`
    lines.push(line)
  }
  const message = getString(parsed.value, "message")
  if (message.length > 0) lines.push(message)
  const display = getString(parsed.value, "display")
    .split("\n")
    .filter((line) => line.length > 0)
  if (display.length > 0) lines.push(formatHeadTail(display, 12))
  return Option.some(lines.join("\n"))
}

/** Tools with a dedicated headless line; every other tool renders generically. */
const HEADLESS_TOOL_RENDERERS: ReadonlyMap<string, HeadlessToolRenderer> = new Map([
  ["bash", BashHeadlessToolRenderer],
  ["cell", CellHeadlessToolRenderer],
])

export const renderHeadlessToolCall = (toolCall: HeadlessToolCall): string => {
  const renderer = Option.getOrElse(
    Option.fromNullishOr(HEADLESS_TOOL_RENDERERS.get(toolCall.toolName.toLowerCase())),
    () => renderGeneric,
  )
  return renderer(toolCall).pipe(
    Option.orElse(() => renderGeneric(toolCall)),
    Option.getOrElse(() => `[tool: ${toolCall.toolName}]`),
  )
}

// ── headless run loop ───────────────────────────────────────────────────────

/**
 * The turn finished without an answer: the model spent its continuations and
 * came back empty, or the turn failed before it answered. Distinct from a
 * connection fault. Failing here is what gives a scripted caller a non-zero
 * exit — a silent exit 0 with no output is indistinguishable from success.
 */
class HeadlessUnansweredError extends Schema.TaggedError<HeadlessUnansweredError>()(
  "HeadlessUnansweredError",
  { message: Schema.String },
) {}

export interface HeadlessOptions {
  /**
   * Approve every interaction the turn presents. Off by default: a headless
   * run has no user, so it declines each ask, as a session with no user does.
   */
  readonly approveAll: boolean
}

/** What the model reads when the run declines its ask. */
const DECLINE_NOTES =
  "Declined: this is a headless run and no user is present to answer. Report what you would do; a user can rerun the prompt with --approve-all to approve every ask."

const messageText = (message: Message): string =>
  message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text]
      return []
    })
    .join("")

/** How the run draws a tool call that ended. */
const TOOL_END_STATUS = {
  ToolCallSucceeded: "completed",
  ToolCallFailed: "error",
} satisfies Record<"ToolCallSucceeded" | "ToolCallFailed", HeadlessToolCall["status"]>

/** A user message a client sent with this text: the opening message of a run's turn. */
const isClientPrompt = (message: Message, text: string): boolean =>
  message._tag === "regular" &&
  message.role === "user" &&
  Option.fromNullishOr(message.metadata).pipe(
    Option.exists((metadata) => metadata.fromClient === true),
  ) &&
  messageText(message) === text

/** How the run's own turn ended, read from its `TurnCompleted` receipt. */
type TurnEnd = "answered" | "unanswered" | "interrupted"

const TURN_END_MESSAGE = {
  unanswered: "the turn ended without an answer",
  interrupted: "the turn was interrupted",
} satisfies Record<Exclude<TurnEnd, "answered">, string>

/**
 * The receipt decides. An interrupted turn and a failed stream did not
 * answer, whatever text came before the end: that text is a truncated answer,
 * and it has printed already. A receipt without either flag (a historical one)
 * falls back to the transcript: an error with no answer text is no answer.
 */
const turnEnd = (
  event: Extract<AgentEvent, { readonly _tag: "TurnCompleted" }>,
  transcript: { readonly wroteText: boolean; readonly failed: boolean },
): TurnEnd => {
  if (event.interrupted === true) return "interrupted"
  if (event.streamFailed === true || event.unanswered === true) return "unanswered"
  if (transcript.failed && !transcript.wroteText) return "unanswered"
  return "answered"
}

/** An error the run reports on one stderr line. */
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, " ").trim()

export const runHeadless = (
  client: GentNamespacedClient,
  sessionId: SessionId,
  branchId: BranchId,
  promptText: string,
  options: HeadlessOptions,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio
      const writeStdout = (text: string) => Stream.make(text).pipe(Stream.run(stdio.stdout()))
      const writeStderr = (text: string) => Stream.make(text).pipe(Stream.run(stdio.stderr()))
      // A subscription replays the stored events first (a resumed session's
      // history), then marks the start of the live events. The run sends after
      // the mark, so the turn it opens arrives live.
      const synchronized = yield* Deferred.make<void>()
      // Settles with how the run's own turn ended.
      const done = yield* Deferred.make<TurnEnd>()
      let live = false
      let sent = false
      /**
       * The opening message of the run's own turn. The branch may be running
       * an older turn when the prompt arrives; that turn's output, errors,
       * asks and `TurnCompleted` are not this run's. A turn starts with the
       * `MessageReceived` of its opening message, and the branch runs one turn
       * at a time, so the events from the run's opening message to the
       * `TurnCompleted` that names it are the run's turn. The opening message
       * is the first client-sent user message with the prompt's text after the
       * run sent it.
       */
      let ownTurn = Option.none<Message["id"]>()
      let ownTurnEnded = false
      const inOwnTurn = () => Option.isSome(ownTurn) && !ownTurnEnded
      // Errors of the run's turn, notices included. The run's end owns
      // stderr: one line.
      const errors: Array<string> = []
      // An error that is not a notice: without answer text, the turn failed.
      let failed = false
      let wroteText = false
      const activeTools = new Map<string, HeadlessToolCall>()
      // Cells whose admitted calls printed their own lines.
      const cellsWithPrintedOperations = new Set<string>()
      const renderTool = (toolCall: HeadlessToolCall, parentToolCallId?: string) => {
        const rendered = renderHeadlessToolCall(toolCall)
        if (Predicate.isUndefined(parentToolCallId)) return writeStdout(`${rendered}\n`)
        // Cell-admitted calls stay visibly nested under their cell.
        const nested = rendered
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")
        return writeStdout(`${nested}\n`)
      }
      const toolStarted = (event: Extract<AgentEvent, { readonly _tag: "ToolCallStarted" }>) => {
        const toolCall: HeadlessToolCall = {
          toolName: event.toolName,
          input: Option.some(event.input),
          status: "running",
          summary: Option.none(),
          output: Option.none(),
        }
        activeTools.set(String(event.toolCallId), toolCall)
        // A cell-admitted call prints once, when it ends.
        if (Predicate.isNotUndefined(event.parentToolCallId)) return Effect.void
        return writeStdout("\n").pipe(Effect.andThen(renderTool(toolCall)))
      }
      // The run settles on the `TurnCompleted` that names its opening message.
      const turnCompleted = (event: Extract<AgentEvent, { readonly _tag: "TurnCompleted" }>) => {
        if (!Option.contains(ownTurn, event.messageId)) return Effect.void
        ownTurnEnded = true
        return Deferred.succeed(done, turnEnd(event, { wroteText, failed }))
      }
      const toolEnded = (
        event: Extract<AgentEvent, { readonly _tag: "ToolCallSucceeded" | "ToolCallFailed" }>,
      ) => {
        const priorInput = Option.fromNullishOr(activeTools.get(String(event.toolCallId))).pipe(
          Option.flatMap((toolCall) => toolCall.input),
        )
        const status = TOOL_END_STATUS[event._tag]
        const toolCall: HeadlessToolCall = {
          toolName: event.toolName,
          input: priorInput,
          status,
          summary: Option.fromNullishOr(event.summary),
          output: Option.fromNullishOr(event.output),
          operationsPrinted: cellsWithPrintedOperations.delete(String(event.toolCallId)),
        }
        activeTools.delete(String(event.toolCallId))
        if (Predicate.isNotUndefined(event.parentToolCallId))
          cellsWithPrintedOperations.add(String(event.parentToolCallId))
        return renderTool(toolCall, event.parentToolCallId)
      }
      const answerInteraction = (
        event: Extract<AgentEvent, { readonly _tag: "InteractionPresented" }>,
      ) =>
        Effect.gen(function* () {
          const respond = (answer: { readonly approved: boolean; readonly notes?: string }) =>
            client.interaction
              .respondInteraction({
                requestId: event.requestId,
                sessionId,
                branchId,
                ...answer,
              })
              .pipe(Effect.catchEager(() => Effect.void))
          if (options.approveAll) {
            yield* writeStdout(`\n[interaction: approved by --approve-all]\n`)
            yield* respond({ approved: true })
            return
          }
          yield* writeStdout(`\n[interaction: declined, no user to answer]\n`)
          yield* respond({ approved: false, notes: DECLINE_NOTES })
        })
      const streamFiber = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.tap((envelope) =>
          Effect.gen(function* () {
            const event = envelope.event
            if (event._tag === "StreamSynchronized") {
              live = true
              yield* Deferred.done(synchronized, Exit.void)
              return
            }
            if (!live) return
            if (event._tag === "MessageReceived") {
              if (sent && Option.isNone(ownTurn) && isClientPrompt(event.message, promptText))
                ownTurn = Option.some(event.message.id)
              return
            }
            if (!inOwnTurn()) return
            switch (event._tag) {
              case "StreamChunk":
                if (event.chunk.trim().length > 0) wroteText = true
                yield* writeStdout(event.chunk)
                break
              case "ToolCallStarted":
                yield* toolStarted(event)
                break
              case "ToolCallSucceeded":
              case "ToolCallFailed":
                yield* toolEnded(event)
                break
              case "StreamEnded":
                yield* writeStdout("\n")
                break
              case "ErrorOccurred":
                // An error does not end the turn; its `TurnCompleted` or the
                // send does. A notice (a compaction fallback) does not fail it.
                errors.push(oneLine(event.error))
                if (event.notice !== true) failed = true
                break
              case "TurnCompleted":
                yield* turnCompleted(event)
                break
              case "InteractionPresented":
                yield* answerInteraction(event)
                break
              case "InteractionResolved":
                break
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      )

      const streamEnded = Fiber.await(streamFiber).pipe(
        Effect.flatMap((exit) =>
          Exit.match(exit, {
            onFailure: (cause) =>
              Effect.fail(
                new GentConnectionError({
                  message: Cause.pretty(cause),
                }),
              ),
            onSuccess: () =>
              Effect.fail(
                new GentConnectionError({
                  message: "headless event stream ended before turn completion",
                }),
              ),
          }),
        ),
      )

      yield* Effect.raceFirst(Deferred.await(synchronized), streamEnded)

      // The send returns when the loop lets the run's message go. The run
      // settles on its turn's `TurnCompleted`, which the loop stores before it
      // lets the message go; a failed phase appends one with `streamFailed`.
      // A send that fails is the fallback end, for a turn that never got a
      // receipt.
      const sendRequestId = yield* randomId
      sent = true
      const sendFiber = yield* Effect.suspend(() =>
        client.message.send({
          sessionId,
          branchId,
          content: promptText,
          requestId: sendRequestId,
        }),
      ).pipe(
        Effect.retry({
          schedule: Schedule.spaced("250 millis"),
          times: 20,
          while: isConnectionLoss,
        }),
        Effect.withSpan("Headless.sendMessage"),
        Effect.forkScoped,
      )
      const sendFailed = Fiber.join(sendFiber).pipe(Effect.andThen(Effect.never))

      const end = yield* Effect.raceFirst(
        Deferred.await(done),
        Effect.raceFirst(streamEnded, sendFailed),
      )
      yield* Fiber.interrupt(streamFiber).pipe(Effect.asVoid)
      if (end !== "answered") {
        let message = TURN_END_MESSAGE[end]
        if (errors.length > 0) message = `${message}: ${errors.join("; ")}`
        return yield* new HeadlessUnansweredError({ message })
      }
      // An answered turn's notices, one line each.
      for (const error of errors) yield* writeStderr(`Warning: ${error}\n`)
    }),
  )

// ── process exit ────────────────────────────────────────────────────────────

export type ExitSignal = "SIGINT" | "SIGTERM"

/** 128 plus the signal number, as a shell reports a process a signal ended. */
const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } satisfies Record<ExitSignal, number>

/**
 * How the CLI's exit becomes the process exit code.
 *
 * A signal interrupts the root fiber. For the TUI that is a quit and exits 0.
 * A headless run a signal ended did not answer, and a caller that chains
 * `gent -H … && next` must not read it as success, so it exits 130 or 143.
 * Any other failure takes the default teardown's code.
 */
export const makeCliTeardown =
  (run: {
    readonly signal: () => Option.Option<ExitSignal>
    readonly headless: () => boolean
  }): Runtime.Teardown =>
  (exit, onExit) => {
    if (Exit.isSuccess(exit)) {
      onExit(0)
      return
    }
    if (Cause.hasInterruptsOnly(exit.cause)) {
      const signal = run.signal()
      if (run.headless() && Option.isSome(signal)) {
        onExit(SIGNAL_EXIT_CODE[signal.value])
        return
      }
      onExit(0)
      return
    }
    Runtime.defaultTeardown(exit, onExit)
  }
