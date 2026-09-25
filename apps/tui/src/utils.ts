import {
  Effect,
  FileSystem,
  Match,
  Option,
  Path,
  Predicate,
  Random,
  Schedule,
  Schema,
} from "effect"
import { type Context, useContext } from "solid-js"
import { textWidth } from "./text-width-adapter"
import {
  GentConnectionError,
  GentRpcError,
  lineCount,
  splitLines,
  type GentClientRpcError,
} from "@gent/core/protocol"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import type { ToolCall } from "./tool-renderers"

// ── solid context access ────────────────────────────────────────────────────

/** Read a required provider at the synchronous Solid runtime boundary. */
export function useRequiredContext<A>(context: Context<A>, message: string): NonNullable<A> {
  return Option.getOrElse(Option.fromNullishOr(useContext(context)), () =>
    Effect.runSync(Effect.die(new Error(message))),
  )
}

// ── random ids ──────────────────────────────────────────────────────────────

const bytes = Array.from({ length: 16 }, (_, index) => index)

export const randomId = Effect.forEach(bytes, () => Random.nextIntBetween(0, 255)).pipe(
  Effect.map((values) => {
    const hex = values.map((value, index) => {
      if (index === 6) return ((value & 0x0f) | 0x40).toString(16).padStart(2, "0")
      if (index === 8) return ((value & 0x3f) | 0x80).toString(16).padStart(2, "0")
      return value.toString(16).padStart(2, "0")
    })
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`
  }),
)

// ── text truncation ─────────────────────────────────────────────────────────

/**
 * The one column-budget truncation for the TUI.
 *
 * Every caller budgets terminal columns, not code units: a CJK name or an
 * emoji fits `.length` and still overflows the row. Graphemes are measured
 * with the terminal width adapter and the ellipsis is a single glyph, so the
 * result never exceeds `width` columns.
 */

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" })

const oneLine = (value: string): string => value.replace(/[\r\n\t]/g, " ")

/** Keep the head; end with `…` when the text does not fit `width` columns. */
export function truncate(value: string, width: number): string {
  if (width <= 0) return ""
  const line = oneLine(value)
  if (textWidth(line) <= width) return line
  let text = ""
  let columns = 0
  for (const { segment } of graphemes.segment(line)) {
    const size = textWidth(segment)
    if (columns + size > width - 1) break
    text += segment
    columns += size
  }
  return `${text}…`
}

/**
 * Exactly `width` display columns: cut with `truncate`, then padded with
 * spaces by display width. `String.padEnd` counts code units, so it over-pads
 * a wide (CJK) name and under-pads a joined emoji.
 */
export function fitWidth(value: string, width: number): string {
  const cut = truncate(value, width)
  return `${cut}${" ".repeat(Math.max(0, width - textWidth(cut)))}`
}

/** Keep the tail without splitting a displayed character: the end of a query stays visible. */
export function truncateStart(value: string, width: number): string {
  if (width <= 0) return ""
  const line = oneLine(value)
  if (textWidth(line) <= width) return line
  let text = ""
  let columns = 0
  for (const { segment } of Array.from(graphemes.segment(line)).reverse()) {
    const size = textWidth(segment)
    if (columns + size > width) break
    text = segment + text
    columns += size
  }
  return text
}

// ── tool output decoding ────────────────────────────────────────────────────

const decodeJsonObject = Schema.decodeUnknownOption(Schema.JsonObject)
const decodeString = Schema.decodeUnknownOption(Schema.String)
export type ToolInput = Parameters<typeof decodeJsonObject>[0]

/** Decode tool output JSON against an Effect Schema. */
export const decodeToolOutputOption = <T>(schema: Schema.Decoder<T, never>, input: ToolInput) =>
  Schema.decodeUnknownOption(Schema.fromJsonString(schema))(input)

/** Decode tool output JSON for framework adapters that use `undefined` for absence. */
export const decodeToolOutput = <T>(schema: Schema.Decoder<T, never>, input: ToolInput) =>
  Option.getOrUndefined(decodeToolOutputOption(schema, input))

interface BashOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  /**
   * `background`: it runs on past the call. `blocked`: a result an earlier
   * version stored for a command the user declined, which never ran. Neither
   * has a real exit code.
   */
  readonly status: Option.Option<"blocked" | "background">
}

const BashOutputSchema = Schema.Struct({
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  exitCode: Schema.Finite,
  status: Schema.optional(Schema.Literals(["blocked", "background"])),
})

/**
 * The one bash result decoder: a row's header, its count and its body read
 * it, and so does the headless printer.
 */
export function parseBashOutput(output: ToolInput): Option.Option<BashOutput> {
  return Option.map(decodeToolOutputOption(BashOutputSchema, output), (decoded) => ({
    stdout: decoded["stdout"] ?? "",
    stderr: decoded["stderr"] ?? "",
    exitCode: decoded["exitCode"],
    status: Option.fromUndefinedOr(decoded["status"]),
  }))
}

/** Extract a string property from an untrusted tool input. */
export const getString = (input: ToolInput, key: string, fallback = ""): string =>
  Option.getOrElse(
    decodeJsonObject(input).pipe(Option.flatMap((record) => decodeString(record[key]))),
    () => fallback,
  )

// ── duration formatting ─────────────────────────────────────────────────────

/**
 * - `compact`: whole seconds under a minute, then `2m 5s` (status lines, turn summaries).
 * - `padded`: whole seconds under a minute, then `2m05s` (fixed-width detail rows).
 * - `precise`: `12ms` under a second, tenths under a minute, then `2m 5s` (tool receipts).
 */
type DurationStyle = "compact" | "padded" | "precise"

const wholeSeconds = (ms: number): number => Math.floor(ms / 1000)

const compact = (ms: number): string => {
  const secs = wholeSeconds(ms)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

const padded = (ms: number): string => {
  const secs = wholeSeconds(ms)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`
}

const precise = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
}

export const formatDuration = (ms: number, style: DurationStyle): string =>
  Match.value(style).pipe(
    Match.when("compact", () => compact(ms)),
    Match.when("padded", () => padded(ms)),
    Match.when("precise", () => precise(ms)),
    Match.exhaustive,
  )

// ── error formatting ────────────────────────────────────────────────────────

export interface ClientError {
  readonly _tag: "ClientError"
  readonly message: string
}

export const ClientError = (message: string): ClientError => ({
  _tag: "ClientError",
  message,
})

/** What the TUI shows: a call's error, a connection setup failure, or its own. */
export type UiError = GentClientRpcError | GentConnectionError | ClientError

/**
 * The `RpcClientError` reasons that mean the bytes did not make the round
 * trip: a socket that failed or closed, an HTTP transport failure, a worker
 * that could not take or give the message. A protocol defect (a frame that
 * does not decode) and an HTTP status, decode or encode error are answers,
 * and another try gets the same one.
 */
const TRANSPORT_REASONS: ReadonlySet<string> = new Set([
  "SocketReadError",
  "SocketWriteError",
  "SocketOpenError",
  "SocketCloseError",
  "WorkerSendError",
  "WorkerReceiveError",
])

const isTransportReason = (reason: RpcClientError["reason"]): boolean => {
  if (reason._tag === "HttpError") return reason.kind === "TransportError"
  return TRANSPORT_REASONS.has(reason._tag)
}

/**
 * A failure of the connection, not an answer from the server: the request
 * may have landed and only its reply was lost.
 */
export const isConnectionLoss = (error: GentClientRpcError): boolean => {
  if (error._tag !== "RpcClientError") return false
  return isTransportReason(error.reason)
}

/**
 * The request id of a send whose reply was lost: the server may have run it,
 * so the same text sent again must reuse the id. None for an answered failure.
 */
export const lostRequest = (
  error: GentClientRpcError,
  requestId: string,
): Option.Option<string> => {
  if (isConnectionLoss(error)) return Option.some(requestId)
  return Option.none()
}

/**
 * How a send retries a lost connection: four more tries from 200 ms. Every
 * try carries the first request id, so a try that landed with a lost reply
 * does not run the message a second time. An answer from the server (a
 * refusal) is final at once.
 */
export const SEND_RETRY = {
  schedule: Schedule.exponential("200 millis"),
  times: 4,
  while: isConnectionLoss,
}

export const formatError = (error: UiError): string => {
  switch (error._tag) {
    case "ClientError":
      return error.message
    case "StorageError":
      return `Storage: ${error.message}`
    case "SessionRuntimeError":
      return `Runtime: ${error.message}`
    case "ProviderError":
      return `${error.model}: ${error.message}`
    case "EventStoreError":
      return `Events: ${error.message}`
    case "NotFoundError":
      return `Not found: ${error.message}`
    case "InvalidStateError":
      return `Invalid: ${error.message}`
    case "SessionDepthLimitError":
      return `Depth: ${error.message}`
    case "ProviderAuthError":
      return `Auth: ${error.message}`
    case "DriverError":
      return `Driver ${error.driver}: ${error.reason}`
    case "ExtensionProtocolError":
      return `Extension protocol: ${error.message}`
    case "RpcClientError":
      return `Connection: ${error.message}`
    case "@gent/core/GentConnectionError":
      return `Connection: ${error.message}`
    default:
      return "Unknown error"
  }
}

// eslint-disable-next-line effect/noUnknownParameters -- Connection failures cross framework boundaries; inspect only their message property.
const extractUnknownMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (Predicate.isString(error)) return error
  if (Predicate.isObject(error) && "message" in error) {
    if (Predicate.isString(error["message"])) return error["message"]
  }
  return String(error)
}

const isUiError = Schema.is(
  Schema.Union([
    GentRpcError,
    GentConnectionError,
    RpcClientError,
    Schema.TaggedStruct("ClientError", { message: Schema.String }),
  ]),
)

// eslint-disable-next-line effect/noUnknownParameters -- Validate transport and framework errors before applying domain error formatting.
export const formatConnectionIssue = (error: unknown): string => {
  let message: string
  if (isUiError(error)) message = formatError(error)
  else message = extractUnknownMessage(error)

  const normalized = message.toLowerCase()
  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket hang up") ||
    normalized.includes("connection reset") ||
    normalized.includes("fetch failed") ||
    normalized.includes("network")
  ) {
    return "connection lost; retrying"
  }

  return `connection issue: ${message}`
}

// ── tool formatting ─────────────────────────────────────────────────────────

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 999500) return `${Math.round(count / 1000)}k`
  return `${(count / 1000000).toFixed(1)}M`
}

export function formatUsageStats(
  usage: {
    input?: number
    output?: number
    cost?: number
    turns?: number
  },
  model?: string,
): string {
  const parts: string[] = []
  const turns = Option.fromNullishOr(usage.turns)
  if (Option.isSome(turns) && turns.value > 0) {
    let label = "turn"
    if (turns.value > 1) label = "turns"
    parts.push(`${turns.value} ${label}`)
  }
  const input = Option.fromNullishOr(usage.input)
  if (Option.isSome(input) && input.value > 0) parts.push(`↑${formatTokens(input.value)}`)
  const output = Option.fromNullishOr(usage.output)
  if (Option.isSome(output) && output.value > 0) parts.push(`↓${formatTokens(output.value)}`)
  const cost = Option.fromNullishOr(usage.cost)
  if (Option.isSome(cost) && cost.value > 0) parts.push(`$${cost.value.toFixed(4)}`)
  const modelName = Option.fromNullishOr(model)
  if (Option.isSome(modelName)) parts.push(modelName.value)
  return parts.join(" ")
}

export function shortenPath(p: string, home?: string): string {
  const homePath = Option.fromNullishOr(home)
  if (Option.isSome(homePath) && homePath.value.length > 0 && p.startsWith(homePath.value)) {
    return `~${p.slice(homePath.value.length)}`
  }
  return p
}

const decodeToolArgs = Schema.decodeUnknownOption(Schema.JsonObject)
const decodeNumber = Schema.decodeUnknownOption(Schema.Finite)

function getStringArg(args: Schema.JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    const value = decodeString(args[key])
    if (Option.isSome(value)) return value.value
  }
  return ""
}

function getNumberArg(args: Schema.JsonObject, key: string) {
  return decodeNumber(args[key])
}

const optionsHome = (options?: ToolArgSummaryOptions) =>
  Option.fromNullishOr(options).pipe(Option.flatMap((value) => Option.fromNullishOr(value.home)))

function getPathArg(args: Schema.JsonObject): string {
  return getStringArg(args, "file_path", "path")
}

interface ToolArgSummaryOptions {
  readonly home?: string
}

function summarizeRead(args: Schema.JsonObject, options?: ToolArgSummaryOptions): string {
  const rawPath = getPathArg(args)
  if (rawPath.length === 0) return ""

  let text = shortenPath(rawPath, Option.getOrUndefined(optionsHome(options)))
  const offset = getNumberArg(args, "offset")
  const limit = getNumberArg(args, "limit")
  if (Option.isNone(offset) && Option.isNone(limit)) return text

  const startLine = Option.getOrElse(offset, () => 1)
  let endLine = Option.none<number>()
  if (Option.isSome(limit)) endLine = Option.some(startLine + limit.value - 1)
  text += `:${startLine}`
  if (Option.isSome(endLine)) text += `-${endLine.value}`
  return text
}

function summarizeWrite(args: Schema.JsonObject, options?: ToolArgSummaryOptions): string {
  const rawPath = getPathArg(args)
  if (rawPath.length === 0) return ""

  const lines = lineCount(getStringArg(args, "content"))
  let text = shortenPath(rawPath, Option.getOrUndefined(optionsHome(options)))
  if (lines > 1) text += ` (${lines} lines)`
  return text
}

function summarizeGrep(args: Schema.JsonObject, options?: ToolArgSummaryOptions): string {
  const pattern = getStringArg(args, "pattern")
  if (pattern.length === 0) return ""
  const rawPath = getStringArg(args, "path") || "."
  return `/${pattern}/ in ${shortenPath(rawPath, Option.getOrUndefined(optionsHome(options)))}`
}

function summarizeDelegate(args: Schema.JsonObject): string {
  return truncate(getStringArg(args, "todo"), 40)
}

type ToolArgFormatter = (args: Schema.JsonObject, options?: ToolArgSummaryOptions) => string

const toolArgFormatters = {
  bash: (args) => {
    const command = getStringArg(args, "command", "cmd")
    if (command.length === 0) return ""
    return command.split("\n")[0] ?? command
  },
  cell: (args) => {
    const code = getStringArg(args, "code")
    return truncate(code.split("\n")[0] ?? "", 60)
  },
  read: summarizeRead,
  write: summarizeWrite,
  edit: (args, options) => {
    const rawPath = getPathArg(args)
    if (rawPath.length > 0) {
      return shortenPath(rawPath, Option.getOrUndefined(optionsHome(options)))
    }
    return ""
  },
  grep: summarizeGrep,
  "delegate.start": summarizeDelegate,
  read_session: (args) => truncate(getStringArg(args, "sessionId"), 50),
  handoff: (args) => truncate(getStringArg(args, "reason"), 50),
} satisfies Record<string, ToolArgFormatter>
const toolArgFormattersByName = new Map<string, ToolArgFormatter>(Object.entries(toolArgFormatters))

export function toolArgSummary(
  toolName: string,
  input: ToolInput,
  options?: ToolArgSummaryOptions,
): string {
  const args = decodeToolArgs(input)
  if (Option.isNone(args)) return ""
  const formatter = toolArgFormattersByName.get(toolName.toLowerCase())
  const selected = Option.fromNullishOr(formatter)
  if (Option.isNone(selected)) return ""
  return selected.value(args.value, options)
}

// ── generic tool formatting ─────────────────────────────────────────────────

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))
const decodeStringArray = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const encodePrettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json, { space: 2 }))

export const formatGenericToolInput = (input: ToolCall["input"]) =>
  Schema.decodeUnknownOption(Schema.Json)(input).pipe(
    Option.map(encodePrettyJson),
    Option.getOrElse(() => "(none)"),
  )

export const formatGenericToolDetail = (text: string) =>
  decodeJson(text).pipe(
    Option.map(encodePrettyJson),
    Option.getOrElse(() => text),
  )

function uniqueNonEmpty(parts: ReadonlyArray<Option.Option<string>>): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const part of parts) {
    if (Option.isNone(part)) continue
    const trimmed = part.value.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }

  return result
}

function extractPrimaryMessage(value: Schema.JsonObject) {
  const primary = decodeString(value["error"]).pipe(
    Option.orElse(() => decodeString(value["message"])),
    Option.orElse(() => decodeString(value["summary"])),
  )
  const secondary = decodeString(value["details"]).pipe(
    Option.orElse(() => decodeString(value["reason"])),
  )
  const issues = Option.getOrElse(decodeStringArray(value["errors"]), () => [])
  const parts = uniqueNonEmpty([primary, secondary, ...issues.map((issue) => Option.some(issue))])
  if (parts.length === 0) return Option.none<string>()
  return Option.some(parts.join("\n"))
}

export function formatGenericToolText(text: ToolCall["output"]) {
  const source = Option.fromNullishOr(text)
  if (Option.isNone(source)) return Option.getOrUndefined(source)

  const trimmed = source.value.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return source.value

  const parsed = decodeJson(source.value)
  if (Option.isNone(parsed)) return source.value

  const stringValue = decodeString(parsed.value)
  if (Option.isSome(stringValue)) return stringValue.value

  const record = decodeJsonObject(parsed.value)
  if (Option.isSome(record)) {
    const extracted = extractPrimaryMessage(record.value)
    if (Option.isSome(extracted)) return extracted.value
  }

  return encodePrettyJson(parsed.value)
}

// ── message list projections ────────────────────────────────────────────────

/**
 * Pure utility functions for message list rendering
 */

/**
 * Truncate path from start, keeping filename visible
 * e.g., "/Users/cvr/Developer/personal/gent/apps/tui/src/app.tsx" -> "…/tui/src/app.tsx"
 */
export function truncatePath(path: string, maxLen = 40): string {
  if (path.length <= maxLen) return path
  const parts = path.split("/")
  let result = parts[parts.length - 1] ?? ""
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + "/" + result
    if (next.length + 1 > maxLen) break
    result = next
  }
  return "…/" + result
}

/**
 * Format tool input for display in tool header.
 * Delegates to toolArgSummary for smart formatting, then applies
 * truncatePath for width safety on path-heavy tools. A grep with no
 * path searches `cwd`.
 */
export function formatToolInput(
  toolName: string,
  input: ToolInput,
  cwd = ".",
  home?: string,
): string {
  const name = toolName.toLowerCase()

  // grep: the cwd fallback happens before toolArgSummary
  if (name === "grep") {
    const pattern = getString(input, "pattern")
    if (pattern.length === 0) return ""
    const path = getString(input, "path")
    let searchPath = truncatePath(cwd, 30)
    if (path.length > 0) searchPath = truncatePath(path, 30)
    return `/${pattern}/ in ${searchPath}`
  }

  const summary = toolArgSummary(name, input, { home })
  if (summary.length === 0) return ""

  // Apply truncatePath for path-heavy tools
  if (name === "read" || name === "write" || name === "edit") {
    return truncatePath(summary)
  }

  return summary
}

// ── RLM activity summary ──
// The collapsed transcript group describes what the cell did, not that a tool ran.

type ActivityOutcome = "succeeded" | "failed" | "incomplete" | "running"

/**
 * The inner-call receipts a saved cell result carries under `operations`.
 * The one TUI reading of the shape the cell writes: every client draws them
 * where the branch has no events for the ops (a fork).
 */
export const CellOperationReceipts = Schema.Struct({
  operations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        tool: Schema.String,
        outcome: Schema.Literals(["succeeded", "failed", "incomplete"]),
        summary: Schema.String,
      }),
    ),
  ),
})

export interface ActivityOperation {
  readonly tool: string
  readonly outcome: ActivityOutcome
  /** Argument summary for live calls; empty for saved receipts. */
  readonly detail: string
}

export interface ActivityCall {
  readonly toolName: string
  readonly status: "running" | "completed" | "error"
  readonly operations: ReadonlyArray<ActivityOperation>
  /** The cell source; empty for other tools. */
  readonly code: string
  /** Wall time of the call once it has a terminal receipt. */
  readonly durationMs?: number
}

/** The group's wall time: the sum of its finished calls, absent until one has a duration. */
export const formatGroupDuration = (calls: ReadonlyArray<ActivityCall>): string => {
  const finished = calls.flatMap((call) => {
    if (Predicate.isUndefined(call.durationMs)) return []
    return [call.durationMs]
  })
  if (finished.length === 0) return ""
  return formatDuration(
    finished.reduce((total, ms) => total + ms, 0),
    "precise",
  )
}

// ── Cell intent ──
// A cell with no inner calls still did something; its source says what.

const CELL_VERB_PATTERNS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [
    /\btools((?:\.[A-Za-z_$][\w$]*|\[\s*["'`][^"'`]+["'`]\s*\])+)\s*\(/g,
    (m) => hostToolId(m[1] ?? ""),
  ],
  // `tools("read.then")(input)` calls by id; a bare `tools(id)` only reads the catalog.
  [/\btools\(\s*["'`]([^"'`]+)["'`]\s*\)\s*\(/g, (m) => m[1] ?? ""],
  [/Bun\.\$`([^`]*)`/g, (m) => `$ ${shellHead(m[1] ?? "")}`],
  [
    /Bun\.spawn\(\s*(?:\{\s*cmd:\s*)?\[\s*((?:["'`][^"'`]*["'`]\s*,?\s*)+)\]/g,
    (m) => `$ ${shellHead(argv(m[1] ?? ""))}`,
  ],
  [/Bun\.file\(\s*["'`]([^"'`]+)["'`]/g, (m) => `read ${m[1]}`],
  [/Bun\.write\(\s*["'`]([^"'`]+)["'`]/g, (m) => `write ${m[1]}`],
  [/new Bun\.Glob\(\s*["'`]([^"'`]+)["'`]/g, (m) => `glob ${m[1]}`],
  [/\bfetch\(\s*["'`]([^"'`]+)["'`]/g, (m) => `fetch ${urlHost(m[1] ?? "")}`],
]

/** `.delegate.start` and `["must-not-run"]` name the host tool ids `delegate.start` and `must-not-run`. */
const hostToolId = (path: string) => {
  const segments = Array.from(
    path.matchAll(/\.([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\]/g),
    (m) => m[1] ?? m[2] ?? "",
  )
  return segments.join(".")
}

const argv = (list: string) =>
  Array.from(list.matchAll(/["'`]([^"'`]*)["'`]/g), (m) => m[1] ?? "").join(" ")

const shellHead = (command: string) => {
  const first = command.split(/\n|\||&&|;/)[0] ?? ""
  return first.trim().split(/\s+/).slice(0, 3).join(" ")
}

const urlHost = (url: string) => URL.parse(url)?.host ?? url

/** Repeats next to each other fold into one label with a count. */
const collapseRepeats = (labels: ReadonlyArray<string>): string[] => {
  const out: string[] = []
  let previous = ""
  let repeats = 0
  const flush = () => {
    if (previous.length === 0) return
    if (repeats > 1) out.push(`${previous} ×${repeats}`)
    else out.push(previous)
  }
  for (const label of labels) {
    if (label === previous) {
      repeats += 1
      continue
    }
    flush()
    previous = label
    repeats = 1
  }
  flush()
  return out
}

/** The verbs a cell's source spells out, in source order: host tools, shell, files, globs, fetches. */
export function describeCellCode(code: string): ReadonlyArray<string> {
  const found: Array<{ readonly index: number; readonly label: string }> = []
  for (const [pattern, label] of CELL_VERB_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const text = label(match)
      if (text.trim().length > 0) found.push({ index: match.index, label: text })
    }
  }
  found.sort((left, right) => left.index - right.index)
  return collapseRepeats(found.map((entry) => entry.label))
}

/**
 * A session or branch id as rows show it: its last 8 characters. Both are
 * UUIDv7, whose head is its start time, so ids made in the same minute share
 * the head; the tail is random.
 */
export const shortId = (id: string): string => id.slice(-8)

/** The noun a count takes, without the count: `line` for one, `lines` otherwise. */
export const countNoun = (count: number, singular: string, pluralForm = `${singular}s`): string => {
  if (count === 1) return singular
  return pluralForm
}

/** A count and its noun: `1 line`, `3 lines`. */
export const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${countNoun(count, singular, pluralForm)}`

const isChildOperation = (operation: ActivityOperation) => operation.tool === "delegate.start"

/** Header for a group of calls. Cell-only turns count cells, ops, children, and failures. */
export function formatActivityHeader(calls: ReadonlyArray<ActivityCall>): string {
  if (calls.length === 0) return ""
  if (calls.some((call) => call.toolName !== "cell")) {
    const names = new Map<string, number>()
    for (const call of calls) names.set(call.toolName, (names.get(call.toolName) ?? 0) + 1)
    const counts = Array.from(names, ([name, count]) => `${count} ${name}`).join(" · ")
    return `${plural(calls.length, "tool call")} · ${counts}`
  }
  const operations = calls.flatMap((call) => call.operations)
  const children = operations.filter(isChildOperation).length
  // "N failed" counts ops whose exit or status failed. A cell that failed with
  // no failed op (a throw after its ops, or a restart) is its own failure,
  // worded apart; one that failed with a failed op is that op's failure.
  const isFailedOp = (operation: ActivityOperation) => operation.outcome === "failed"
  const failed = operations.filter(isFailedOp).length
  const failedCells = calls.filter(
    (call) => call.status === "error" && !call.operations.some(isFailedOp),
  ).length
  const parts = [plural(calls.length, "cell")]
  if (operations.length > 0) parts.push(plural(operations.length, "op"))
  else {
    const verbs = calls.flatMap((call) => describeCellCode(call.code)).slice(0, 4)
    if (verbs.length > 0) parts.push(verbs.join(" · "))
  }
  if (children > 0) parts.push(plural(children, "child", "children"))
  if (failed > 0) parts.push(`${failed} failed`)
  if (failedCells > 0) parts.push(`${plural(failedCells, "cell")} failed`)
  const duration = formatGroupDuration(calls)
  if (duration.length > 0) parts.push(duration)
  return parts.join(" · ")
}

/** The ops a cell ran, in order: each tool with its arguments, a failed one marked, repeats folded. */
export const formatOperationLabels = (operations: ReadonlyArray<ActivityOperation>): string =>
  collapseRepeats(
    operations.map((operation) => {
      let label = operation.tool
      if (operation.detail.length > 0) label = `${operation.tool} ${operation.detail}`
      if (operation.outcome === "failed") label = `✕ ${label}`
      return label
    }),
  ).join(" · ")

/** One-line label for a cell row: its error, else its operations, else its verbs, else its result, else its code. */
export function formatCellRowLabel(
  call: ActivityCall,
  fallback: { readonly code: string; readonly display: string; readonly error: string },
  maxLength = 72,
): string {
  if (call.status === "error" && fallback.error.length > 0) {
    return truncate(fallback.error.split("\n")[0] ?? "", maxLength)
  }
  if (call.operations.length > 0) return truncate(formatOperationLabels(call.operations), maxLength)
  const verbs = describeCellCode(fallback.code)
  if (verbs.length > 0) return truncate(verbs.join(" · "), maxLength)
  const display = fallback.display.split("\n").find((line) => line.trim().length > 0) ?? ""
  if (display.length > 0) return truncate(`→ ${display.trim()}`, maxLength)
  return truncate(fallback.code.split("\n")[0] ?? "", maxLength)
}

// ── Progressive disclosure ──
// Row labels stay the same at every level; levels only add output beneath them.

/**
 * Line counts for a row: cells show code in and display out, bash shows output
 * only; a zero count is left out. The unit keeps them apart from token counts.
 * The caller counts, so a cut output counts the whole output its body numbers.
 */
export function formatRowCounts(
  toolName: string,
  counts: { readonly inputLines: number; readonly outputLines: number },
): string {
  const out = { arrow: "↓", count: counts.outputLines }
  let all: ReadonlyArray<{ readonly arrow: string; readonly count: number }> = []
  if (toolName === "cell") all = [{ arrow: "↑", count: counts.inputLines }, out]
  if (toolName === "bash") all = [out]
  // A zero count says nothing: a cell with no output shows only its code.
  const shown = all.filter((entry) => entry.count > 0)
  if (shown.length === 0) return ""
  // One count of one line is one line; two counts are at least two lines.
  let noun = "lines"
  if (shown.length === 1 && shown[0]?.count === 1) noun = "line"
  return `${shown.map((entry) => `${entry.arrow} ${entry.count}`).join(" ")} ${noun}`
}

// ── Working icon ──
// One pulse for everything still running: transcript groups, agent rows.

const WORKING_ICON_FRAMES: ReadonlyArray<string> = ["◇", "◈", "◆", "◈"]

/** The frame for a spinner tick (60ms); the pulse turns every 250ms. */
export const workingIconFrame = (tick: number): string =>
  WORKING_ICON_FRAMES[Math.floor(tick / 4) % WORKING_ICON_FRAMES.length] ?? "◇"

/** Whole seconds under a minute, then minutes, hours, days: `45s`, `12m`, `3h`, `2d`. */
export const formatAge = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

interface OutputPreview {
  readonly lines: readonly string[]
  readonly hidden: number
}

/** The head of an output; the footer names the rest and the key that reveals it. */
export function previewOutput(text: string, maxLines = 20): OutputPreview {
  const trimmed = text.replace(/\s+$/, "")
  if (trimmed.length === 0) return { lines: [], hidden: 0 }
  const lines = trimmed.split("\n")
  return { lines: lines.slice(0, maxLines), hidden: Math.max(0, lines.length - maxLines) }
}

export const formatPreviewFooter = (hidden: number) => `… +${plural(hidden, "line")} (ctrl+o)`

// ── file reference expansion ────────────────────────────────────────────────

/**
 * File reference parsing, expansion, and display links.
 * Supports @path/to/file.ts#10-20 syntax, and `@"my notes.md"#10-20` for a
 * path with whitespace or `#`.
 */

interface FileRef {
  path: string
  startLine?: number
  endLine?: number
}

/** A reference and the span of text it was written as. */
interface FileRefMatch {
  readonly ref: FileRef
  readonly start: number
  readonly end: number
  /** Written without quotes: trailing punctuation may belong to the sentence. */
  readonly bare: boolean
}

/** `@"quoted path"` or `@bare/path`, then an optional `#start-end` range. */
const FILE_REF_PATTERN = /@(?:"([^"\n]+)"|([^\s#"]+))(?:#(\d+)(?:-(\d+))?)?/g

/** Whether `path` can be written as a reference at all: a quote cannot. */
export const isReferenceablePath = (path: string): boolean => !path.includes('"')

/**
 * How the composer writes a reference to `path`: bare when the pattern reads
 * it back whole, quoted when it holds whitespace or `#`.
 */
export const formatFileRef = (path: string): string => {
  if (/[\s#]/.test(path)) return `@"${path}"`
  return `@${path}`
}

export function isAbsPath(path: string): boolean {
  return path.startsWith("/")
}

export function fileUrl(path: string): string {
  return `file://${path}`
}

/**
 * The file references in `text`, with the span each was written at.
 * @example "@src/foo.ts" → { path: "src/foo.ts" }
 * @example "@src/foo.ts#10" → { path: "src/foo.ts", startLine: 10 }
 * @example "@src/foo.ts#10-20" → { path: "src/foo.ts", startLine: 10, endLine: 20 }
 */
const matchFileRefs = (text: string): FileRefMatch[] => {
  const refs: FileRefMatch[] = []
  const pattern = new RegExp(FILE_REF_PATTERN.source, "g")
  for (const match of text.matchAll(pattern)) {
    const quoted = Option.fromNullishOr(match[1])
    const path = Option.orElse(quoted, () => Option.fromNullishOr(match[2]))
    if (Option.isNone(path) || path.value.length === 0) continue

    const ref: FileRef = { path: path.value }
    const startLine = Option.fromNullishOr(match[3])
    if (Option.isSome(startLine)) {
      ref.startLine = parseInt(startLine.value, 10)
      const endLine = Option.fromNullishOr(match[4])
      if (Option.isSome(endLine)) {
        ref.endLine = parseInt(endLine.value, 10)
      }
    }
    refs.push({
      ref,
      start: match.index,
      end: match.index + match[0].length,
      bare: Option.isNone(quoted),
    })
  }

  return refs
}

/**
 * The most text a composer insert puts inline: `!cmd` output and an `@file`
 * both stop at this many lines or characters, whichever comes first.
 */
export const INLINE_MAX_LINES = 2000
export const INLINE_MAX_BYTES = 50 * 1024

/** ripgrep's rule, as grep keeps it: a NUL byte in the first 8 KB marks a file binary. */
const BINARY_PROBE_BYTES = 8192

/**
 * Read file content, optionally extracting line range. A binary file is not
 * read into the prompt (`None`), and text past the inline cap is cut at a
 * line with a note that names what was left out.
 */
const readFileContent = (
  absolutePath: string,
  label: string,
  startLine: Option.Option<number>,
  endLine: Option.Option<number>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bytes = yield* fs.readFile(absolutePath)
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return Option.none<string>()
    const text = new TextDecoder().decode(bytes)
    // The core line rule: a final newline ends the last line and starts none.
    let lines = splitLines(text)
    let whole = text

    if (Option.isSome(startLine)) {
      const start = Math.max(0, startLine.value - 1) // Convert 1-indexed to 0-indexed
      let end = start + 1
      if (Option.isSome(endLine)) end = Math.min(lines.length, endLine.value)
      lines = lines.slice(start, end)
      whole = lines.join("\n")
    }

    const encoder = new TextEncoder()
    const kept: Array<string> = []
    let size = 0
    for (const line of lines) {
      const lineBytes = encoder.encode(line).length
      if (kept.length >= INLINE_MAX_LINES || size + lineBytes > INLINE_MAX_BYTES) break
      kept.push(line)
      size += lineBytes + 1
    }
    if (kept.length === lines.length) return Option.some(whole)
    return Option.some(
      `${kept.join("\n")}\n[${label} cut at ${kept.length} lines of ${lines.length}; read the rest with the read tool]`,
    )
  })

const expandSingleRef = (ref: FileRef, cwd: string) => {
  const startLine = Option.fromNullishOr(ref.startLine)
  const endLine = Option.fromNullishOr(ref.endLine)

  return Effect.gen(function* () {
    const path = yield* Path.Path
    const absolutePath = path.resolve(cwd, ref.path)
    const relativePathValue = path.relative(cwd, absolutePath)
    const content = yield* readFileContent(absolutePath, relativePathValue, startLine, endLine)
    if (Option.isNone(content)) return Option.none<string>()

    // Build range label
    let rangeLabel = relativePathValue
    if (Option.isSome(startLine)) {
      rangeLabel += `:${startLine.value}`
      if (Option.isSome(endLine)) {
        rangeLabel += `-${endLine.value}`
      }
    }

    // Build code block
    return Option.some(`\`\`\`${rangeLabel}\n${content.value}\n\`\`\``)
  }).pipe(Effect.catchEager(() => Effect.succeedNone))
}

/** Punctuation a sentence puts after a reference: `see @a.ts, then (@b.ts).` */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}']+$/

/**
 * A bare reference as written, else, when that path does not expand, the
 * path without its trailing punctuation. The block names how much of the
 * written reference it replaces, so the punctuation stays in the text.
 */
const expandMatch = (match: FileRefMatch, cwd: string) =>
  Effect.gen(function* () {
    const whole = yield* expandSingleRef(match.ref, cwd)
    if (Option.isSome(whole)) return Option.some({ block: whole.value, end: match.end })
    const hasRange = Predicate.isNotUndefined(match.ref.startLine)
    const trailing = Option.fromNullishOr(TRAILING_PUNCTUATION.exec(match.ref.path))
    if (!match.bare || hasRange || Option.isNone(trailing)) return Option.none()
    const punctuation = trailing.value[0]
    const trimmed = match.ref.path.slice(0, match.ref.path.length - punctuation.length)
    if (trimmed.length === 0) return Option.none()
    const block = yield* expandSingleRef({ path: trimmed }, cwd)
    return Option.map(block, (value) => ({ block: value, end: match.end - punctuation.length }))
  })

/**
 * Expand file references in text by reading file contents.
 * Each code block is spliced in at the span its reference was written at, so
 * the file text is never read as a replacement pattern (`$&`, `$$`) and a
 * reference inside an earlier file's text is never expanded.
 * @example "@src/foo.ts#10-20" → "```src/foo.ts:10-20\n<content>\n```"
 */
export const expandFileRefs = (text: string, cwd: string) => {
  const matches = matchFileRefs(text)
  if (matches.length === 0) return Effect.succeed(text)

  return Effect.gen(function* () {
    const expanded = yield* Effect.forEach(
      matches,
      (match) => Effect.map(expandMatch(match, cwd), (expansion) => ({ match, expansion })),
      { concurrency: 16 },
    )

    let result = ""
    let cursor = 0
    for (const { match, expansion } of expanded) {
      if (Option.isNone(expansion)) continue
      result += text.slice(cursor, match.start) + expansion.value.block
      cursor = expansion.value.end
    }
    return result + text.slice(cursor)
  })
}
