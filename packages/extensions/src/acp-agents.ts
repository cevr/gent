import {
  Array as Arr,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  HashMap,
  HashSet,
  Layer,
  Match,
  Option,
  Predicate,
  PubSub,
  Ref,
  Schema,
  Scope,
  type Sink,
  Stream,
  TxQueue,
  TxRef,
} from "effect"
import * as Response from "effect/unstable/ai/Response"
import {
  AgentDefinition,
  AgentName,
  defineExtension,
  defineResource,
  ExtensionHost,
  ExternalDriverRef,
  type GentExtension,
  InteractionPendingError,
  isRecord,
  type TurnContext,
  TurnError,
  type TurnExecutor,
  type TurnStreamPart,
} from "@gent/core/extensions/api"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

// ── wire schema ─────────────────────────────────────────────────────────────

/**
 * ACP (Agent Client Protocol) v1 — Effect Schema types.
 *
 * Only the subset gent needs as a client. All field names match
 * the wire format (camelCase per serde(rename_all = "camelCase")).
 *
 * @module
 */

// ── Shared ──

class Implementation extends Schema.Class<Implementation>("AcpImplementation")({
  name: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  version: Schema.String,
}) {}

// ── Initialize ──

class FsCapabilities extends Schema.Class<FsCapabilities>("AcpFsCapabilities")({
  readTextFile: Schema.optional(Schema.Boolean),
  writeTextFile: Schema.optional(Schema.Boolean),
}) {}

class ClientCapabilities extends Schema.Class<ClientCapabilities>("AcpClientCapabilities")({
  fs: Schema.optional(FsCapabilities),
  terminal: Schema.optional(Schema.Boolean),
}) {}

class InitializeRequest extends Schema.Class<InitializeRequest>("AcpInitializeRequest")({
  protocolVersion: Schema.optional(Schema.Finite),
  clientCapabilities: Schema.optional(ClientCapabilities),
  clientInfo: Schema.optional(Implementation),
}) {}

class McpCapabilities extends Schema.Class<McpCapabilities>("AcpMcpCapabilities")({
  http: Schema.optional(Schema.Boolean),
  sse: Schema.optional(Schema.Boolean),
}) {}

class AgentCapabilities extends Schema.Class<AgentCapabilities>("AcpAgentCapabilities")({
  loadSession: Schema.optional(Schema.Boolean),
  mcpCapabilities: Schema.optional(McpCapabilities),
}) {}

class InitializeResponse extends Schema.Class<InitializeResponse>("AcpInitializeResponse")({
  protocolVersion: Schema.Finite,
  agentCapabilities: Schema.optional(AgentCapabilities),
  agentInfo: Schema.optional(Implementation),
}) {}

// ── Session ──

class NewSessionRequest extends Schema.Class<NewSessionRequest>("AcpNewSessionRequest")({
  cwd: Schema.String,
  mcpServers: Schema.optional(Schema.Array(Schema.Unknown)),
  /**
   * Out-of-band metadata. ACP agents that recognise it use
   * `_meta.systemPrompt: string` to replace the default system prompt
   * (or `{ append: string }` to append). Treated as `Schema.Unknown` —
   * the wire format is open and per-agent.
   */
  _meta: Schema.optional(Schema.Unknown),
}) {}

class NewSessionResponse extends Schema.Class<NewSessionResponse>("AcpNewSessionResponse")({
  sessionId: Schema.String,
}) {}

// ── Prompt ──

class PromptRequest extends Schema.Class<PromptRequest>("AcpPromptRequest")({
  sessionId: Schema.String,
  prompt: Schema.Array(Schema.Unknown),
}) {}

export const StopReason = Schema.Literals([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
])
export type StopReason = typeof StopReason.Type

class PromptResponse extends Schema.Class<PromptResponse>("AcpPromptResponse")({
  stopReason: StopReason,
}) {}

export class SessionNotification extends Schema.Class<SessionNotification>(
  "AcpSessionNotification",
)({
  sessionId: Schema.String,
  update: Schema.Unknown,
}) {}

// ── Request Permission (agent → client request) ──

class PermissionOption extends Schema.Class<PermissionOption>("AcpPermissionOption")({
  optionId: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["allow_once", "allow_always", "reject_once", "reject_always"]),
}) {}

class RequestPermissionRequest extends Schema.Class<RequestPermissionRequest>(
  "AcpRequestPermissionRequest",
)({
  sessionId: Schema.String,
  toolCall: Schema.Unknown,
  options: Schema.Array(PermissionOption),
}) {}

// ── config ──────────────────────────────────────────────────────────────────

/**
 * ACP agent configurations.
 *
 * Each agent is a subprocess gent spawns and talks to over stdio JSON-RPC.
 *
 * @module
 */

interface AcpProtocolAgentConfig {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/** Subprocess configurations for ACP-protocol agents. */
export const ACP_PROTOCOL_AGENTS = {
  opencode: { command: "opencode", args: ["acp"] },
  "gemini-cli": { command: "gemini", args: ["acp"] },
} satisfies Readonly<Record<string, AcpProtocolAgentConfig>>

// ── transcript ──────────────────────────────────────────────────────────────

/**
 * Transcript composition for external-session rebuilds.
 *
 * The ACP transport exposes only a user-message input channel. When a cached session is rebuilt mid-conversation
 * (fingerprint mismatch, `invalidateDriver`, manual `invalidate`), the
 * remote agent has zero memory of prior turns — sending only the live
 * user message would silently drop the history. The executor seeds the
 * fresh session with a `<historical-transcript>` preamble that renders
 * prior messages with structured tool/reasoning blocks, then appends the
 * live user message.
 *
 * The preamble keeps every `tool_use`/`tool_result`/`reasoning` block, so a
 * tool-heavy session survives a rebuild. User content is HTML-escaped and
 * the whole preamble is wrapped in `<historical-transcript>` so the remote
 * agent treats it as context, not instructions.
 *
 * @module
 */

interface TranscriptPart {
  readonly type: string
  readonly text?: string
  readonly toolCallId?: string
  readonly toolName?: string
  readonly input?: unknown
  readonly output?: { readonly type: string; readonly value: unknown }
  readonly image?: string
  readonly mediaType?: string
}

// Cap inline base64 payloads in the historical transcript — multi-MB
// screenshots blow context faster than they help. URLs and short data
// URIs render in full; longer payloads keep the head + a length marker
// so the model can still reference "the prior image" by media type and
// position.
const IMAGE_PAYLOAD_MAX = 256

const renderImagePayload = (raw: string): string => {
  if (raw.length <= IMAGE_PAYLOAD_MAX) return raw
  return `${raw.slice(0, IMAGE_PAYLOAD_MAX)}…(truncated, ${raw.length} chars)`
}

interface MessageLike {
  readonly role: string
  readonly parts: ReadonlyArray<TranscriptPart>
}

const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      case "'":
        return "&apos;"
      default:
        return ch
    }
  })

const encodeTranscriptJson = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))

const stringifyForAttr = (value: TranscriptPart["input"]): string =>
  Option.match(Option.fromNullishOr(value), {
    onNone: () => "null",
    onSome: (input) => Option.getOrElse(encodeTranscriptJson(input), () => String(input)),
  })

const renderText = (part: TranscriptPart): Option.Option<string> => {
  const text = part.text ?? ""
  if (text.length === 0) return Option.none()
  return Option.some(escapeXml(text))
}

const renderReasoning = (part: TranscriptPart): Option.Option<string> => {
  const text = part.text ?? ""
  if (text.length === 0) return Option.none()
  return Option.some(`<thinking>${escapeXml(text)}</thinking>`)
}

const renderToolCall = (part: TranscriptPart): string => {
  const name = part.toolName ?? "unknown"
  const id = part.toolCallId ?? ""
  const input = stringifyForAttr(part.input)
  return `<tool name="${escapeXml(name)}" tool_id="${escapeXml(id)}" input="${escapeXml(input)}" />`
}

const renderToolResult = (part: TranscriptPart): string => {
  const id = part.toolCallId ?? ""
  let status = "ok"
  if (part.output?.type === "error-json") status = "error"
  const value = stringifyForAttr(part.output?.value)
  return `<result tool_id="${escapeXml(id)}" status="${escapeXml(status)}">${escapeXml(value)}</result>`
}

const renderImage = (
  part: TranscriptPart,
  options: { readonly truncatePayload: boolean },
): string => {
  let mediaAttr = ""
  if (part.mediaType && part.mediaType.length > 0) {
    mediaAttr = ` mediaType="${escapeXml(part.mediaType)}"`
  }
  const src = part.image ?? ""
  if (src.length === 0) return `<image${mediaAttr} />`
  let renderedSrc = src
  if (options.truncatePayload) renderedSrc = renderImagePayload(src)
  return `<image${mediaAttr} src="${escapeXml(renderedSrc)}" />`
}

const renderPart = (
  part: TranscriptPart,
  options: { readonly truncateImagePayloads: boolean },
): Option.Option<string> => {
  switch (part.type) {
    case "text":
      return renderText(part)
    case "reasoning":
      return renderReasoning(part)
    case "tool-call":
      return Option.some(renderToolCall(part))
    case "tool-result":
      return Option.some(renderToolResult(part))
    case "image":
      return Option.some(renderImage(part, { truncatePayload: options.truncateImagePayloads }))
    default:
      return Option.none()
  }
}

const renderMessage = (msg: MessageLike): Option.Option<string> => {
  const rendered = Arr.getSomes(
    msg.parts.map((part) => renderPart(part, { truncateImagePayloads: true })),
  )
  if (rendered.length === 0) return Option.none()
  const role = escapeXml(msg.role)
  return Option.some(`<${role}>\n${rendered.join("\n")}\n</${role}>`)
}

/**
 * Render every message *before* the final user turn as a
 * `<historical-transcript>` preamble, then append the live user message
 * verbatim.
 *
 * The preamble renders structured `<tool>`, `<result>`, `<thinking>`
 * blocks alongside plain text; user-visible content is HTML-escaped and
 * the whole envelope is labelled so the remote agent reads it as
 * context, not instructions. When there is no prior history the
 * function returns the live user message unchanged.
 */
export const composePromptWithTranscript = (
  messages: ReadonlyArray<MessageLike>,
  liveUser: MessageLike | string | Option.Option<MessageLike>,
): string => {
  const lastUserIdx = findLastUserMessageIndex(messages)
  let history: ReadonlyArray<MessageLike> = []
  if (lastUserIdx > 0) history = messages.slice(0, lastUserIdx)
  let liveUserText: string
  if (Predicate.isString(liveUser)) liveUserText = liveUser
  else if (Option.isOption(liveUser)) liveUserText = renderLiveUserPrompt(liveUser)
  else liveUserText = renderLiveUserPrompt(Option.some(liveUser))
  if (history.length === 0) return liveUserText

  const blocks: string[] = []
  for (const msg of history) {
    const rendered = renderMessage(msg)
    if (Option.isSome(rendered)) blocks.push(rendered.value)
  }
  if (blocks.length === 0) return liveUserText

  return [
    "<historical-transcript>",
    "The following is a record of prior turns in this conversation. Treat it",
    "as read-only context that has already happened — do not re-execute the",
    "tool calls or repeat the prior assistant output.",
    ...blocks,
    "</historical-transcript>",
    "",
    liveUserText,
  ].join("\n")
}

export const findLastUserMessage = (
  messages: ReadonlyArray<MessageLike>,
): Option.Option<MessageLike> => Arr.findLast(messages, (message) => message.role === "user")

export const renderLiveUserPrompt = (selected: Option.Option<MessageLike>): string => {
  if (Option.isNone(selected)) return ""
  const message = selected.value
  const rendered = Arr.getSomes(
    message.parts.map((part) => renderPart(part, { truncateImagePayloads: false })),
  )
  if (rendered.length === 0) return ""
  const [only] = message.parts
  if (message.parts.length === 1 && only?.type === "text") return only.text ?? ""
  return ["<user-message>", ...rendered, "</user-message>"].join("\n")
}

const findLastUserMessageIndex = (messages: ReadonlyArray<MessageLike>): number => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i
  }
  return -1
}

// ── response finish ─────────────────────────────────────────────────────────

/**
 * ACP `StopReason` → Effect AI `Response.FinishReason`.
 *
 * The two vocabularies do not overlap. ACP names its reasons
 * `end_turn | max_tokens | max_turn_requests | refusal | cancelled`
 * (`schema.ts`); `Response.FinishReason` names them
 * `stop | length | content-filter | tool-calls | error | pause | other |
 * unknown`. Matching on the AI-SDK spelling therefore never hit, and
 * every ACP turn finished as `"unknown"`.
 *
 * `Match.exhaustive` over the ACP literal union is the guard: a new ACP
 * stop reason added to `schema.ts` fails typecheck here instead of
 * silently degrading to `"unknown"` again.
 *
 * @module
 */

export const toResponseFinishReason: (stopReason: StopReason) => Response.FinishReason =
  Match.type<StopReason>().pipe(
    // The agent ended its turn on its own — a normal stop.
    Match.when("end_turn", (): Response.FinishReason => "stop"),
    // Both ACP budget stops are ceilings the agent hit; `length` is the
    // only FinishReason for "ran out of budget".
    Match.when("max_tokens", (): Response.FinishReason => "length"),
    Match.when("max_turn_requests", (): Response.FinishReason => "length"),
    // ACP has no separate safety reason; a refusal is the model
    // declining to produce the content.
    Match.when("refusal", (): Response.FinishReason => "content-filter"),
    // An interrupted turn is neither an error nor a stop sequence;
    // `other` is FinishReason's "stopped for a reason not in this
    // protocol".
    Match.when("cancelled", (): Response.FinishReason => "other"),
    Match.exhaustive,
  )

// ── protocol ────────────────────────────────────────────────────────────────

/**
 * Native Effect ACP client over newline-delimited JSON-RPC 2.0 on stdio.
 *
 * No npm dependency — uses effect/unstable/process ChildProcess for the
 * subprocess and Effect primitives (TxQueue, Deferred, HashMap, PubSub,
 * Stream, Sink) for multiplexing.
 *
 * @module
 */

// ── Error ──

export class AcpError extends Schema.TaggedError<AcpError>()("AcpError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Raised on every pending RPC `Deferred` when `AcpConnection.close`
 * runs. Without it, mid-turn invalidation (driver swap, manager
 * `tearDown`) would leak the executor's `Stream.interruptWhen(promptDone)`
 * forever — `promptDone` only resolves from the `prompt` RPC, and the
 * RPC's pending Deferred would never be signalled. Callers identify a
 * driver-invalidation hang vs. a transport error via this tag.
 */
export class AcpClosedError extends Schema.TaggedError<AcpClosedError>()("AcpClosedError", {
  reason: Schema.String,
}) {}

// ── Connection Interface ──

export interface AcpConnection {
  readonly initialize: (
    params: InitializeRequest,
  ) => Effect.Effect<InitializeResponse, AcpError | AcpClosedError>
  readonly newSession: (
    params: NewSessionRequest,
  ) => Effect.Effect<NewSessionResponse, AcpError | AcpClosedError>
  readonly prompt: (
    params: PromptRequest,
  ) => Effect.Effect<PromptResponse, AcpError | AcpClosedError>
  readonly cancel: (sessionId: string) => Effect.Effect<void>
  readonly updates: Stream.Stream<SessionNotification, AcpError>
  readonly close: (reason?: string) => Effect.Effect<void>
}

// ── Internal types ──

type RequestId = number
type PendingRequest = {
  readonly resolve: Deferred.Deferred<unknown, AcpError | AcpClosedError>
}
type PendingRequestMap = HashMap.HashMap<RequestId, PendingRequest>
const JsonRpcId = Schema.Union([Schema.Finite, Schema.String, Schema.Null])
type JsonRpcId = typeof JsonRpcId.Type
const JSON_NULL = Option.getOrNull(Option.none())

const PendingRequests = Schema.declare<PendingRequestMap>(
  (u): u is PendingRequestMap => HashMap.isHashMap(u),
  { identifier: "AcpPendingRequests" },
)

/**
 * The closed-flag and the pending-RPC map MUST be one atomic cell. A
 * naive layout (separate `closedRef` + `pendingRef`) leaks Deferreds
 * through this interleaving:
 *   1. rpcRaw reads closedRef = false
 *   2. close flips closedRef = true and drains pendingRef
 *   3. rpcRaw inserts its Deferred into the now-empty pendingRef
 *   4. rpcRaw awaits forever — never failed, never replied to
 * Folding both into `ConnState` lets `Ref.modify` make
 * "check-open-and-register" a single transaction.
 */
const ConnState = Schema.Union([
  Schema.TaggedStruct("Open", { pending: PendingRequests }),
  Schema.TaggedStruct("Closed", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
type ConnState = typeof ConnState.Type

const IncomingJsonRpcEnvelope = Schema.Record(Schema.String, Schema.Unknown)
type IncomingJsonRpcRecord = Schema.Schema.Type<typeof IncomingJsonRpcEnvelope>

type IncomingRequestHandler = (
  method: string,
  params: Schema.Schema.Type<typeof Schema.Unknown>,
) => Effect.Effect<Schema.Schema.Type<typeof Schema.Unknown>, AcpError>

// ── JSON-RPC wire helpers ──

const stringifyJsonRpc = (value: IncomingJsonRpcRecord): string =>
  // oxlint-disable-next-line effect/noGlobals -- JSON-RPC request encoding is the protocol wire boundary.
  JSON.stringify(value) || ""

const encodeRequest = (
  id: RequestId,
  method: string,
  params: Schema.Schema.Type<typeof Schema.Unknown>,
): string => `${stringifyJsonRpc({ jsonrpc: "2.0", id, method, params })}\n`

const encodeNotification = (
  method: string,
  params: Schema.Schema.Type<typeof Schema.Unknown>,
): string => `${stringifyJsonRpc({ jsonrpc: "2.0", method, params })}\n`

const encodeResponse = (id: JsonRpcId, result: Schema.Schema.Type<typeof Schema.Unknown>): string =>
  `${stringifyJsonRpc({ jsonrpc: "2.0", id, result })}\n`

const encodeErrorResponse = (id: JsonRpcId, code: number, message: string): string =>
  `${stringifyJsonRpc({ jsonrpc: "2.0", id, error: { code, message } })}\n`

// Incoming JSON-RPC envelopes: the wire format is a flat object with
// `id`, `method`, `params`, `result`, or `error` keys. We decode to an
// open record and let `handleLine` dispatch on field presence — the
// per-method payload schemas live in `./schema.ts` and are applied
// after routing.
const decodeIncomingEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(IncomingJsonRpcEnvelope),
)
const decodeInitializeResponse = (raw: Schema.Schema.Type<typeof Schema.Unknown>) =>
  Schema.decodeUnknownEffect(InitializeResponse)(raw).pipe(
    Effect.mapError((cause) => new AcpError({ message: "invalid ACP initialize response", cause })),
  )
const decodeNewSessionResponse = (raw: Schema.Schema.Type<typeof Schema.Unknown>) =>
  Schema.decodeUnknownEffect(NewSessionResponse)(raw).pipe(
    Effect.mapError(
      (cause) => new AcpError({ message: "invalid ACP session/new response", cause }),
    ),
  )
const decodePromptResponse = (raw: Schema.Schema.Type<typeof Schema.Unknown>) =>
  Schema.decodeUnknownEffect(PromptResponse)(raw).pipe(
    Effect.mapError(
      (cause) => new AcpError({ message: "invalid ACP session/prompt response", cause }),
    ),
  )

// ── Connection Factory ──

export const makeAcpConnection = (
  proc: {
    readonly stdin: Sink.Sink<void, Uint8Array, never, PlatformError>
    readonly stdout: Stream.Stream<Uint8Array, PlatformError>
  },
  incomingRequestHandler?: IncomingRequestHandler,
) =>
  Effect.gen(function* () {
    const nextIdRef = yield* Ref.make<RequestId>(1)
    const stateRef = yield* Ref.make<ConnState>(
      ConnState.cases.Open.make({
        pending: HashMap.empty<RequestId, PendingRequest>(),
      }),
    )
    const updatesPubSub = yield* PubSub.unbounded<SessionNotification>()
    const writeQueue = yield* TxQueue.unbounded<string>()
    const encoder = new TextEncoder()

    const write = (msg: string) => TxQueue.offer(writeQueue, msg).pipe(Effect.asVoid)

    /**
     * Atomically seal `stateRef` to `closed` and return the pending map
     * for the caller to fail. Only the first caller wins; subsequent
     * calls observe `closed` and get `undefined`. Used by the public
     * `close` and by the writer/reader stdio-error handlers — without
     * this, a stdio failure would leave pending RPC Deferreds parked
     * forever (they resolve only via `handleResponse`, which the dead
     * reader will never run).
     */
    const sealAndClaimPending = Ref.modify(
      stateRef,
      (s): [Option.Option<PendingRequestMap>, ConnState] => {
        if (s._tag === "Closed") return [Option.none(), s]
        return [Option.some(s.pending), ConnState.cases.Closed.make({})]
      },
    )

    const failPendingWith = (reason: string) =>
      Effect.gen(function* () {
        const claimed = yield* sealAndClaimPending
        if (Option.isNone(claimed)) return false
        for (const [, entry] of claimed.value) {
          yield* Deferred.fail(entry.resolve, new AcpClosedError({ reason }))
        }
        yield* PubSub.shutdown(updatesPubSub).pipe(Effect.ignore)
        return true
      })

    // Writer fiber — drains writeQueue to stdin sink. On stdio failure
    // we must seal `stateRef` and fail every pending Deferred; otherwise
    // an `rpc.prompt(...)` call already past the registration point
    // parks forever and the executor's `Stream.interruptWhen(promptDone)`
    // never fires.
    const writerFiber = yield* Stream.fromEffectRepeat(TxQueue.take(writeQueue)).pipe(
      Stream.map((line: string) => encoder.encode(line)),
      Stream.run(proc.stdin),
      Effect.catchEager((err: PlatformError) =>
        Effect.gen(function* () {
          const sealed = yield* failPendingWith(`writer error: ${String(err)}`)
          if (sealed) {
            yield* Effect.logWarning("acp: writer error").pipe(
              Effect.annotateLogs({ error: String(err) }),
            )
          }
        }),
      ),
      Effect.forkScoped,
    )

    // Parse incoming lines
    // Handle a response to one of our pending requests. Atomic
    // claim-and-remove via Ref.modify so a concurrent `close` either
    // sees the entry (and fails it) or this handler sees it — never
    // both, never neither.
    const handleResponse = (parsed: IncomingJsonRpcRecord) =>
      Effect.gen(function* () {
        const rawId = parsed["id"]
        if (!Predicate.isNumber(rawId)) return
        const id = rawId
        const claimed = yield* Ref.modify(
          stateRef,
          (s): [Option.Option<PendingRequest>, ConnState] => {
            if (s._tag === "Closed") return [Option.none(), s]
            const found = HashMap.get(s.pending, id)
            if (found._tag === "None") return [Option.none(), s]
            return [
              Option.some(found.value),
              ConnState.cases.Open.make({
                pending: HashMap.remove(s.pending, id),
              }),
            ]
          },
        )
        if (Option.isNone(claimed)) return

        if ("error" in parsed) {
          const err = parsed["error"]
          let message = "Unknown ACP error"
          if (isRecord(err) && "message" in err) message = String(err["message"])
          yield* Deferred.fail(claimed.value.resolve, new AcpError({ message }))
        } else {
          yield* Deferred.succeed(claimed.value.resolve, parsed["result"])
        }
      })

    // Handle an incoming request from the agent (e.g. permission)
    const handleIncomingRequest = (
      method: string,
      reqId: JsonRpcId,
      params: Schema.Schema.Type<typeof Schema.Unknown>,
    ) =>
      Effect.gen(function* () {
        if (Predicate.isNotUndefined(incomingRequestHandler)) {
          const result = yield* incomingRequestHandler(method, params).pipe(
            Effect.map((value) => {
              if (Predicate.isUndefined(value)) return Option.none()
              return Option.some(value)
            }),
            Effect.catchEager((err: AcpError) =>
              Effect.gen(function* () {
                yield* write(encodeErrorResponse(reqId, -32603, err.message))
                return Option.none()
              }),
            ),
          )
          if (Option.isSome(result)) {
            yield* write(encodeResponse(reqId, result.value))
          }
          return
        }

        // Auto-approve permissions (bare mode agents shouldn't ask, but just in case)
        if (method === "session/request_permission") {
          const req = yield* Schema.decodeUnknownEffect(RequestPermissionRequest)(params).pipe(
            Effect.asSome,
            Effect.catchEager(() => Effect.succeedNone),
          )
          if (Option.isSome(req)) {
            const allowOption = Option.fromNullishOr(
              req.value.options.find((o) => o.kind === "allow_once"),
            )
            let outcome: Schema.Schema.Type<typeof Schema.Unknown>
            if (Option.isSome(allowOption)) {
              outcome = {
                outcome: "selected",
                optionId: allowOption.value.optionId,
              }
            } else {
              outcome = { outcome: "cancelled" }
            }
            yield* write(
              encodeResponse(reqId, {
                outcome,
              }),
            )
          } else {
            yield* write(encodeErrorResponse(reqId, -32602, "Invalid permission request"))
          }
        } else {
          yield* write(encodeErrorResponse(reqId, -32601, `Method not supported: ${method}`))
        }
      })

    // Route a parsed JSON-RPC line
    const handleLine = (line: string) =>
      Effect.gen(function* () {
        if (line.trim() === "") return

        const decoded = decodeIncomingEnvelope(line)
        if (Option.isNone(decoded)) {
          yield* Effect.logWarning("acp: unparseable line").pipe(
            Effect.annotateLogs({ line: line.slice(0, 200) }),
          )
          return
        }
        const parsed = decoded.value

        // Response to one of our requests
        if ("id" in parsed && !Predicate.isNull(parsed["id"]) && !("method" in parsed)) {
          yield* handleResponse(parsed)
          return
        }

        // Notification from agent (no id, has method)
        if ("method" in parsed && !("id" in parsed)) {
          if (parsed["method"] === "session/update") {
            const notification = yield* Schema.decodeUnknownEffect(SessionNotification)(
              parsed["params"],
            ).pipe(
              Effect.asSome,
              Effect.catchEager((decodeErr) =>
                Effect.logWarning("acp: failed to decode session/update").pipe(
                  Effect.annotateLogs({ error: String(decodeErr) }),
                  Effect.as(Option.none()),
                ),
              ),
            )
            if (Option.isSome(notification)) {
              yield* PubSub.publish(updatesPubSub, notification.value)
            }
          }
          return
        }

        // Incoming request from agent (has id + method)
        if ("method" in parsed && "id" in parsed) {
          const rawId = parsed["id"]
          let reqId: JsonRpcId = JSON_NULL
          if (Predicate.isNumber(rawId) || Predicate.isString(rawId)) reqId = rawId
          yield* handleIncomingRequest(String(parsed["method"]), reqId, parsed["params"])
        }
      })

    // Reader fiber — reads stdout line by line. Same hand-off as the
    // writer: a stdio-error must fail pending Deferreds, otherwise a
    // pending RPC parks forever.
    //
    // `Stream.runDrain` also completes naturally when stdout ends (e.g.
    // the agent process exits without an error). Treat that as a
    // closure too — without sealing here, the caller's pending RPC
    // would never see the broken pipe.
    const readerFiber = yield* proc.stdout.pipe(
      Stream.decodeText(),
      splitLines,
      Stream.tap((line) => handleLine(line)),
      Stream.runDrain,
      Effect.catchEager((err: PlatformError) =>
        Effect.gen(function* () {
          const sealed = yield* failPendingWith(`reader error: ${String(err)}`)
          if (sealed) {
            yield* Effect.logWarning("acp: reader error").pipe(
              Effect.annotateLogs({ error: String(err) }),
            )
          }
        }),
      ),
      Effect.tap(() => failPendingWith("stdout closed")),
      Effect.forkScoped,
    )

    // RPC helper — sends request, waits for response.
    //
    // The closed-check and the pending-Deferred registration are folded
    // into a single `Ref.modify` so a concurrent `close` cannot drain
    // the pending map *between* "is open?" and "register pending".
    // Without this fold, a late RPC could write its Deferred into the
    // post-drain map and park forever.
    const rpcRaw = (method: string, params: Schema.Schema.Type<typeof Schema.Unknown>) =>
      Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(nextIdRef, (n) => n + 1)
        const deferred = yield* Deferred.make<unknown, AcpError | AcpClosedError>()
        const registered = yield* Ref.modify(stateRef, (s): [boolean, ConnState] => {
          if (s._tag === "Closed") return [false, s]
          return [
            true,
            ConnState.cases.Open.make({
              pending: HashMap.set(s.pending, id, { resolve: deferred }),
            }),
          ]
        })
        if (!registered) {
          return yield* new AcpClosedError({ reason: "connection closed" })
        }
        yield* write(encodeRequest(id, method, params))
        return yield* Deferred.await(deferred)
      })

    const connection: AcpConnection = {
      initialize: (params) =>
        rpcRaw("initialize", params).pipe(Effect.flatMap(decodeInitializeResponse)),
      newSession: (params) =>
        rpcRaw("session/new", params).pipe(Effect.flatMap(decodeNewSessionResponse)),
      prompt: (params) =>
        rpcRaw("session/prompt", params).pipe(Effect.flatMap(decodePromptResponse)),
      cancel: (sessionId) => write(encodeNotification("session/cancel", { sessionId })),
      updates: Stream.fromPubSub(updatesPubSub),
      // Atomically seal the state and claim the pending map in one
      // Ref.modify so a concurrent rpcRaw cannot leak a Deferred into
      // the post-drain map. Then fail each claimed Deferred with the
      // typed error *before* fiber interrupts so invalidation surfaces
      // as a typed error in the executor, not an interrupt.
      close: (reason = "connection closed") =>
        Effect.gen(function* () {
          yield* failPendingWith(reason)
          yield* Fiber.interrupt(writerFiber)
          yield* Fiber.interrupt(readerFiber)
        }),
    }

    return connection
  })

// ── Stream helper: split text stream into lines ──

const splitLines = <E>(stream: Stream.Stream<string, E>): Stream.Stream<string, E> => {
  let buffer = ""
  return stream.pipe(
    Stream.flatMap((chunk) => {
      buffer += chunk
      const parts = buffer.split("\n")
      buffer = parts.pop() ?? ""
      return Stream.fromIterable(parts.filter((p) => p.length > 0))
    }),
  )
}

// ── turn executor ───────────────────────────────────────────────────────────

/**
 * ACP Turn Executor — maps ACP session events to Effect AI response parts.
 *
 * Implements the TurnExecutor interface from @gent/core. Each turn:
 * 1. Gets/creates an ACP connection + session via the session manager
 * 2. Forks a listener on conn.updates → maps to Response part stream
 * 3. Sends conn.prompt with the last user message
 * 4. Emits "finished" when prompt response returns
 *
 * @module
 */

// ── Session Manager Interface ──

/**
 * Composite cache key for the ACP session manager.
 * Keying on `(driverId, sessionId, branchId)` keeps two branches of the
 * same gent session, and two driver routings of the same branch, from
 * sharing remote state.
 */
interface ExternalSessionKey {
  readonly sessionId: string
  readonly branchId: string
  readonly driverId: string
}

interface AcpManagedSession {
  readonly conn: AcpConnection
  readonly acpSessionId: string
  /**
   * `true` when this call built (or rebuilt) the ACP subprocess + session.
   * The executor uses it to seed the freshly-created remote session with
   * the prior transcript before sending the live user message — without
   * seeding, a fingerprint mismatch / `invalidateDriver` silently drops
   * conversation history.
   */
  readonly created: boolean
}

export interface AcpSessionManager {
  readonly getOrCreate: (
    key: ExternalSessionKey,
    config: AcpProtocolAgentConfig,
    cwd: string,
    systemPrompt: string,
  ) => Effect.Effect<AcpManagedSession, AcpError | AcpClosedError>
  readonly invalidate: (key: ExternalSessionKey) => Effect.Effect<void>
  readonly invalidateDriver: (driverId: string) => Effect.Effect<void>
  readonly disposeAll: Effect.Effect<void>
}

// ── ACP → Response part mapping ──

interface AcpResponsePartMapper {
  readonly toolNamesById: Map<string, string>
}

export const makeAcpResponsePartMapper = (): AcpResponsePartMapper => ({
  toolNamesById: new Map(),
})

const AcpPayload = Schema.Record(Schema.String, Schema.Unknown)
const decodeAcpPayload = Schema.decodeUnknownOption(AcpPayload)
const AcpTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})
const decodeAcpTextContent = Schema.decodeUnknownOption(AcpTextContent)

/** Extract text from an ACP content block. Return None for non-text content. */
const extractTextFromContent = (content: SessionNotification["update"]): Option.Option<string> =>
  decodeAcpTextContent(content).pipe(Option.map((block) => block.text))

/**
 * Extract the tool-result `output` payload from an ACP tool_call_update.
 *
 * ACP wire shape: `content: [{ type: "content", content: { type, ... } }, ...]`.
 * We surface text content as a `string` and other content blocks as their
 * raw structured form. Returns `None` if no recognizable content is
 * present so callers can fall back to `null` in the transcript.
 */
const extractToolResultOutput = (
  obj: typeof AcpPayload.Type,
): Option.Option<SessionNotification["update"]> => {
  const blocks = obj["content"]
  if (!Array.isArray(blocks) || blocks.length === 0) return Option.none()
  const texts: Array<string> = []
  const others: Array<unknown> = []
  for (const block of blocks) {
    const wrapper = decodeAcpPayload(block)
    if (Option.isNone(wrapper)) continue
    const inner = wrapper.value["content"] ?? wrapper.value
    const text = extractTextFromContent(inner)
    if (Option.isSome(text)) {
      texts.push(text.value)
    } else {
      others.push(inner)
    }
  }
  if (texts.length > 0 && others.length === 0) return Option.some(texts.join(""))
  if (texts.length === 0 && others.length === 0) return Option.none()
  if (others.length === 1 && texts.length === 0) return Option.some(others[0])
  return Option.some([...texts.map((text) => ({ type: "text", text })), ...others])
}

const finishPart = (stopReason: StopReason): TurnStreamPart =>
  Response.makePart("finish", {
    reason: toResponseFinishReason(stopReason),
    usage: emptyUsage(),
    // oxlint-disable-next-line effect/noNullish -- the Effect AI response contract requires explicit undefined token counters and metadata
    response: undefined,
  })

const emptyUsage = (): Response.Usage =>
  new Response.Usage({
    inputTokens: {
      // oxlint-disable-next-line effect/noNullish -- the Effect AI response contract requires explicit undefined token counters and metadata
      uncached: undefined,
      // oxlint-disable-next-line effect/noNullish -- the Effect AI response contract requires explicit undefined token counters and metadata
      total: undefined,
      // oxlint-disable-next-line effect/noNullish -- the Effect AI response contract requires explicit undefined token counters and metadata
      cacheRead: undefined,
      // oxlint-disable-next-line effect/noNullish -- the Effect AI response contract requires explicit undefined token counters and metadata
      cacheWrite: undefined,
    },
    outputTokens: {
      // oxlint-disable-next-line effect/noNullish -- the Effect AI response contract requires explicit undefined token counters and metadata
      total: undefined,
      // oxlint-disable-next-line effect/noNullish -- the Effect AI response contract requires explicit undefined token counters and metadata
      text: undefined,
      // oxlint-disable-next-line effect/noNullish -- the Effect AI response contract requires explicit undefined token counters and metadata
      reasoning: undefined,
    },
  })

/** Map a tool_call_update to a response part based on status. */
const mapToolCallUpdate = (
  obj: typeof AcpPayload.Type,
  mapper: AcpResponsePartMapper,
): Option.Option<TurnStreamPart> => {
  const toolCallId = obj["toolCallId"]
  const status = obj["status"]
  if (!Predicate.isString(toolCallId)) return Option.none()
  const toolName = mapper.toolNamesById.get(toolCallId) ?? "external"
  if (status === "completed") {
    const output = Option.getOrNull(extractToolResultOutput(obj))
    return Option.some(
      Response.makePart("tool-result", {
        id: toolCallId,
        name: toolName,
        result: output,
        encodedResult: output,
        isFailure: false,
        providerExecuted: false,
        preliminary: false,
      }),
    )
  }
  if (status === "failed") {
    let error = "tool failed"
    if (Predicate.isString(obj["error"])) error = obj["error"]
    return Option.some(
      Response.makePart("tool-result", {
        id: toolCallId,
        name: toolName,
        result: error,
        encodedResult: { error },
        isFailure: true,
        providerExecuted: false,
        preliminary: false,
      }),
    )
  }
  return Option.none()
}

/** @internal Exported for testing. */
export const mapAcpUpdateToResponsePart = (
  notification: SessionNotification,
  mapper: AcpResponsePartMapper = makeAcpResponsePartMapper(),
): Option.Option<TurnStreamPart> => {
  const decoded = decodeAcpPayload(notification.update)
  if (Option.isNone(decoded)) return Option.none()
  const obj = decoded.value
  const kind = obj["sessionUpdate"]

  switch (kind) {
    case "agent_message_chunk": {
      const text = extractTextFromContent(obj["content"])
      return Option.map(text, (delta) => Response.makePart("text-delta", { id: "acp-text", delta }))
    }
    case "agent_thought_chunk": {
      const text = extractTextFromContent(obj["content"])
      return Option.map(text, (delta) =>
        Response.makePart("reasoning-delta", { id: "acp-reasoning", delta }),
      )
    }
    case "tool_call": {
      const toolCallId = obj["toolCallId"]
      if (!Predicate.isString(toolCallId)) return Option.none()
      let toolName = "unknown"
      if (Predicate.isString(obj["title"])) toolName = obj["title"]
      mapper.toolNamesById.set(toolCallId, toolName)
      return Option.some(
        Response.makePart("tool-call", {
          id: toolCallId,
          name: toolName,
          params: {},
          providerExecuted: false,
        }),
      )
    }
    case "tool_call_update":
      return mapToolCallUpdate(obj, mapper)
    default:
      return Option.none()
  }
}

// ── Turn Executor Factory ──

const makeAcpTurnExecutor = (
  driverId: string,
  config: AcpProtocolAgentConfig,
  manager: AcpSessionManager,
): TurnExecutor => ({
  executeTurn: (ctx: TurnContext) => {
    const runTurn = Effect.gen(function* () {
      // The ACP agent dispatches gent's tools itself over the protocol's
      // native tool surface, so no host-side tool bridge is built here.
      const services = yield* Effect.context<never>()
      const key: ExternalSessionKey = {
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        driverId,
      }
      const session = yield* manager.getOrCreate(key, config, ctx.cwd, ctx.systemPrompt).pipe(
        Effect.mapError((e) => {
          if (Schema.is(AcpClosedError)(e))
            return new TurnError({
              message: `driver invalidated: ${e.reason}`,
              cause: e,
            })
          return new TurnError({ message: e.message })
        }),
      )

      // Signal for when the prompt completes
      const promptDone = yield* Deferred.make<StopReason, TurnError>()

      // Wire abort signal → ACP cancellation
      if (ctx.abortSignal) {
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            Effect.runForkWith(services)(session.conn.cancel(session.acpSessionId))
          },
          { once: true },
        )
      }

      // On a fresh / rebuilt ACP subprocess we send the prior transcript
      // as a single preamble user message before the new turn — the ACP
      // protocol exposes only `prompt` for user input; we cannot inject
      // assistant turns directly. Bare last-user would silently drop
      // history across cache misses / driver swaps.
      const lastUser = findLastUserMessage(ctx.messages)
      let promptText = renderLiveUserPrompt(lastUser)
      if (session.created) promptText = composePromptWithTranscript(ctx.messages, lastUser)

      // Fork the prompt call — runs concurrently with the update stream.
      // On failure, fail the deferred so the stream doesn't hang. An
      // `AcpClosedError` here means the driver was invalidated mid-turn
      // (manager `tearDown`); surface it as a clearly-labelled TurnError
      // so the agent loop reports cleanly instead of an interrupt.
      yield* session.conn
        .prompt({
          sessionId: session.acpSessionId,
          prompt: [{ type: "text", text: promptText }],
        })
        .pipe(
          Effect.tap((result) => Deferred.succeed(promptDone, result.stopReason)),
          Effect.catchEager((e) => {
            if (Schema.is(AcpClosedError)(e))
              return Deferred.fail(
                promptDone,
                new TurnError({
                  message: `driver invalidated: ${e.reason}`,
                  cause: e,
                }),
              )
            let message = String(e)
            if (Schema.is(AcpError)(e)) message = e.message
            return Deferred.fail(promptDone, new TurnError({ message }))
          }),
          Effect.forkScoped,
        )

      const mapper = makeAcpResponsePartMapper()

      // Stream updates until the prompt completes
      const updateStream: Stream.Stream<TurnStreamPart, TurnError> = session.conn.updates.pipe(
        Stream.map((notification) => mapAcpUpdateToResponsePart(notification, mapper)),
        Stream.filter(Option.isSome),
        Stream.map((part) => part.value),
        Stream.interruptWhen(Deferred.await(promptDone)),
        Stream.mapError((e) => {
          if (Schema.is(AcpError)(e)) return new TurnError({ message: e.message })
          return new TurnError({ message: String(e) })
        }),
      )

      // After updates drain, emit the terminal finish part.
      const finishedStream: Stream.Stream<TurnStreamPart, TurnError | InteractionPendingError> =
        Stream.fromEffect(Deferred.await(promptDone).pipe(Effect.map(finishPart)))

      return Stream.concat(updateStream, finishedStream)
    }).pipe(
      Effect.mapError((e) => {
        if (Schema.is(TurnError)(e) || Schema.is(InteractionPendingError)(e)) return e
        return new TurnError({ message: String(e) })
      }),
    )

    return Stream.unwrap(runTurn)
  },
})

// ── session manager ─────────────────────────────────────────────────────────

/**
 * ACP Session Manager — subprocess lifecycle + session caching for
 * ACP-protocol agents (opencode / gemini-cli). Claude Code lives on the
 * SDK path; see `claude-code-executor.ts`.
 *
 * One ACP subprocess per (driverId, gentSessionId, branchId), reused
 * across turns. Branch + driver are part of the key because two
 * branches of the same gent session run logically separate
 * conversations and a driver swap mid-session must not reuse the prior
 * driver's subprocess.
 *
 * Lifecycle: spawn → initialize → newSession (with
 * `_meta.systemPrompt`) → cache → reuse.
 *
 * @module
 */
// `ChildProcessSpawner` re-exported from `effect/unstable/process` is a
// namespace — for the runtime tag value we need the deep module path.

const ACP_KILL_GRACE_MS = 5_000

interface AcpProcess {
  readonly conn: AcpConnection
  readonly acpSessionId: string
  readonly killProc: Effect.Effect<void>
  readonly scope: Scope.Closeable
  readonly procScope: Scope.Closeable
  readonly fingerprint: string
}

const cacheKey = (k: ExternalSessionKey): string => `${k.driverId}::${k.sessionId}::${k.branchId}`

const Fingerprint = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  systemPrompt: Schema.String,
})
const encodeFingerprint = Schema.encodeSync(Schema.fromJsonString(Fingerprint))

/**
 * Fingerprint covers every session-defining input passed to ACP
 * `newSession` plus the spawn config. Stale-cache hits otherwise let
 * a runtime driver override or extension change silently keep serving
 * the wrong cwd / prompt / tool surface.
 */
const fingerprintSession = (
  config: AcpProtocolAgentConfig,
  cwd: string,
  systemPrompt: string,
): string =>
  encodeFingerprint({
    command: config.command,
    args: config.args,
    cwd,
    systemPrompt,
  })

/**
 * Yield `ChildProcessSpawner` once at construction and capture it as a
 * one-tag context. Per-turn `getOrCreate` then provides the captured
 * spawner to its inner spawn calls so its public Effect has no service
 * requirement. `TurnExecutor.executeTurn` returns a Stream with no
 * context channel, so pinning the spawner here keeps that contract
 * honest without re-providing `BunServices.layer` per turn.
 */
const createAcpSessionManager: Effect.Effect<AcpSessionManager, never, ChildProcessSpawner> =
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const spawnerContext = Context.make(ChildProcessSpawner, spawner)
    const sessionsRef = yield* TxRef.make(HashMap.empty<string, AcpProcess>())
    const byDriverRef = yield* TxRef.make(HashMap.empty<string, HashSet.HashSet<string>>())

    const removeFromDriverIndex = (driverId: string, k: string) =>
      TxRef.update(byDriverRef, (current) => {
        const found = HashMap.get(current, driverId)
        if (found._tag === "None") return current
        const next = HashSet.remove(found.value, k)
        if (HashSet.size(next) === 0) return HashMap.remove(current, driverId)
        return HashMap.set(current, driverId, next)
      })

    // Close all resources owned by an entry. State refs are NOT touched here
    // so callers can compose the corresponding sessions/driver-index updates
    // inside one Effect.tx transaction.
    const closeEntry = (entry: AcpProcess): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* entry.conn.close("driver invalidated").pipe(Effect.ignore)
        yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore)
        yield* entry.killProc
        yield* Scope.close(entry.procScope, Exit.void).pipe(Effect.ignore)
      })

    const tearDown = (k: string, entry: AcpProcess): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* closeEntry(entry)
        yield* TxRef.update(sessionsRef, (current) => HashMap.remove(current, k))
      })

    const getOrCreate = (
      key: ExternalSessionKey,
      config: AcpProtocolAgentConfig,
      cwd: string,
      systemPrompt: string,
    ): Effect.Effect<AcpManagedSession, AcpError | AcpClosedError> =>
      Effect.gen(function* () {
        const k = cacheKey(key)
        const fingerprint = fingerprintSession(config, cwd, systemPrompt)
        const existingOpt = HashMap.get(yield* TxRef.get(sessionsRef), k)
        if (existingOpt._tag === "Some") {
          const existing = existingOpt.value
          if (existing.fingerprint === fingerprint) {
            return {
              conn: existing.conn,
              acpSessionId: existing.acpSessionId,
              created: false,
            }
          }
          // Atomic eviction: drop from both refs in one transaction so a
          // concurrent invalidateDriver cannot see the entry without the
          // driver-index membership. Resource closes happen outside the tx
          // because side effects on Scope cannot participate in STM retry.
          yield* closeEntry(existing).pipe(Effect.ignore)
          yield* Effect.tx(
            Effect.gen(function* () {
              yield* removeFromDriverIndex(key.driverId, k)
              yield* TxRef.update(sessionsRef, (current) => HashMap.remove(current, k))
            }),
          )
        }

        // The process lives in `procScope` so the parent scope is not bound to
        // a long-lived child; the process survives across turns and is
        // explicitly killed on tearDown.
        const procScope = yield* Scope.make()
        const handle = yield* ChildProcess.make(config.command, [...config.args], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
        }).pipe(
          Scope.provide(procScope),
          Effect.catchTag("PlatformError", (e) =>
            Effect.fail(
              new AcpError({
                message: `failed to spawn ACP agent: ${e.message}`,
              }),
            ),
          ),
          Effect.tapError(() => Scope.close(procScope, Exit.void)),
        )

        const killProc = handle
          .kill({
            killSignal: "SIGTERM",
            forceKillAfter: Duration.millis(ACP_KILL_GRACE_MS),
          })
          .pipe(Effect.ignore)

        const scope = yield* Scope.make()

        const cleanup = Effect.gen(function* () {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
          yield* killProc
          yield* Scope.close(procScope, Exit.void).pipe(Effect.ignore)
        })

        const conn = yield* makeAcpConnection({
          stdin: handle.stdin,
          stdout: handle.stdout,
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.tapError(() => cleanup),
        )

        yield* conn
          .initialize({
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "gent", version: "0.0.0" },
          })
          .pipe(Effect.tapError(() => cleanup))

        // Create session with cwd and system prompt via ACP's `_meta` channel.
        // The wire format is open per agent — the claude-agent-acp reference
        // impl recognises `_meta.systemPrompt` (string = replace, `{append}`
        // = append). Agents that don't recognise it ignore the field.
        const sessionResponse = yield* conn
          .newSession({
            cwd,
            mcpServers: [],
            _meta: { systemPrompt },
          })
          .pipe(Effect.tapError(() => cleanup))

        const entry: AcpProcess = {
          conn,
          acpSessionId: sessionResponse.sessionId,
          killProc,
          scope,
          procScope,
          fingerprint,
        }
        // Install entry + driver-index update inside a single transaction so
        // a concurrent invalidateDriver cannot observe one ref's mutation
        // without the other's. Without Effect.tx the two TxRef.update calls
        // would commit independently, allowing a yield between them.
        yield* Effect.tx(
          Effect.gen(function* () {
            yield* TxRef.update(sessionsRef, (current) => HashMap.set(current, k, entry))
            yield* TxRef.update(byDriverRef, (current) => {
              const existing = HashMap.get(current, key.driverId)
              let set = HashSet.make(k)
              if (existing._tag === "Some") set = HashSet.add(existing.value, k)
              return HashMap.set(current, key.driverId, set)
            })
          }),
        )

        return { conn, acpSessionId: sessionResponse.sessionId, created: true }
      }).pipe(Effect.provide(spawnerContext))

    const invalidate = (key: ExternalSessionKey): Effect.Effect<void> =>
      Effect.gen(function* () {
        const k = cacheKey(key)
        const entryOpt = HashMap.get(yield* TxRef.get(sessionsRef), k)
        if (entryOpt._tag === "None") return
        yield* closeEntry(entryOpt.value)
        yield* Effect.tx(
          Effect.gen(function* () {
            yield* removeFromDriverIndex(key.driverId, k)
            yield* TxRef.update(sessionsRef, (current) => HashMap.remove(current, k))
          }),
        )
      })

    const invalidateDriver = (driverId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const driverKeys = yield* TxRef.modify(byDriverRef, (current) => {
          const found = HashMap.get(current, driverId)
          if (found._tag === "None") return [HashSet.empty<string>(), current]
          return [found.value, HashMap.remove(current, driverId)]
        })
        const keysArr = Array.from(driverKeys)
        const snapshot = yield* TxRef.get(sessionsRef)
        // Tear down in parallel — each kill may wait up to ACP_KILL_GRACE_MS
        // for forceKillAfter, so N stuck processes serialize to N × grace.
        yield* Effect.forEach(
          keysArr,
          (k) => {
            const entry = HashMap.get(snapshot, k)
            if (entry._tag === "None") return Effect.void
            return tearDown(k, entry.value).pipe(Effect.ignore)
          },
          { concurrency: 16, discard: true },
        )
      })

    const disposeAll: Effect.Effect<void> = Effect.gen(function* () {
      // Same parallelism rationale as invalidateDriver — server shutdown
      // shouldn't be N × ACP_KILL_GRACE_MS.
      const snapshot = yield* TxRef.get(sessionsRef)
      const entries = Array.from(HashMap.entries(snapshot))
      yield* Effect.forEach(entries, ([k, entry]) => tearDown(k, entry).pipe(Effect.ignore), {
        concurrency: 16,
        discard: true,
      })
      yield* TxRef.set(byDriverRef, HashMap.empty<string, HashSet.HashSet<string>>())
    })

    return { getOrCreate, invalidate, invalidateDriver, disposeAll }
  })

// ── extension ───────────────────────────────────────────────────────────────

/**
 * ACP Agents Extension — external coding agents (opencode, gemini-cli) as
 * first-class gent agents via the ExternalDriver primitive.
 *
 * Each agent is a subprocess spoken to over ACP JSON-RPC on stdio
 * (the wire schema and protocol sections above); `AcpSessionManager` owns one subprocess
 * per gent session and is captured by both the contributed drivers and the
 * process-scoped Resource that disposes them.
 *
 * This is the adapter at core's `externalDriver` seam — the second
 * implementation of `TurnExecutor`, alongside the model drivers. Agents
 * dispatch gent's tools over ACP's own tool surface, so no host-side tool
 * bridge is built here.
 *
 * @module
 */

/**
 * Anchors the disposer Resource's layer to a concrete service type.
 * `Layer.empty: Layer<never>` is not assignable to the heterogeneous
 * bucket type under contravariant `ROut`; naming `A` keeps the leaf
 * structural so `defineResource(...)` flows straight into `register`.
 */
class AcpAgentsDisposer extends Context.Service<
  AcpAgentsDisposer,
  { readonly _tag: "AcpAgentsDisposer" }
>()("@gent/extensions/src/acp-agents/AcpAgentsDisposer") {}

/**
 * Process-scoped finalizer for the manager's subprocesses.
 *
 * Subprocesses outlive a turn and a branch, so this is process-scoped:
 * without it a stale `opencode` child survives the runtime that spawned
 * it. The release step is exported separately so a test can assert it.
 */
const acpDisposerResource = (manager: AcpSessionManager) =>
  defineResource({
    id: "@gent/acp-agents/disposer",
    scope: "process",
    layer: Layer.effect(
      AcpAgentsDisposer,
      Effect.acquireRelease(
        Effect.succeed(AcpAgentsDisposer.of({ _tag: "AcpAgentsDisposer" })),
        () => acpDisposerRelease(manager),
      ),
    ),
  })

/**
 * The disposer's release step. Named so a test can assert it: the
 * resource's own layer carries the process `ServerScope` brand, which
 * only the runtime can supply.
 */
export const acpDisposerRelease = (manager: AcpSessionManager): Effect.Effect<void> =>
  manager.disposeAll

export const makeAcpAgentsExtension = (
  deps: { readonly makeAcpSessionManager?: typeof createAcpSessionManager } = {},
): GentExtension<ChildProcessSpawner | ExtensionHost> =>
  defineExtension({
    id: "@gent/acp-agents",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      const manager = yield* deps.makeAcpSessionManager ?? createAcpSessionManager

      for (const [name, config] of Object.entries(ACP_PROTOCOL_AGENTS)) {
        const id = `acp-${name}`
        yield* host.register(
          "agent",
          AgentDefinition.make({
            name: AgentName.make(name),
            description: `${config.command} via ACP`,
            driver: ExternalDriverRef.make({ id }),
          }),
        )
        yield* host.register("externalDriver", {
          id,
          executor: makeAcpTurnExecutor(id, config, manager),
          invalidate: manager.invalidateDriver(id),
        })
      }

      yield* host.register("resource", acpDisposerResource(manager))
    }),
  })

export const AcpAgentsExtension: GentExtension<ChildProcessSpawner | ExtensionHost> =
  makeAcpAgentsExtension()
