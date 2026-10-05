import {
  DateTime,
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

/** A clock field (0 to 59, a month, a day) as two digits. */
const twoDigits = (n: number) => `${Math.floor(n / 10)}${n % 10}`

/**
 * The wall-clock time `at` in `zone`: "17:05" on the day of `now`, else
 * "2026-10-05 09:30". A clock time stays true on a row that does not redraw,
 * where a countdown goes stale.
 */
export const formatClock = (at: number, now: number, zone: DateTime.TimeZone): string => {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone: zone }))
  const today = DateTime.toParts(DateTime.makeZonedUnsafe(now, { timeZone: zone }))
  const time = `${twoDigits(parts.hour)}:${twoDigits(parts.minute)}`
  if (parts.year === today.year && parts.month === today.month && parts.day === today.day) {
    return time
  }
  return `${parts.year}-${twoDigits(parts.month)}-${twoDigits(parts.day)} ${time}`
}

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

/** The word an error's message reads after: `Storage: disk full`. */
const ERROR_PREFIX: Readonly<
  Record<
    Exclude<
      UiError["_tag"],
      "ProviderError" | "DriverError" | "ConfigLoadError" | "ConfigWriteError" | "NoModelError"
    >,
    string
  >
> = {
  StorageError: "Storage",
  SessionRuntimeError: "Runtime",
  EventStoreError: "Events",
  NotFoundError: "Not found",
  InvalidStateError: "Invalid",
  SessionDepthLimitError: "Depth",
  RunPathRefusedError: "Paths",
  ParentBoundError: "Parent",
  ProviderAuthError: "Auth",
  ExtensionProtocolError: "Extension protocol",
  RpcClientError: "Connection",
  "@gent/core/GentConnectionError": "Connection",
  InteractionDecisionConflictError: "Interaction",
  InteractionRequestMismatchError: "Interaction",
  WorkspaceHeaderError: "Workspace",
}

export const formatError = (error: UiError): string => {
  switch (error._tag) {
    case "ProviderError":
      return `${error.model}: ${error.message}`
    case "DriverError":
      return `Driver ${error.driver}: ${error.reason}`
    case "ConfigLoadError":
    case "ConfigWriteError":
      return `Config ${error.path}: ${error.message}`
    // The message names the fix (`/model`) itself.
    case "NoModelError":
      return error.message
    default:
      return `${ERROR_PREFIX[error._tag]}: ${error.message}`
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

/**
 * A call's receipt summary with its paths read as the rows read theirs:
 * each absolute path word through {@link displayPath}.
 */
export const placedSummary = (summary: string, place: PathPlace): string =>
  summary
    .split(" ")
    .map((word) =>
      Option.match(
        Option.liftPredicate(word, (value) => value.length > 1 && value.startsWith("/")),
        {
          onNone: () => word,
          onSome: (path) => displayPath(path, place),
        },
      ),
    )
    .join(" ")

/**
 * What a receipt summary adds to a row that already names its subject: the
 * placed summary, less a lead that repeats the subject. The read, write and
 * edit summaries start with their path, so under `a.ts` the row reads
 * `a.ts · 3 lines`, not `a.ts /abs/a.ts · 3 lines`.
 */
export const summaryAfterSubject = (summary: string, subject: string, place: PathPlace): string => {
  const placed = placedSummary(summary.trim(), place)
  if (subject.length === 0 || !placed.startsWith(`${subject} `)) return placed
  return placed.slice(subject.length + 1)
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

/** `<name> · <task>`: the start's own name says who, the task what; a start with no name shows its task. */
function summarizeDelegate(args: Schema.JsonObject): string {
  const todo = truncate(getStringArg(args, "todo"), 40)
  const name = getStringArg(args, "name").replace(/\s+/g, " ").trim()
  if (name.length === 0) return todo
  return `${name} · ${todo}`
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

// ── reasoning text ──────────────────────────────────────────────────────────

/**
 * Reasoning summaries, prepared for the markdown renderer.
 *
 * A model emits reasoning as a run of summaries, each its own bold markdown
 * heading, and `messagePartsReasoning` joins the parts with an empty string:
 *
 *     **Verifying final test output****Refactoring LedgerStore.list…**
 *
 * The run is split back into summaries and joined with a blank line, the
 * paragraph break markdown needs to draw each summary as its own line.
 */

/** A bold span that ends where the next one begins, with no separator between. */
const collidingSummaries = /\*\*(?=\*\*)/g

export const reasoningMarkdown = (reasoning: string): string => {
  if (reasoning.length === 0) return ""
  return reasoning
    .replace(collidingSummaries, "**\n\n")
    .split("\n\n")
    .map((summary) => summary.trim())
    .filter((summary) => summary.length > 0)
    .join("\n\n")
}

/** The summaries of a reasoning run, oldest first: one paragraph each. */
export const reasoningSummaries = (reasoning: string): ReadonlyArray<string> =>
  reasoningMarkdown(reasoning)
    .split("\n\n")
    .filter((summary) => summary.length > 0)

const nonEmpty = (text: string) => text.length > 0

/**
 * A summary's heading: its first line, when the model marks it as one. A
 * markdown heading (`## Planning`) loses its marks. A line that opens in bold
 * reads as Codex reads it, the bold text and what follows it on the line
 * (`**Checking tests**: running suite` reads `Checking tests: running
 * suite`). A first line in plain prose is the reasoning itself: `None`.
 */
export const summaryHeading = (summary: string): Option.Option<string> => {
  const first = (summary.split("\n")[0] ?? "").trim()
  const marked = Option.fromNullishOr(/^#+\s+(.*)$/.exec(first))
  if (Option.isSome(marked)) return Option.liftPredicate((marked.value[1] ?? "").trim(), nonEmpty)
  if (!first.startsWith("**")) return Option.none()
  const close = first.indexOf("**", 2)
  if (close < 0) return Option.none()
  return Option.liftPredicate(`${first.slice(2, close)}${first.slice(close + 2)}`.trim(), nonEmpty)
}

/**
 * The newest heading in a run of reasoning texts, oldest first: what the live
 * line names while the model thinks (Codex's status header). `None` when no
 * summary carries one, so raw reasoning never reaches the line.
 */
export const latestReasoningHeading = (
  reasonings: ReadonlyArray<string>,
): Option.Option<string> => {
  for (const reasoning of reasonings.toReversed()) {
    for (const summary of reasoningSummaries(reasoning).toReversed()) {
      const heading = summaryHeading(summary)
      if (Option.isSome(heading)) return heading
    }
  }
  return Option.none()
}

// ── RLM activity summary ──
// The collapsed transcript group describes what the cell did, not that a tool ran.

/**
 * How a tool ended. `cancelled`: the turn's interrupt or the cell's cancel
 * cut it; that is one event, not a failure.
 */
export type ActivityOutcome = "succeeded" | "failed" | "cancelled" | "incomplete" | "running"

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
  /** The status a command that ran and failed exited with. */
  readonly exit?: number
  /** The first line of why a failed op failed; empty when it gives none. */
  readonly reason?: string
  /**
   * The whole error text of an op that failed with an error, without the
   * runner's lead: a failed cell whose own error is this text failed with it.
   */
  readonly failure?: string
  /** The call the op was read from: none for a saved receipt. A preview head reads its output. */
  readonly source?: ToolCall
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
  /** The first line of why the call itself failed, as its failure row says it. */
  readonly reason?: string
  /** The whole error text of the call's own failure, without the runner's lead. */
  readonly failure?: string
  /**
   * The call was cut: its result is the turn's interrupt or the cell's
   * cancel. Its ops cut with it say `cancelled`, and it adds no failure.
   */
  readonly cancelled?: boolean
  /** The call itself: its own failure's preview head reads it. */
  readonly source?: ToolCall
}

// ── Cell intent ──
// A cell with no inner calls still did something; its source says what.

/**
 * A call a cell's source spells out: the tool it stands for, its argument
 * when the source names one, and the label a row shows for it.
 */
interface CellCall {
  readonly tool: string
  readonly detail: string
  readonly label: string
}

const hostCall = (id: string): CellCall => ({ tool: id, detail: "", label: id })

const shellCall = (command: string): CellCall => {
  const head = shellHead(command)
  return { tool: "bash", detail: head, label: `$ ${head}` }
}

const CELL_VERB_PATTERNS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => CellCall]> = [
  [
    /\btools((?:\.[A-Za-z_$][\w$]*|\[\s*["'`][^"'`]+["'`]\s*\])+)\s*\(/g,
    (m) => hostCall(hostToolId(m[1] ?? "")),
  ],
  // `tools("read.then")(input)` calls by id; a bare `tools(id)` only reads the catalog.
  [/\btools\(\s*["'`]([^"'`]+)["'`]\s*\)\s*\(/g, (m) => hostCall(m[1] ?? "")],
  [/Bun\.\$`([^`]*)`/g, (m) => shellCall(m[1] ?? "")],
  [
    /Bun\.spawn\(\s*(?:\{\s*cmd:\s*)?\[\s*((?:["'`][^"'`]*["'`]\s*,?\s*)+)\]/g,
    (m) => shellCall(argv(m[1] ?? "")),
  ],
  [
    /Bun\.file\(\s*["'`]([^"'`]+)["'`]/g,
    (m) => ({ tool: "read", detail: m[1] ?? "", label: `read ${m[1]}` }),
  ],
  [
    /Bun\.write\(\s*["'`]([^"'`]+)["'`]/g,
    (m) => ({ tool: "write", detail: m[1] ?? "", label: `write ${m[1]}` }),
  ],
  [
    /new Bun\.Glob\(\s*["'`]([^"'`]+)["'`]/g,
    (m) => ({ tool: "glob", detail: m[1] ?? "", label: `glob ${m[1]}` }),
  ],
  [
    /\bfetch\(\s*["'`]([^"'`]+)["'`]/g,
    (m) => {
      const host = urlHost(m[1] ?? "")
      return { tool: "webfetch", detail: host, label: `fetch ${host}` }
    },
  ],
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

/** The calls a cell's source spells out, in source order: host tools, shell, files, globs, fetches. */
const cellCalls = (code: string): ReadonlyArray<CellCall> => {
  const found: Array<{ readonly index: number; readonly call: CellCall }> = []
  for (const [pattern, toCall] of CELL_VERB_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const call = toCall(match)
      if (call.label.trim().length > 0) found.push({ index: match.index, call })
    }
  }
  found.sort((left, right) => left.index - right.index)
  return found.map((entry) => entry.call)
}

/** The verbs a cell's source spells out, in source order: host tools, shell, files, globs, fetches. */
export function describeCellCode(code: string): ReadonlyArray<string> {
  return collapseRepeats(cellCalls(code).map((call) => call.label))
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
export const callOutcome = (status: ActivityCall["status"]): "succeeded" | "failed" | "running" => {
  if (status === "running") return "running"
  if (status === "error") return "failed"
  return "succeeded"
}

const isFailedOp = (operation: ActivityOperation) => operation.outcome === "failed"

const isCancelledOp = (operation: ActivityOperation) => operation.outcome === "cancelled"

/** A call's own outcome: a cut call is cancelled, not failed. */
const ownOutcome = (call: ActivityCall): ActivityOutcome => {
  if (call.cancelled === true) return "cancelled"
  return callOutcome(call.status)
}

/** Why a call itself failed; a cut call says `cancelled` and nothing more. */
const ownReason = (call: ActivityCall): string => {
  if (call.cancelled === true) return ""
  return call.reason ?? ""
}

/**
 * One line of a group: a tool the run called, or a cell's own failure or
 * cancel. A cell's own ending is no tool, so the header leaves it out of the
 * tool count and counts it among the failures or the cancels.
 */
interface ActivityEntry {
  readonly operation: ActivityOperation
  readonly tool: boolean
  /** The source of a cell with no ops: the header counts the calls it spells out. */
  readonly code: string
}

/**
 * What a call with no ops did: its source's verbs, else its first line. A
 * failed call's reason is its failure row's, which every level draws.
 */
const opLessDetail = (call: ActivityCall): string => {
  const verbs = describeCellCode(call.code).join(" · ")
  if (verbs.length > 0) return verbs
  return truncate(call.code.split("\n")[0] ?? "", 60)
}

/**
 * Whether a failed cell's failure is shown to be one of its ops' failures:
 * the cell's error is that op's error text. A host failure the cell did not
 * catch leaves the cell with the op's message unchanged; a cell that caught
 * it and threw its own error, or a cut or cancelled cell, gives another text.
 * With no such proof both failures show: a row said twice costs less than a
 * failure hidden.
 */
const failedWithOp = (call: ActivityCall): boolean =>
  Option.match(
    Option.filter(Option.fromUndefinedOr(call.failure), (text) => text.length > 0),
    {
      onNone: () => false,
      onSome: (text) =>
        call.operations.some((operation) => isFailedOp(operation) && operation.failure === text),
    },
  )

/**
 * Whether a cell's own ending is said already by its ops: a failure shown to
 * be an op's (`failedWithOp`), or a cancel that cut an op (that op says
 * `cancelled`). A cancel between ops is the cell's own one row.
 */
const endingSaidByOps = (call: ActivityCall): boolean => {
  if (call.cancelled === true) return call.operations.some(isCancelledOp)
  return failedWithOp(call)
}

/**
 * The tools of a group in call order. A cell with no ops is one tool that
 * names its source's verbs. A cell that failed or was cancelled adds its own
 * ending after its ops (a throw after its ops, a restart, a cancel between
 * ops), unless its ops say it already (`endingSaidByOps`): one event, said
 * once.
 */
const activityEntries = (calls: ReadonlyArray<ActivityCall>): ReadonlyArray<ActivityEntry> =>
  calls.flatMap((call): ReadonlyArray<ActivityEntry> => {
    if (call.operations.length === 0) {
      const operation = {
        tool: call.toolName,
        outcome: ownOutcome(call),
        detail: opLessDetail(call),
        reason: ownReason(call),
        source: call.source,
      }
      return [{ operation, tool: true, code: call.code }]
    }
    const entries = call.operations.map((operation) => ({ operation, tool: true, code: "" }))
    if (call.status !== "error" || endingSaidByOps(call)) return entries
    const failure: ActivityOperation = {
      tool: call.toolName,
      outcome: ownOutcome(call),
      detail: "",
      reason: ownReason(call),
      source: call.source,
    }
    return [...entries, { operation: failure, tool: false, code: "" }]
  })

/** The unit a header counts each tool's ops in: `read 3 files`, `ran 2 commands`. */
const TOOL_UNITS: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["read", ["file", "files"]],
  ["read_session", ["session", "sessions"]],
  ["grep", ["pattern", "patterns"]],
  ["glob", ["pattern", "patterns"]],
  ["webfetch", ["page", "pages"]],
  ["edit", ["file", "files"]],
  ["write", ["file", "files"]],
  ["bash", ["command", "commands"]],
  ["delegate.start", ["agent", "agents"]],
  ["thread.start", ["thread", "threads"]],
  ["ask_user", ["question", "questions"]],
  ["ask_user_async", ["question", "questions"]],
])

/** An MCP tool's id, `mcp.<server>.<tool>`, as its server and its call `<server>.<tool>`. */
const mcpTool = (
  tool: string,
): Option.Option<{ readonly server: string; readonly call: string }> => {
  if (!tool.startsWith("mcp.")) return Option.none()
  const call = tool.slice("mcp.".length)
  const dot = call.indexOf(".")
  if (dot <= 0) return Option.none()
  return Option.some({ server: call.slice(0, dot), call })
}

/**
 * What a header counts a tool as: a verb phrase in the words its preview
 * rows use (`Read`, `Ran`), past once its ops ended, running while one runs.
 */
interface ToolKind {
  /** Tools of one key count as one kind: `grep` and `glob` both searched patterns. */
  readonly key: string
  /** `count` ops of the kind: `read 3 files`, `reading 3 files`, `searched the web 2×`. */
  readonly phrase: (count: number, running: boolean) => string
  /** The phrase opens with a verb, which a line's first part capitalizes; a bare tool id does not. */
  readonly verb: boolean
}

const tense = (words: readonly [string, string], running: boolean): string => {
  if (running) return words[1]
  return words[0]
}

/** A tool's verb as a header phrase opens with it: `read`, `running`. */
const verbOf = (tool: string, running: boolean): string =>
  tense(toolVerbs(tool), running).toLowerCase()

/** `proposed a handoff`: one handoff is one proposal, not a count. */
const handoffPhrase = (count: number, running: boolean): string => {
  const verb = tense(["proposed", "proposing"], running)
  if (count === 1) return `${verb} a handoff`
  return `${verb} ${count} handoffs`
}

/** A cell whose source spells out no call it can name: `ran code`, never the code. */
const CODE_KIND: ToolKind = {
  key: "code",
  verb: true,
  phrase: (count, running) => {
    const verb = tense(["ran", "running"], running)
    if (count === 1) return `${verb} code`
    return `${verb} code ${count}×`
  },
}

/**
 * The kind a header counts a tool as. A tool with a unit counts its ops in
 * it; the web search, an MCP server (as Codex names it) and a tool not named
 * here count their calls (`called linear 2×`, `lint_fix 2×`).
 */
const toolKind = (tool: string): ToolKind => {
  if (tool === "websearch")
    return {
      key: tool,
      verb: true,
      phrase: (count, running) => `${verbOf(tool, running)} the web ${count}×`,
    }
  if (tool === "handoff") return { key: tool, verb: true, phrase: handoffPhrase }
  return Option.match(Option.fromUndefinedOr(TOOL_UNITS.get(tool)), {
    onSome: ([one, many]): ToolKind => ({
      key: `${verbOf(tool, false)} ${many}`,
      verb: true,
      phrase: (count, running) => `${verbOf(tool, running)} ${plural(count, one, many)}`,
    }),
    onNone: () =>
      Option.match(mcpTool(tool), {
        onSome: ({ server }): ToolKind => ({
          key: `mcp.${server}`,
          verb: true,
          phrase: (count, running) => `${verbOf(tool, running)} ${server} ${count}×`,
        }),
        onNone: (): ToolKind => ({
          key: tool,
          verb: false,
          phrase: (count) => `${tool} ${count}×`,
        }),
      }),
  })
}

/** The kinds one tool entry counts as: a cell with no ops counts the calls its source spells out. */
const entryKinds = (entry: ActivityEntry): ReadonlyArray<ToolKind> => {
  if (entry.operation.tool !== "cell") return [toolKind(entry.operation.tool)]
  const spelled = cellCalls(entry.code)
  if (spelled.length === 0) return [CODE_KIND]
  return spelled.map((call) => toolKind(call.tool))
}

/** A line's first part opens as a sentence does, when it opens with a verb. */
const sentence = (kind: ToolKind, text: string): string => {
  if (!kind.verb) return text
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

interface KindCount {
  readonly kind: ToolKind
  readonly count: number
}

const tally = (counts: Map<string, KindCount>, kind: ToolKind) => {
  const earlier = Option.fromUndefinedOr(counts.get(kind.key))
  counts.set(kind.key, {
    kind,
    count: Option.match(earlier, { onNone: () => 1, onSome: (value) => value.count + 1 }),
  })
}

/**
 * Header for a group of calls, in the words its rows use: `Read 3 files ·
 * ran 2 commands · searched 1 pattern · edited 1 file · 1 failed`. Kinds go
 * largest first, ties in the order they ran; the ops still running read
 * last, in the running tense (`running 1 command`), and the failures and
 * cancels end it. A header counts no thoughts and sums no time: the turn
 * line holds the time. Where it is wider than `width` columns, kinds drop
 * from the right; the first kind, the failures and the cancels stay.
 */
export function formatActivityHeader(
  calls: ReadonlyArray<ActivityCall>,
  width = Number.POSITIVE_INFINITY,
): string {
  if (calls.length === 0) return ""
  const entries = activityEntries(calls)
  const ended = new Map<string, KindCount>()
  const running = new Map<string, KindCount>()
  for (const entry of entries) {
    if (!entry.tool) continue
    let counts = ended
    if (entry.operation.outcome === "running") counts = running
    for (const kind of entryKinds(entry)) tally(counts, kind)
  }
  const phrases = [
    ...Array.from(ended.values())
      .toSorted((left, right) => right.count - left.count)
      .map(({ kind, count }) => ({ kind, text: kind.phrase(count, false) })),
    ...Array.from(running.values(), ({ kind, count }) => ({
      kind,
      text: kind.phrase(count, true),
    })),
  ].map(({ kind, text }, index) => {
    if (index === 0) return sentence(kind, text)
    return text
  })
  const failed = entries.filter((entry) => isFailedOp(entry.operation)).length
  const cancelled = entries.filter((entry) => isCancelledOp(entry.operation)).length
  const tail: string[] = []
  if (failed > 0) tail.push(`${failed} failed`)
  if (cancelled > 0) tail.push(`${cancelled} cancelled`)
  const join = (kept: number) => [...phrases.slice(0, kept), ...tail].join(" · ")
  let kept = phrases.length
  while (kept > 1 && textWidth(join(kept)) > width) kept -= 1
  return join(kept)
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
  ["thread.start", ["Started", "Starting"]],
  ["ask_user", ["Asked", "Asking"]],
  ["ask_user_async", ["Asked", "Asking"]],
])

/** Past and running tense of a tool's verb: an MCP tool was `Called`, and one not named shows its id. */
const toolVerbs = (tool: string): readonly [string, string] =>
  TOOL_VERBS.get(tool) ??
  Option.match(mcpTool(tool), {
    onNone: () => [tool, tool] as const,
    onSome: () => ["Called", "Calling"] as const,
  })

/** What an op's row names: its argument, after the server's call for an MCP tool. */
const operationSubject = (operation: ActivityOperation): string =>
  Option.match(mcpTool(operation.tool), {
    onNone: () => operation.detail,
    onSome: ({ call }) => [call, operation.detail].filter((part) => part.length > 0).join(" "),
  })

/**
 * A cell with no op yet, in the running words of the calls its source spells
 * out, one phrase a kind in source order, as the header counts them:
 * `Reading 3 files · Running 2 commands`, or the call itself when it is the
 * kind's one call and names its argument (`Running mkdir -p out`). Never the
 * code: a source with no call it can name reads `Running code`.
 */
const runningCellPhrase = (code: string): string => {
  const byKind = new Map<string, { readonly kind: ToolKind; readonly calls: CellCall[] }>()
  for (const call of cellCalls(code)) {
    const kind = toolKind(call.tool)
    const group = Option.getOrElse(Option.fromUndefinedOr(byKind.get(kind.key)), () => ({
      kind,
      calls: [],
    }))
    byKind.set(kind.key, { kind, calls: [...group.calls, call] })
  }
  const phrases = Array.from(byKind.values(), ({ kind, calls }) => {
    const [only] = calls
    if (calls.length === 1 && Predicate.isNotUndefined(only) && only.detail.length > 0)
      return formatRunningCall(only.tool, only.detail)
    return sentence(kind, kind.phrase(calls.length, true))
  })
  if (phrases.length === 0) return sentence(CODE_KIND, CODE_KIND.phrase(1, true))
  return phrases.join(" · ")
}

/**
 * A running call as the activity row names it, in the words its group row
 * will use once it ends: `Running mkdir -p x`, `Reading src/app.tsx`,
 * `Calling linear.list_issues team=core`. A cell's detail is its source,
 * read as the calls it spells out (`Reading 3 files`).
 */
export const formatRunningCall = (tool: string, detail: string): string => {
  if (tool === "cell") return runningCellPhrase(detail)
  return [toolVerbs(tool)[1], operationSubject({ tool, detail, outcome: "running" })]
    .filter((part) => part.length > 0)
    .join(" ")
}

/**
 * The live line's label for a running call: a cell reads its whole source,
 * any other tool the label of its arguments. Paths read from `place`.
 */
export const runningCallLabel = (tool: string, input: ToolInput, place: PathPlace): string => {
  if (tool !== "cell") return formatRunningCall(tool, toolArgSummary(tool, input, place))
  const code = Option.match(decodeToolArgs(input), {
    onNone: () => "",
    onSome: (args) => getStringArg(args, "code"),
  })
  return formatRunningCall(tool, code)
}

/** One row of a group at the preview level: a run of ops of one tool and one outcome. */
interface ActivityRow {
  readonly tool: string
  readonly outcome: ActivityOutcome
  readonly subjects: ReadonlyArray<string>
  /** The summed lines the row's edits changed; none for a row with no edit. */
  readonly diff: Option.Option<DiffCount>
  /** The ops the row stands for, in order: the last one's output is the row's head. */
  readonly operations: ReadonlyArray<ActivityOperation>
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
 * `Read` row. A running, failed or cancelled op keeps a row of its own: a
 * failure is one row, with its own exit status and reason.
 */
export const activityRows = (calls: ReadonlyArray<ActivityCall>): ReadonlyArray<ActivityRow> => {
  const rows: ActivityRow[] = []
  for (const { operation } of activityEntries(calls)) {
    const subjects = Option.toArray(
      Option.liftPredicate(operationSubject(operation), (subject) => subject.length > 0),
    )
    const diff = Option.fromUndefinedOr(operation.diff)
    const previous = Option.filter(
      Option.fromUndefinedOr(rows.at(-1)),
      (row) =>
        row.tool === operation.tool &&
        row.outcome === operation.outcome &&
        operation.outcome !== "running" &&
        operation.outcome !== "failed" &&
        operation.outcome !== "cancelled",
    )
    if (Option.isSome(previous)) {
      const row = previous.value
      rows[rows.length - 1] = {
        ...row,
        subjects: [...row.subjects, ...subjects],
        diff: addDiff(row.diff, diff),
        operations: [...row.operations, operation],
      }
    } else {
      rows.push({
        tool: operation.tool,
        outcome: operation.outcome,
        subjects,
        diff,
        operations: [operation],
      })
    }
  }
  return rows
}

/** The failed and cancelled ops of a group in call order: the collapsed level draws a row for each. */
export const collapsedOperations = (
  calls: ReadonlyArray<ActivityCall>,
): ReadonlyArray<ActivityOperation> =>
  activityEntries(calls)
    .map((entry) => entry.operation)
    .filter(Predicate.or(isFailedOp, isCancelledOp))

/** What a failure row says ended the op: `cancelled`, a command's exit status, else `failed`. */
const failureWord = (operation: ActivityOperation): string => {
  if (isCancelledOp(operation)) return "cancelled"
  return Option.match(Option.fromUndefinedOr(operation.exit), {
    onNone: () => "failed",
    onSome: (status) => `exit ${status}`,
  })
}

/** A row as text, in parts: the diff counts draw in their own colours between head and tail. */
interface ActivityRowText {
  readonly head: string
  readonly diff: Option.Option<DiffCount>
  readonly tail: string
}

/**
 * A row in past-tense words, fitted to `width` columns: `Read a.ts, b.ts +1`,
 * `Edited x.ts +12 / -3`, `Ran bun test · exit 1`, `Running bun test`. The
 * subjects that fit the width show, then `+N` counts the rest.
 */
export function formatActivityRow(
  row: ActivityRow,
  width = Number.POSITIVE_INFINITY,
): ActivityRowText {
  const tense = toolVerbs(row.tool)
  let verb = tense[0]
  if (row.outcome === "running") verb = tense[1]
  let tail = ""
  // A failed row holds one op: the row ends with its exit status, or `failed`.
  if (row.outcome === "failed") {
    const words = row.operations.map(failureWord)
    tail = ` · ${words[0] ?? "failed"}`
  }
  if (row.outcome === "cancelled") tail = " · cancelled"
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

/** The narrowest reason a failure row still draws: a word start and the ellipsis. */
const MIN_REASON_COLUMNS = 4

/**
 * A failed op as the collapsed level's one line, fitted to `width` columns:
 * `Ran ls d.ts · exit 2 · ls: cannot access…`, `Read a.ts · failed · no such
 * file`. A narrow row cuts the reason first, then drops it, then cuts the
 * subject; the verb and the outcome always show.
 */
export function formatFailureRow(
  operation: ActivityOperation,
  width = Number.POSITIVE_INFINITY,
): string {
  const verb = toolVerbs(operation.tool)[0]
  const outcome = ` · ${failureWord(operation)}`
  const subject = operationSubject(operation)
  let head = verb
  if (subject.length > 0) head = `${verb} ${subject}`
  const reason = oneLine(operation.reason ?? "").trim()
  const room = width - textWidth(head + outcome) - 3
  if (reason.length > 0 && room >= Math.min(MIN_REASON_COLUMNS, textWidth(reason)))
    return `${head}${outcome} · ${truncate(reason, room)}`
  if (textWidth(head + outcome) <= width) return `${head}${outcome}`
  return `${truncate(head, Math.max(textWidth(verb), width - textWidth(outcome)))}${outcome}`
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

// ── Working icons ──
// A running child agent or thread pulses a diamond; a running tool run blinks
// its bullet. One glyph, one meaning: the two never share a shape.

const WORKING_ICON_FRAMES: ReadonlyArray<string> = ["◇", "◈", "◆", "◈"]

/** The frame for a spinner tick (60ms); the pulse turns every 250ms. */
export const workingIconFrame = (tick: number): string =>
  WORKING_ICON_FRAMES[Math.floor(tick / 4) % WORKING_ICON_FRAMES.length] ?? "◇"

const TOOL_RUN_FRAMES: ReadonlyArray<string> = ["○", "●"]

/** A running tool run's bullet for a spinner tick (60ms): hollow, then solid, every half second. */
export const toolRunFrame = (tick: number): string =>
  TOOL_RUN_FRAMES[Math.floor(tick / 8) % TOOL_RUN_FRAMES.length] ?? "○"

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
