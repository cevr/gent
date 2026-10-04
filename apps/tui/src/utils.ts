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
import { pathToFileURL } from "node:url"
import { type Context, useContext } from "solid-js"
import { textWidth } from "./bun-adapter"
import {
  GentConnectionError,
  GentRpcError,
  lineCount,
  type Session,
  splitLines,
  type GentClientRpcError,
} from "@gent/core/protocol"
import { RpcClientError } from "effect/rpc/RpcClientError"
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
      // oxlint-disable-next-line gent/no-code-unit-padding -- Random.nextIntBetween supplies a numeric byte; hexadecimal digits and zero padding are ASCII
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
 * The text less its last character as the reader sees it: one grapheme, so a
 * backspace takes a toned emoji, a flag or a ZWJ family whole.
 */
export function dropLastGrapheme(value: string): string {
  let last = 0
  for (const { index } of graphemes.segment(value)) last = index
  return value.slice(0, last)
}

/** The text less its first character as the reader sees it: one grapheme. */
export function dropFirstGrapheme(value: string): string {
  for (const { segment } of graphemes.segment(value)) return value.slice(segment.length)
  return value
}

/**
 * The first grapheme boundary of `value` at or after `index`. An edit can
 * join its neighbours into one character (a ZWJ between two emoji, two
 * regional indicators that meet), so an index that was a boundary before the
 * edit can fall inside a character after it.
 */
export function graphemeBoundaryFrom(value: string, index: number): number {
  for (const { index: start, segment } of graphemes.segment(value)) {
    const end = start + segment.length
    if (index <= start) return start
    if (index < end) return end
  }
  return value.length
}

/** How many characters the reader sees: graphemes, not code units. */
export const graphemeCount = (value: string): number => Array.from(graphemes.segment(value)).length

/** The first `count` graphemes, ending in `…` when the text has more. */
export function headGraphemes(value: string, count: number): string {
  let kept = 0
  for (const { index } of graphemes.segment(value)) {
    if (kept === count) return `${value.slice(0, index)}…`
    kept += 1
  }
  return value
}

/**
 * At least `width` display columns: padded with spaces by display width, never
 * cut. `String.padEnd` counts code units, so it over-pads a wide (CJK) name
 * and under-pads a joined emoji.
 */
export const padWidth = (value: string, width: number): string =>
  `${value}${" ".repeat(Math.max(0, width - textWidth(value)))}`

/** Exactly `width` display columns: cut with `truncate`, then padded with `padWidth`. */
export function fitWidth(value: string, width: number): string {
  return padWidth(truncate(value, width), width)
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

// ── sessions ────────────────────────────────────────────────────────────────

/**
 * A session the reader can return to. A delegate or `/btw` child has a
 * parent and its own thread: it is the agent's work, not a conversation the
 * reader left. A handoff has a parent but joins its thread, so it is one.
 */
export const isConversation = (
  session: Pick<Session, "id" | "parentSessionId" | "threadId">,
): boolean => Predicate.isUndefined(session.parentSessionId) || session.threadId !== session.id

/** The writer of one read's reply. */
export interface ReplyWriter {
  /** The read is the newest one, and the view still shows the key it was taken under. */
  readonly live: () => boolean
  /** Apply `apply` while the read is `live`; otherwise drop it. */
  readonly write: (apply: () => void) => void
}

/**
 * The one writer path for replies to the reads a view starts. `take` starts a
 * read and captures the view's key (a session identity); its writer applies
 * the reply only while that read is the newest and the view still shows that
 * key. A reply for a session the view left, or for a read a newer one
 * replaced, changes nothing. `newest` is the newest read's writer, for a
 * reply that belongs to it without starting another.
 */
export const repliesInView = <K>(
  key: () => K,
  same: (left: K, right: K) => boolean = (left, right) => left === right,
) => {
  let newest = 0
  const writer = (read: number, captured: K): ReplyWriter => {
    const live = () => read === newest && same(key(), captured)
    return {
      live,
      write: (apply) => {
        if (live()) apply()
      },
    }
  }
  return {
    take: (): ReplyWriter => writer(++newest, key()),
    newest: (): ReplyWriter => writer(newest, key()),
  }
}

// ── size formatting ─────────────────────────────────────────────────────────

/** `512 B`, `7.2 KB`, `1.5 MB`: the doctor's database size and a write's receipt. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── duration formatting ─────────────────────────────────────────────────────

/**
 * - `compact`: whole seconds under a minute, then `2m 5s`, then `1h 2m`
 *   (status lines, turn summaries, the agents pane and the wake tray).
 * - `padded`: whole seconds under a minute, then `2m05s`, then `1h02m` (fixed-width detail rows).
 * - `precise`: `12ms` under a second, tenths under a minute, then as `compact` of the
 *   rounded seconds (tool receipts).
 */
type DurationStyle = "compact" | "padded" | "precise"

const wholeSeconds = (ms: number): number => Math.floor(ms / 1000)

/** From one hour the seconds drop and the minutes follow the hours. */
const hours = (secs: number, separator: string, pad: number): string =>
  `${Math.floor(secs / 3600)}h${separator}${String(Math.floor((secs % 3600) / 60)).padStart(pad, "0")}m`

const compact = (ms: number): string => {
  const secs = wholeSeconds(ms)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return hours(secs, " ", 1)
}

const padded = (ms: number): string => {
  const secs = wholeSeconds(ms)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`
  return hours(secs, "", 2)
}

/** Rounds first, then picks the unit, so a value never reads `1000ms` or `1m 60s`. */
const precise = (ms: number): string => {
  const millis = Math.round(ms)
  if (millis < 1000) return `${millis}ms`
  const tenths = Math.round(ms / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`
  return compact(Math.round(ms / 1000) * 1000)
}

export const formatDuration = (ms: number, style: DurationStyle): string =>
  Match.value(style).pipe(
    Match.when("compact", () => compact(ms)),
    Match.when("padded", () => padded(ms)),
    Match.when("precise", () => precise(ms)),
    Match.exhaustive,
  )

// ── error formatting ────────────────────────────────────────────────────────

/** What the TUI shows: a call's error or a connection setup failure. */
export type UiError = GentClientRpcError | GentConnectionError

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
    case "ConfigLoadError":
    case "ConfigWriteError":
      return `Config ${error.path}: ${error.message}`
    case "InteractionDecisionConflictError":
    case "InteractionRequestMismatchError":
      return `Interaction: ${error.message}`
    case "WorkspaceHeaderError":
      return `Workspace: ${error.message}`
  }
}

// eslint-disable-next-line effect/noUnknownParameters -- Connection and auth failures cross framework boundaries; inspect only their message property.
export const extractUnknownMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (Predicate.isString(error)) return error
  if (Predicate.isObject(error) && "message" in error) {
    if (Predicate.isString(error["message"])) return error["message"]
  }
  return String(error)
}

const isUiError = Schema.is(Schema.Union([GentRpcError, GentConnectionError, RpcClientError]))

// eslint-disable-next-line effect/noUnknownParameters -- Validate transport and framework errors before applying domain error formatting.
export const formatConnectionIssue = (error: unknown): string => {
  if (!isUiError(error)) return `connection issue: ${extractUnknownMessage(error)}`
  // The transport's reason tells a lost connection from an answer.
  if (error._tag !== "@gent/core/GentConnectionError") {
    if (isConnectionLoss(error)) return "connection lost; retrying"
  }
  return `connection issue: ${formatError(error)}`
}

// ── tool formatting ─────────────────────────────────────────────────────────

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 999500) return `${Math.round(count / 1000)}k`
  return `${(count / 1000000).toFixed(1)}M`
}

/**
 * The one spelling of a dollar cost: cents at a cent or more, a tenth of a
 * cent below it, so a cheap turn never reads as free.
 */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.001) return "<$0.001"
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
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
  if (Option.isSome(cost) && cost.value > 0) parts.push(formatCost(cost.value))
  const modelName = Option.fromNullishOr(model)
  if (Option.isSome(modelName)) parts.push(modelName.value)
  return parts.join(" ")
}

/** Where a session runs: tool paths read from here. */
export interface PathPlace {
  readonly cwd: string
  readonly home: string
}

const isUnder = (p: string, root: string) =>
  root.length > 1 && (p === root || p.startsWith(`${root}/`))

/**
 * The one spelling of a tool path: relative to the cwd when under it,
 * else `~`-abbreviated when under home, else as given. A cwd of `/` holds
 * every absolute path; a home of `/` abbreviates nothing.
 */
export function displayPath(p: string, place: PathPlace): string {
  if (p === place.cwd) return "."
  if (place.cwd === "/" && p.startsWith("/")) return p.slice(1)
  if (isUnder(p, place.cwd)) return p.slice(place.cwd.length + 1)
  if (isUnder(p, place.home)) return `~${p.slice(place.home.length)}`
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

function summarizeRead(args: Schema.JsonObject, place: PathPlace): string {
  const rawPath = getStringArg(args, "path")
  if (rawPath.length === 0) return ""

  let text = displayPath(rawPath, place)
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

function summarizeWrite(args: Schema.JsonObject, place: PathPlace): string {
  const rawPath = getStringArg(args, "path")
  if (rawPath.length === 0) return ""

  const lines = lineCount(getStringArg(args, "content"))
  let text = displayPath(rawPath, place)
  if (lines > 1) text += ` (${lines} lines)`
  return text
}

function summarizeGrep(args: Schema.JsonObject, place: PathPlace): string {
  const pattern = getStringArg(args, "pattern")
  if (pattern.length === 0) return ""
  const rawPath = getStringArg(args, "path") || "."
  return `/${pattern}/ in ${displayPath(rawPath, place)}`
}

const decodeAskedQuestions = Schema.decodeUnknownOption(Schema.Array(Schema.JsonObject))

/** A background question: `<header> · <question> · assuming <assume>`, and how many more the call asked. */
function summarizeAskAsync(args: Schema.JsonObject): string {
  const questions = Option.getOrElse(decodeAskedQuestions(args["questions"]), () => [])
  return Option.match(Option.fromUndefinedOr(questions[0]), {
    onNone: () => "",
    onSome: (first) => {
      const parts = [
        getStringArg(first, "header"),
        getStringArg(first, "question"),
        `assuming ${getStringArg(first, "assume")}`,
      ].filter((part) => part.length > 0)
      const more = questions.length - 1
      if (more > 0) parts.push(`+${more} more`)
      return parts.join(" · ")
    },
  })
}

function summarizeDelegate(args: Schema.JsonObject): string {
  return truncate(getStringArg(args, "todo"), 40)
}

type ToolArgFormatter = (args: Schema.JsonObject, place: PathPlace) => string

const toolArgFormatters = {
  bash: (args) => {
    const command = getStringArg(args, "command")
    if (command.length === 0) return ""
    return command.split("\n")[0] ?? command
  },
  cell: (args) => {
    const code = getStringArg(args, "code")
    return truncate(code.split("\n")[0] ?? "", 60)
  },
  read: summarizeRead,
  write: summarizeWrite,
  edit: (args, place) => {
    const rawPath = getStringArg(args, "path")
    if (rawPath.length > 0) {
      return displayPath(rawPath, place)
    }
    return ""
  },
  grep: summarizeGrep,
  "delegate.start": summarizeDelegate,
  ask_user_async: summarizeAskAsync,
  read_session: (args) => truncate(getStringArg(args, "sessionId"), 50),
  handoff: (args) => truncate(getStringArg(args, "reason"), 50),
} satisfies Record<string, ToolArgFormatter>
const toolArgFormattersByName = new Map<string, ToolArgFormatter>(Object.entries(toolArgFormatters))

/** A tool with no formatter shows the first of these arguments it has. */
const LEADING_ARG_KEYS = [
  "path",
  "url",
  "command",
  "pattern",
  "query",
  "goal",
  "description",
  "task",
  "todo",
  "agent",
]

const leadingArg = (args: Schema.JsonObject, place: PathPlace): string => {
  for (const key of LEADING_ARG_KEYS) {
    const value = getStringArg(args, key)
    if (value.length === 0) continue
    const line = value.split("\n")[0] ?? ""
    if (key === "path") return displayPath(line, place)
    return line
  }
  return ""
}

/**
 * The one label of a call's arguments: the tool's own formatter, else its
 * leading argument. Paths read from `place`: the cwd and home they are shown against.
 */
export function toolArgSummary(toolName: string, input: ToolInput, place: PathPlace): string {
  const args = decodeToolArgs(input)
  if (Option.isNone(args)) return ""
  const formatter = toolArgFormattersByName.get(toolName.toLowerCase())
  return Option.match(Option.fromNullishOr(formatter), {
    onNone: () => leadingArg(args.value, place),
    onSome: (selected) => selected(args.value, place),
  })
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
 * Truncate path from start, keeping filename visible. `maxLen` counts
 * terminal columns: a wide (CJK) name takes two a character.
 * e.g., "/Users/cvr/Developer/personal/gent/apps/tui/src/app.tsx" -> "…/tui/src/app.tsx"
 */
export function truncatePath(path: string, maxLen = 40): string {
  if (textWidth(path) <= maxLen) return path
  const parts = path.split("/")
  let result = parts[parts.length - 1] ?? ""
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + "/" + result
    if (textWidth(next) + 1 > maxLen) break
    result = next
  }
  return "…/" + result
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

/** The lines an edit adds and removes. */
interface DiffCount {
  readonly added: number
  readonly removed: number
}

export interface ActivityOperation {
  readonly tool: string
  readonly outcome: ActivityOutcome
  /** Argument summary for live calls; empty for saved receipts. */
  readonly detail: string
  /** The lines an edit op changed, read from its input. */
  readonly diff?: DiffCount
}

export interface ActivityCall {
  readonly toolName: string
  readonly status: "running" | "completed" | "error"
  /**
   * The tools the call ran: a cell's ops, or the call itself for any other
   * tool. Empty for a cell with no ops, which counts as one tool.
   */
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

// ── Tool group header and rows ──
// A group reads in tool words, not in the cell mechanism: what was read,
// searched, edited and run. The cell count is detail the full level shows.

/** A call's status as the outcome of the one tool it stands for. */
export const callOutcome = (status: ActivityCall["status"]): ActivityOutcome => {
  if (status === "running") return "running"
  if (status === "error") return "failed"
  return "succeeded"
}

const isFailedOp = (operation: ActivityOperation) => operation.outcome === "failed"

/**
 * One line of a group: a tool the run called, or a cell's own failure. A
 * cell's own failure is no tool, so the header leaves it out of the tool
 * count and counts it among the failures.
 */
interface ActivityEntry {
  readonly operation: ActivityOperation
  readonly tool: boolean
}

/**
 * What a call with no ops did: its source's verbs, else its first line. A
 * failed call's reason is its frame's, which every level draws.
 */
const opLessDetail = (call: ActivityCall): string => {
  const verbs = describeCellCode(call.code).join(" · ")
  if (verbs.length > 0) return verbs
  return truncate(call.code.split("\n")[0] ?? "", 60)
}

/**
 * The tools of a group in call order. A cell with no ops is one tool that
 * names its source's verbs. A cell that failed with no failed op (a throw
 * after its ops, or a restart) adds its own failure after its ops; one that
 * failed with a failed op is that op's failure.
 */
const activityEntries = (calls: ReadonlyArray<ActivityCall>): ReadonlyArray<ActivityEntry> =>
  calls.flatMap((call): ReadonlyArray<ActivityEntry> => {
    if (call.operations.length === 0) {
      const operation = {
        tool: call.toolName,
        outcome: callOutcome(call.status),
        detail: opLessDetail(call),
      }
      return [{ operation, tool: true }]
    }
    const entries = call.operations.map((operation) => ({ operation, tool: true }))
    if (call.status !== "error" || call.operations.some(isFailedOp)) return entries
    const failure: ActivityOperation = { tool: call.toolName, outcome: "failed", detail: "" }
    return [...entries, { operation: failure, tool: false }]
  })

/** The header word of each tool kind; a tool not named here counts under its own id. */
const TOOL_KINDS: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["read", ["read", "read"]],
  ["read_session", ["read", "read"]],
  ["grep", ["search", "search"]],
  ["glob", ["search", "search"]],
  ["websearch", ["search", "search"]],
  ["edit", ["edit", "edit"]],
  ["write", ["edit", "edit"]],
  ["bash", ["command", "commands"]],
  ["delegate.start", ["child", "children"]],
  ["ask_user_async", ["question", "questions"]],
])

/**
 * Header for a group of calls: `7 tools · 4 read · 2 edit · 1 command ·
 * 1 failed · 4.2s`. Kinds go largest first, ties in the order they ran. A
 * cell with no ops names its source's verbs in place of a kind. Where the
 * header is wider than `width` columns, kinds drop from the right first: the
 * tool count, the failures and the time stay.
 */
export function formatActivityHeader(
  calls: ReadonlyArray<ActivityCall>,
  width = Number.POSITIVE_INFINITY,
): string {
  if (calls.length === 0) return ""
  const entries = activityEntries(calls)
  const tools = entries.filter((entry) => entry.tool)
  const kinds = new Map<
    string,
    { readonly count: number; readonly words: readonly [string, string] }
  >()
  for (const { operation } of tools) {
    if (operation.tool === "cell") continue
    const words = TOOL_KINDS.get(operation.tool) ?? [operation.tool, operation.tool]
    const count = (kinds.get(words[0])?.count ?? 0) + 1
    kinds.set(words[0], { count, words })
  }
  const verbs = calls
    .filter((call) => call.operations.length === 0 && call.toolName === "cell")
    .flatMap((call) => describeCellCode(call.code))
  const counted = Array.from(kinds.values())
    .toSorted((left, right) => right.count - left.count)
    .map(({ count, words }) => `${count} ${countNoun(count, words[0], words[1])}`)
  const optional = [...counted, ...verbs.slice(0, 4)]
  const failed = entries.filter((entry) => isFailedOp(entry.operation)).length
  const tail: string[] = []
  if (failed > 0) tail.push(`${failed} failed`)
  const duration = formatGroupDuration(calls)
  if (duration.length > 0) tail.push(duration)
  const head = plural(tools.length, "tool")
  const join = (parts: ReadonlyArray<string>) => [head, ...parts, ...tail].join(" · ")
  let kept = optional.length
  while (kept > 0 && textWidth(join(optional.slice(0, kept))) > width) kept -= 1
  return join(optional.slice(0, kept))
}

/** Past and running tense of each tool's verb; a tool not named here shows its id. */
const TOOL_VERBS: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["read", ["Read", "Reading"]],
  ["read_session", ["Read", "Reading"]],
  ["grep", ["Searched", "Searching"]],
  ["glob", ["Searched", "Searching"]],
  ["websearch", ["Searched", "Searching"]],
  ["webfetch", ["Fetched", "Fetching"]],
  ["edit", ["Edited", "Editing"]],
  ["write", ["Wrote", "Writing"]],
  ["bash", ["Ran", "Running"]],
  ["delegate.start", ["Started", "Starting"]],
  ["ask_user", ["Asked", "Asking"]],
  ["ask_user_async", ["Asked", "Asking"]],
])

/** One row of a group at the preview level: a run of ops of one tool and one outcome. */
interface ActivityRow {
  readonly tool: string
  readonly outcome: ActivityOutcome
  readonly subjects: ReadonlyArray<string>
  /** The summed lines the row's edits changed; none for a row with no edit. */
  readonly diff: Option.Option<DiffCount>
}

const addDiff = (
  total: Option.Option<DiffCount>,
  next: Option.Option<DiffCount>,
): Option.Option<DiffCount> =>
  Option.match(next, {
    onNone: () => total,
    onSome: (count) =>
      Option.some(
        Option.match(total, {
          onNone: () => count,
          onSome: (sum) => ({
            added: sum.added + count.added,
            removed: sum.removed + count.removed,
          }),
        }),
      ),
  })

/**
 * The rows of a group, one per run of ops: consecutive ops of one tool and
 * one outcome fold into one row, so a cell that reads 3 files draws one
 * `Read` row. A running op keeps its own row, last.
 */
export const activityRows = (calls: ReadonlyArray<ActivityCall>): ReadonlyArray<ActivityRow> => {
  const rows: ActivityRow[] = []
  for (const { operation } of activityEntries(calls)) {
    const subjects = Option.toArray(
      Option.liftPredicate(operation.detail, (detail) => detail.length > 0),
    )
    const diff = Option.fromUndefinedOr(operation.diff)
    const previous = Option.filter(
      Option.fromUndefinedOr(rows.at(-1)),
      (row) =>
        row.tool === operation.tool &&
        row.outcome === operation.outcome &&
        operation.outcome !== "running",
    )
    if (Option.isSome(previous)) {
      const row = previous.value
      rows[rows.length - 1] = {
        ...row,
        subjects: [...row.subjects, ...subjects],
        diff: addDiff(row.diff, diff),
      }
    } else {
      rows.push({ tool: operation.tool, outcome: operation.outcome, subjects, diff })
    }
  }
  return rows
}

/** A row as text, in parts: the diff counts draw in their own colours between head and tail. */
interface ActivityRowText {
  readonly head: string
  readonly diff: Option.Option<DiffCount>
  readonly tail: string
}

/**
 * A row in past-tense words, fitted to `width` columns: `Read a.ts, b.ts +1`,
 * `Edited x.ts +12 / -3`, `Ran bun test · failed`, `Running bun test`. The
 * subjects that fit the width show, then `+N` counts the rest.
 */
export function formatActivityRow(
  row: ActivityRow,
  width = Number.POSITIVE_INFINITY,
): ActivityRowText {
  const tense = TOOL_VERBS.get(row.tool) ?? [row.tool, row.tool]
  let verb = tense[0]
  if (row.outcome === "running") verb = tense[1]
  let tail = ""
  if (row.outcome === "failed") tail = " · failed"
  if (row.outcome === "incomplete") tail = " · incomplete"
  const diffWidth = Option.match(row.diff, {
    onNone: () => 0,
    onSome: (diff) => textWidth(formatDiffCount(diff)) + 1,
  })
  const room = width - textWidth(verb) - 1 - diffWidth - textWidth(tail)
  const subjects = row.subjects
  const listed = (kept: number) => {
    const text = subjects.slice(0, kept).join(", ")
    if (kept < subjects.length) return `${text} +${subjects.length - kept}`
    return text
  }
  let kept = subjects.length
  while (kept > 1 && textWidth(listed(kept)) > room) kept -= 1
  if (subjects.length === 0) return { head: verb, diff: row.diff, tail }
  return { head: `${verb} ${listed(kept)}`, diff: row.diff, tail }
}

/** `+12 / -3` */
const formatDiffCount = (diff: DiffCount): string => `+${diff.added} / -${diff.removed}`

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

/**
 * The `file://` link a tool row gives an absolute path. A terminal opens it
 * as a URL, so the path is percent-encoded as `pathToFileURL` encodes it: a
 * space, `#` or `%` stays part of the name. A relative path has no link.
 */
export const fileHref = (path: string): Option.Option<string> =>
  Option.some(path).pipe(
    Option.filter((p) => p.startsWith("/")),
    Option.map((p) => pathToFileURL(p).href),
  )

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
const INLINE_MAX_LINES = 2000
const INLINE_MAX_BYTES = 50 * 1024

/**
 * The head of `lines` that fits the inline cap: whole lines, at most
 * INLINE_MAX_LINES of them and INLINE_MAX_BYTES of UTF-8 with their breaks.
 */
export const inlineHead = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const encoder = new TextEncoder()
  const kept: Array<string> = []
  let size = 0
  for (const line of lines) {
    const lineBytes = encoder.encode(line).length
    if (kept.length >= INLINE_MAX_LINES || size + lineBytes > INLINE_MAX_BYTES) break
    kept.push(line)
    size += lineBytes + 1
  }
  return kept
}

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
      // A range that starts past the end, or ends before it starts, names no
      // line: it stays a reference.
      if (start >= lines.length) return Option.none<string>()
      let end = start + 1
      if (Option.isSome(endLine)) end = Math.min(lines.length, endLine.value)
      if (end <= start) return Option.none<string>()
      lines = lines.slice(start, end)
      whole = lines.join("\n")
    }

    const kept = inlineHead(lines)
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
