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
import { formatHeadTail } from "@gent/core-internal/domain/head-tail.js"
import { formatGenericToolText, toolArgSummary, type ToolInput } from "./utils.js"
import type { AgentName, BranchId, RunSpec, SessionId } from "@gent/core/protocol"
import { GentConnectionError, type GentNamespacedClient } from "@gent/sdk"
import { randomId } from "./utils"

// ── headless tool renderers ─────────────────────────────────────────────────

interface HeadlessToolCall {
  readonly toolName: string
  readonly input: Option.Option<ToolInput>
  readonly status: "running" | "completed" | "error"
  readonly summary: Option.Option<string>
  readonly output: Option.Option<string>
}

export type HeadlessToolRenderer = (toolCall: HeadlessToolCall) => Option.Option<string>

interface HeadlessToolRendererEntry {
  readonly toolNames: ReadonlyArray<string>
  readonly render: HeadlessToolRenderer
}

type HeadlessToolRendererRegistry = ReadonlyMap<string, HeadlessToolRenderer>

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

export const BashHeadlessToolRenderer: HeadlessToolRenderer = (toolCall) => {
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

const CellOperationReceipts = Schema.Array(
  Schema.Struct({
    tool: Schema.String,
    outcome: Schema.Literals(["succeeded", "failed", "incomplete"]),
    summary: Schema.String,
  }),
)
const decodeReceipts = Schema.decodeUnknownOption(CellOperationReceipts)

const receiptGlyph = (outcome: "succeeded" | "failed" | "incomplete") => {
  if (outcome === "succeeded") return "✓"
  if (outcome === "failed") return "✕"
  return "?"
}

export const CellHeadlessToolRenderer: HeadlessToolRenderer = (toolCall) => {
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
  const receipts = Option.getOrElse(decodeReceipts(parsed.value["operations"]), () => [])
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

const BUILTIN_HEADLESS_TOOL_RENDERERS: ReadonlyArray<HeadlessToolRendererEntry> = [
  { toolNames: ["bash"], render: BashHeadlessToolRenderer },
  { toolNames: ["cell"], render: CellHeadlessToolRenderer },
]

const resolveHeadlessToolRenderers = (
  entries: ReadonlyArray<HeadlessToolRendererEntry>,
): HeadlessToolRendererRegistry => {
  const renderers = new Map<string, HeadlessToolRenderer>()
  for (const entry of entries) {
    for (const toolName of entry.toolNames) {
      renderers.set(toolName.toLowerCase(), entry.render)
    }
  }
  return renderers
}

export const DEFAULT_HEADLESS_TOOL_RENDERERS = resolveHeadlessToolRenderers(
  BUILTIN_HEADLESS_TOOL_RENDERERS,
)

export const renderHeadlessToolCall = (
  toolCall: HeadlessToolCall,
  renderers: HeadlessToolRendererRegistry = DEFAULT_HEADLESS_TOOL_RENDERERS,
): string => {
  const renderer = Option.getOrElse(
    Option.fromNullishOr(renderers.get(toolCall.toolName.toLowerCase())),
    () => renderGeneric,
  )
  return renderer(toolCall).pipe(
    Option.orElse(() => renderGeneric(toolCall)),
    Option.getOrElse(() => `[tool: ${toolCall.toolName}]`),
  )
}

// ── headless run loop ───────────────────────────────────────────────────────

/**
 * The turn finished without the model ever answering. Distinct from a
 * connection fault: the run reached the server, spent its continuations and
 * came back empty. Failing here is what gives a scripted caller a non-zero
 * exit — a silent exit 0 with no output is indistinguishable from success.
 */
class HeadlessUnansweredError extends Schema.TaggedError<HeadlessUnansweredError>()(
  "@gent/tui/HeadlessUnansweredError",
  { message: Schema.String },
) {}

export const runHeadless = (
  client: GentNamespacedClient,
  sessionId: SessionId,
  branchId: BranchId,
  promptText: string,
  agentOverride?: AgentName,
  runSpec?: RunSpec,
  toolRenderers: HeadlessToolRendererRegistry = DEFAULT_HEADLESS_TOOL_RENDERERS,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio
      const writeStdout = (text: string) => Stream.make(text).pipe(Stream.run(stdio.stdout()))
      const writeStderr = (text: string) => Stream.make(text).pipe(Stream.run(stdio.stderr()))
      // Carries whether the turn actually answered, so the race below can fail
      // the run instead of exiting 0 on an empty transcript.
      const done = yield* Deferred.make<boolean>()
      const activeTools = new Map<string, HeadlessToolCall>()
      const renderTool = (toolCall: HeadlessToolCall, parentToolCallId?: string) => {
        const rendered = renderHeadlessToolCall(toolCall, toolRenderers)
        if (Predicate.isUndefined(parentToolCallId)) return writeStdout(`${rendered}\n`)
        // Cell-admitted calls stay visibly nested under their cell.
        const nested = rendered
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")
        return writeStdout(`${nested}\n`)
      }
      const streamFiber = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.tap((envelope) =>
          Effect.gen(function* () {
            const event = envelope.event
            switch (event._tag) {
              case "StreamChunk":
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
                if (Predicate.isUndefined(event.parentToolCallId)) yield* writeStdout("\n")
                yield* renderTool(toolCall, event.parentToolCallId)
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
                }
                activeTools.delete(String(event.toolCallId))
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
                }
                activeTools.delete(String(event.toolCallId))
                yield* renderTool(toolCall, event.parentToolCallId)
                break
              }
              case "StreamEnded":
                yield* writeStdout("\n")
                break
              case "ErrorOccurred":
                yield* writeStderr(`\nError: ${event.error}\n`)
                yield* Deferred.succeed(done, true)
                break
              case "TurnCompleted":
                yield* Deferred.succeed(done, event.unanswered !== true)
                break
              case "InteractionPresented":
                yield* writeStdout(`\n[interaction: auto-approving]\n`)
                yield* client.interaction
                  .respondInteraction({
                    requestId: event.requestId,
                    sessionId,
                    branchId,
                    approved: true,
                  })
                  .pipe(Effect.catchEager(() => Effect.void))
                break
              case "InteractionResolved":
                break
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      )

      const sendRequestId = yield* randomId
      yield* Effect.suspend(() =>
        client.message.send({
          sessionId,
          branchId,
          content: promptText,
          requestId: sendRequestId,
          agentOverride,
          runSpec,
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

      const answered = yield* Effect.raceFirst(
        Deferred.await(done),
        Fiber.await(streamFiber).pipe(
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
        ),
      )
      yield* Fiber.interrupt(streamFiber).pipe(Effect.asVoid)
      if (!answered) {
        yield* writeStderr("\nError: the turn ended without an answer.\n")
        return yield* new HeadlessUnansweredError({
          message: "turn completed without producing an answer",
        })
      }
    }),
  )
