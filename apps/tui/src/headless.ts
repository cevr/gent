import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Schedule,
  Schema,
  Stdio,
  Stream,
} from "effect"
import { formatHeadTail, type BranchId, type SessionId } from "@gent/core/protocol"
import {
  CellOperationReceipts,
  formatGenericToolText,
  toolArgSummary,
  type ToolInput,
} from "./utils.js"
import { GentConnectionError, type GentNamespacedClient } from "@gent/sdk"
import { randomId } from "./utils"

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
const decodeNumber = Schema.decodeUnknownOption(Schema.Finite)

const getString = (record: Schema.JsonObject, key: string): string =>
  Option.getOrElse(decodeString(record[key]), () => "")

const getNumber = (record: Schema.JsonObject, key: string): Option.Option<number> =>
  decodeNumber(record[key])

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

  const parsed = parseJsonObject(toolCall.output)
  if (Option.isNone(parsed)) return renderGeneric(toolCall)

  const stdout = getString(parsed.value, "stdout")
  const stderr = getString(parsed.value, "stderr")
  const exitCode = getNumber(parsed.value, "exitCode")
  let combined = stdout
  if (stderr.length > 0) combined = `${stdout}\n${stderr}`
  const lines = combined.split("\n").filter((line) => line.length > 0)
  let status = "done"
  if (toolCall.status === "error") status = "error"
  const exit = Option.match(exitCode, {
    onNone: () => "",
    onSome: (value) => ` exit ${value}`,
  })
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
      // The replay cursor. A subscription replays the stored events first (a
      // resumed session's history), then marks the start of the live events.
      // The run prints and settles on live events only.
      const synchronized = yield* Deferred.make<number>()
      // The first runtime state arrived, so a run that starts after it is seen.
      const runtimeWatched = yield* Deferred.make<void>()
      const markRuntimeWatched = Deferred.done(runtimeWatched, Exit.void)
      // Carries whether the turn answered, so the race below can fail the run
      // instead of exiting 0 on an empty transcript.
      const done = yield* Deferred.make<boolean, GentConnectionError>()
      let live = false
      let failed = false
      let wroteText = false
      let ran = false
      let idleAfterRun = false
      let checkedIdleFailure = false
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
      /**
       * `TurnCompleted` settles the run. A failed turn phase is the one end
       * that publishes `ErrorOccurred` and no `TurnCompleted`: the loop goes
       * idle after it. An error notice (a failed compaction) does not end the
       * turn, so an error alone settles nothing. After an error and a run that
       * went idle, the run reads the stored events since its start: the loop
       * stores a turn's `TurnCompleted` before it goes idle, so a replay
       * without one is a failed phase.
       */
      const settleIfIdleAfterFailure = Effect.gen(function* () {
        if (!failed || !idleAfterRun || checkedIdleFailure) return
        checkedIdleFailure = true
        const cursor = yield* Deferred.await(synchronized)
        const replay = yield* client.session.events({ sessionId, branchId, after: cursor }).pipe(
          Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
          Stream.runCollect,
        )
        // A stored `TurnCompleted` reaches the live stream, which settles on it.
        if (replay.some((envelope) => envelope.event._tag === "TurnCompleted")) return
        yield* Deferred.succeed(done, wroteText)
      }).pipe(
        Effect.catchEager((error) =>
          Deferred.fail(done, new GentConnectionError({ message: String(error) })),
        ),
      )
      const streamFiber = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.tap((envelope) =>
          Effect.gen(function* () {
            const event = envelope.event
            if (event._tag === "StreamSynchronized") {
              live = true
              yield* Deferred.succeed(synchronized, event.lastEventId)
              return
            }
            if (!live) return
            switch (event._tag) {
              case "StreamChunk":
                if (event.chunk.trim().length > 0) wroteText = true
                yield* writeStdout(event.chunk)
                break
              case "ToolCallStarted": {
                const toolCall: HeadlessToolCall = {
                  toolName: event.toolName,
                  input: Option.some(event.input),
                  status: "running",
                  summary: Option.none(),
                  output: Option.none(),
                }
                activeTools.set(String(event.toolCallId), toolCall)
                // A cell-admitted call prints once, when it ends.
                if (Predicate.isNotUndefined(event.parentToolCallId)) break
                yield* writeStdout("\n")
                yield* renderTool(toolCall)
                break
              }
              case "ToolCallSucceeded": {
                const priorInput = Option.fromNullishOr(
                  activeTools.get(String(event.toolCallId)),
                ).pipe(Option.flatMap((toolCall) => toolCall.input))
                const toolCall: HeadlessToolCall = {
                  toolName: event.toolName,
                  input: priorInput,
                  status: "completed",
                  summary: Option.fromNullishOr(event.summary),
                  output: Option.fromNullishOr(event.output),
                  operationsPrinted: cellsWithPrintedOperations.delete(String(event.toolCallId)),
                }
                activeTools.delete(String(event.toolCallId))
                if (Predicate.isNotUndefined(event.parentToolCallId))
                  cellsWithPrintedOperations.add(String(event.parentToolCallId))
                yield* renderTool(toolCall, event.parentToolCallId)
                break
              }
              case "ToolCallFailed": {
                const priorInput = Option.fromNullishOr(
                  activeTools.get(String(event.toolCallId)),
                ).pipe(Option.flatMap((toolCall) => toolCall.input))
                const toolCall: HeadlessToolCall = {
                  toolName: event.toolName,
                  input: priorInput,
                  status: "error",
                  summary: Option.fromNullishOr(event.summary),
                  output: Option.fromNullishOr(event.output),
                  operationsPrinted: cellsWithPrintedOperations.delete(String(event.toolCallId)),
                }
                activeTools.delete(String(event.toolCallId))
                if (Predicate.isNotUndefined(event.parentToolCallId))
                  cellsWithPrintedOperations.add(String(event.parentToolCallId))
                yield* renderTool(toolCall, event.parentToolCallId)
                break
              }
              case "StreamEnded":
                yield* writeStdout("\n")
                break
              case "ErrorOccurred":
                failed = true
                yield* writeStderr(`\nError: ${event.error}\n`)
                yield* settleIfIdleAfterFailure
                break
              case "TurnCompleted":
                // A failed stream ends its turn without `unanswered`; the error
                // and the empty transcript say it did not answer.
                yield* Deferred.succeed(done, event.unanswered !== true && (wroteText || !failed))
                break
              case "InteractionPresented": {
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
                  break
                }
                yield* writeStdout(`\n[interaction: declined, no user to answer]\n`)
                yield* respond({ approved: false, notes: DECLINE_NOTES })
                break
              }
              case "InteractionResolved":
                break
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      )
      yield* client.session.watchRuntime({ sessionId, branchId }).pipe(
        Stream.tap((state) =>
          Effect.gen(function* () {
            yield* markRuntimeWatched
            if (state._tag !== "Idle") {
              ran = true
              return
            }
            if (!ran) return
            idleAfterRun = true
            yield* settleIfIdleAfterFailure
          }),
        ),
        Stream.runDrain,
        Effect.catchEager((error) =>
          Deferred.fail(done, new GentConnectionError({ message: String(error) })),
        ),
        Effect.ensuring(markRuntimeWatched),
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

      // Send after both subscriptions are open, so the turn's first event and
      // its first runtime move are live, not history.
      yield* Effect.raceFirst(
        Effect.all([Deferred.await(synchronized), Deferred.await(runtimeWatched)]),
        streamEnded,
      )

      const sendRequestId = yield* randomId
      yield* Effect.suspend(() =>
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
          while: (error) => {
            const text = String(error)
            return text.includes("RpcClientError") || text.includes("SocketOpenError")
          },
        }),
        Effect.withSpan("Headless.sendMessage"),
      )

      const answered = yield* Effect.raceFirst(Deferred.await(done), streamEnded)
      yield* Fiber.interrupt(streamFiber).pipe(Effect.asVoid)
      if (!answered) {
        return yield* new HeadlessUnansweredError({
          message: "the turn ended without an answer",
        })
      }
    }),
  )
