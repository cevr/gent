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
import { Predicate, Deferred, Effect, Option, Ref, Schema, Stream } from "effect"
import * as Response from "effect/unstable/ai/Response"
import {
  ExternalToolRunner,
  InteractionPendingError,
  TurnError,
  type TurnContext,
  type TurnExecutor,
  type TurnStreamPart,
} from "@gent/core/extensions/api"
import type { AcpProtocolAgentConfig } from "./config.js"
import type { AcpConnection } from "./protocol.js"
import { AcpClosedError, AcpError } from "./protocol.js"
import type { SessionNotification } from "./schema.js"
import type { CodemodeConfig } from "./mcp-codemode.js"
import { makeAcpInteractionPendingNotifier, makeAcpRunTool } from "./executor-boundary.js"
import {
  composePromptWithTranscript,
  findLastUserMessage,
  renderLiveUserPrompt,
} from "./transcript.js"
import { toResponseFinishReason } from "./response-finish.js"

// ── Session Manager Interface (Batch 3 provides implementation) ──

/**
 * Composite cache key shared by the SDK and ACP-protocol managers.
 * Keying on `(driverId, sessionId, branchId)` keeps two branches of the
 * same gent session, and two driver routings of the same branch, from
 * sharing remote state.
 */
export interface ExternalSessionKey {
  readonly sessionId: string
  readonly branchId: string
  readonly driverId: string
}

export interface AcpManagedSession {
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
    codemodeConfig?: CodemodeConfig,
  ) => Effect.Effect<AcpManagedSession, AcpError | AcpClosedError>
  readonly invalidate: (key: ExternalSessionKey) => Effect.Effect<void>
  readonly invalidateDriver: (driverId: string) => Effect.Effect<void>
  readonly disposeAll: Effect.Effect<void>
}

// ── ACP → Response part mapping ──

export interface AcpResponsePartMapper {
  readonly toolNamesById: Map<string, string>
}

export const makeAcpResponsePartMapper = (): AcpResponsePartMapper => ({
  toolNamesById: new Map(),
})

const AcpPayload = Schema.Record(Schema.String, Schema.Unknown)
const decodeAcpPayload = Schema.decodeUnknownOption(AcpPayload)
const AcpTextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
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

// The Effect AI response contract requires explicit undefined token counters and metadata.
/* oxlint-disable effect/noNullish */
const finishPart = (stopReason: string): TurnStreamPart =>
  Response.makePart("finish", {
    reason: toResponseFinishReason(stopReason),
    usage: emptyUsage(),
    response: undefined,
  })

const emptyUsage = (): Response.Usage =>
  new Response.Usage({
    inputTokens: {
      uncached: undefined,
      total: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: undefined,
      text: undefined,
      reasoning: undefined,
    },
  })

/* oxlint-enable effect/noNullish */
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

export const makeAcpTurnExecutor = (
  driverId: string,
  config: AcpProtocolAgentConfig,
  manager: AcpSessionManager,
): TurnExecutor => ({
  executeTurn: (ctx: TurnContext) => {
    const runTurn = Effect.gen(function* () {
      // SDK boundary: the codemode JS sandbox invokes `runTool` as a
      // Promise-returning function. Adapter built in `executor-boundary.ts`;
      // core owns actual tool execution through ExternalToolRunner.
      const services = yield* Effect.context<never>()
      const toolRunner = yield* ExternalToolRunner
      const pendingInteraction = yield* Ref.make(Option.none<InteractionPendingError>())
      const runTool: CodemodeConfig["runTool"] = makeAcpRunTool({
        runTool: toolRunner.runTool,
      })

      const codemodeConfig: CodemodeConfig = {
        tools: ctx.tools,
        runTool,
        onInteractionPending: makeAcpInteractionPendingNotifier({
          services,
          notify: (pending) => Ref.set(pendingInteraction, Option.some(pending)),
        }),
      }

      const key: ExternalSessionKey = {
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        driverId,
      }
      const session = yield* manager
        .getOrCreate(key, config, ctx.cwd, ctx.systemPrompt, codemodeConfig)
        .pipe(
          Effect.mapError((e) => {
            if (Schema.is(AcpClosedError)(e))
              return new TurnError({ message: `driver invalidated: ${e.reason}`, cause: e })
            return new TurnError({ message: e.message })
          }),
        )

      // Signal for when the prompt completes
      const promptDone = yield* Deferred.make<string, TurnError>()

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
                new TurnError({ message: `driver invalidated: ${e.reason}`, cause: e }),
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
        Stream.fromEffect(
          Deferred.await(promptDone).pipe(
            Effect.flatMap((stopReason) =>
              Ref.get(pendingInteraction).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.succeed(finishPart(stopReason)),
                    onSome: Effect.fail,
                  }),
                ),
              ),
            ),
          ),
        )

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
