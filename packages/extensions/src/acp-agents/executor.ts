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
import { Deferred, Effect, Schema, Stream } from "effect"
import * as Response from "effect/unstable/ai/Response"
import {
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
import { makeAcpRunTool } from "./executor-boundary.js"
import {
  composePromptWithTranscript,
  findLastUserMessage,
  renderLiveUserPrompt,
} from "./transcript.js"

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
  readonly disposeAll: () => Effect.Effect<void>
}

// ── ACP → Response part mapping ──

export interface AcpResponsePartMapper {
  readonly toolNamesById: Map<string, string>
}

export const makeAcpResponsePartMapper = (): AcpResponsePartMapper => ({
  toolNamesById: new Map(),
})

/** Extract text from an ACP content block. Returns undefined for non-text content. */
const extractTextFromContent = (content: unknown): string | undefined => {
  if (typeof content !== "object" || content === null) return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
  const c = content as Record<string, unknown>
  return c["type"] === "text" && typeof c["text"] === "string" ? c["text"] : undefined
}

/**
 * Extract the tool-result `output` payload from an ACP tool_call_update.
 *
 * ACP wire shape: `content: [{ type: "content", content: { type, ... } }, ...]`.
 * We surface text content as a `string` and other content blocks as their
 * raw structured form. Returns `undefined` if no recognizable content is
 * present so callers can fall back to `null` in the transcript.
 */
const extractToolResultOutput = (obj: Record<string, unknown>): unknown => {
  const blocks = obj["content"]
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined
  const texts: Array<string> = []
  const others: Array<unknown> = []
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
    const wrapper = block as Record<string, unknown>
    const inner = wrapper["content"] ?? wrapper
    const text = extractTextFromContent(inner)
    if (text !== undefined) {
      texts.push(text)
    } else {
      others.push(inner)
    }
  }
  if (texts.length > 0 && others.length === 0) return texts.join("")
  if (texts.length === 0 && others.length === 0) return undefined
  if (others.length === 1 && texts.length === 0) return others[0]
  return [...texts.map((text) => ({ type: "text", text })), ...others]
}

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

const toResponseFinishReason = (stopReason: string): Response.FinishReason => {
  switch (stopReason) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
    case "pause":
    case "other":
    case "unknown":
      return stopReason
    default:
      return "unknown"
  }
}

/** Map a tool_call_update to a response part based on status. */
const mapToolCallUpdate = (
  obj: Record<string, unknown>,
  mapper: AcpResponsePartMapper,
): TurnStreamPart | undefined => {
  const toolCallId = typeof obj["toolCallId"] === "string" ? obj["toolCallId"] : undefined
  const status = typeof obj["status"] === "string" ? obj["status"] : undefined
  if (toolCallId === undefined) return undefined
  const toolName = mapper.toolNamesById.get(toolCallId) ?? "external"
  if (status === "completed") {
    const output = extractToolResultOutput(obj) ?? null
    return Response.makePart("tool-result", {
      id: toolCallId,
      name: toolName,
      result: output,
      encodedResult: output,
      isFailure: false,
      providerExecuted: false,
      preliminary: false,
    })
  }
  if (status === "failed") {
    const error = typeof obj["error"] === "string" ? obj["error"] : "tool failed"
    return Response.makePart("tool-result", {
      id: toolCallId,
      name: toolName,
      result: error,
      encodedResult: { error },
      isFailure: true,
      providerExecuted: false,
      preliminary: false,
    })
  }
  return undefined
}

/** @internal Exported for testing. */
export const mapAcpUpdateToResponsePart = (
  notification: SessionNotification,
  mapper: AcpResponsePartMapper = makeAcpResponsePartMapper(),
): TurnStreamPart | undefined => {
  const update = notification.update
  if (typeof update !== "object" || update === null) return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
  const obj = update as Record<string, unknown>
  const kind = obj["sessionUpdate"]

  switch (kind) {
    case "agent_message_chunk": {
      const text = extractTextFromContent(obj["content"])
      return text !== undefined
        ? Response.makePart("text-delta", { id: "acp-text", delta: text })
        : undefined
    }
    case "agent_thought_chunk": {
      const text = extractTextFromContent(obj["content"])
      return text !== undefined
        ? Response.makePart("reasoning-delta", { id: "acp-reasoning", delta: text })
        : undefined
    }
    case "tool_call": {
      const toolCallId = typeof obj["toolCallId"] === "string" ? obj["toolCallId"] : undefined
      if (toolCallId === undefined) return undefined
      const toolName = typeof obj["title"] === "string" ? obj["title"] : "unknown"
      mapper.toolNamesById.set(toolCallId, toolName)
      return Response.makePart("tool-call", {
        id: toolCallId,
        name: toolName,
        params: {},
        providerExecuted: false,
      })
    }
    case "tool_call_update":
      return mapToolCallUpdate(obj, mapper)
    default:
      return undefined
  }
}

// ── Turn Executor Factory ──

export const makeAcpTurnExecutor = (
  driverId: string,
  config: AcpProtocolAgentConfig,
  manager: AcpSessionManager,
): TurnExecutor => ({
  executeTurn: <RunToolContext>(ctx: TurnContext<RunToolContext>) => {
    const runTurn = Effect.gen(function* () {
      // SDK boundary: the codemode JS sandbox invokes `runTool` as a
      // Promise-returning function. Adapter built in `executor-boundary.ts`;
      // core owns actual tool execution through `ctx.runTool`.
      const services = yield* Effect.context<RunToolContext>()
      const runTool: CodemodeConfig["runTool"] = makeAcpRunTool({
        services,
        runTool: ctx.runTool,
      })

      const codemodeConfig: CodemodeConfig = {
        tools: ctx.tools,
        runTool,
      }

      const key: ExternalSessionKey = {
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        driverId,
      }
      const session = yield* manager
        .getOrCreate(key, config, ctx.cwd, ctx.systemPrompt, codemodeConfig)
        .pipe(
          Effect.mapError((e) =>
            Schema.is(AcpClosedError)(e)
              ? new TurnError({ message: `driver invalidated: ${e.reason}`, cause: e })
              : new TurnError({ message: e.message }),
          ),
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
      const promptText = session.created
        ? composePromptWithTranscript(ctx.messages, lastUser)
        : renderLiveUserPrompt(lastUser)

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
          Effect.catchEager((e) =>
            Deferred.fail(
              promptDone,
              Schema.is(AcpClosedError)(e)
                ? new TurnError({ message: `driver invalidated: ${e.reason}`, cause: e })
                : new TurnError({
                    message: Schema.is(AcpError)(e) ? e.message : String(e),
                  }),
            ),
          ),
          Effect.forkScoped,
        )

      const mapper = makeAcpResponsePartMapper()

      // Stream updates until the prompt completes
      const updateStream: Stream.Stream<TurnStreamPart, TurnError> = session.conn.updates.pipe(
        Stream.map((notification) => mapAcpUpdateToResponsePart(notification, mapper)),
        Stream.filter((part): part is TurnStreamPart => part !== undefined),
        Stream.interruptWhen(Deferred.await(promptDone)),
        Stream.mapError((e) =>
          Schema.is(AcpError)(e)
            ? new TurnError({ message: e.message })
            : new TurnError({ message: String(e) }),
        ),
      )

      // After updates drain, emit the terminal finish part.
      const finishedStream: Stream.Stream<TurnStreamPart, TurnError> = Stream.fromEffect(
        Deferred.await(promptDone).pipe(
          Effect.map((stopReason): TurnStreamPart => finishPart(stopReason)),
        ),
      )

      return Stream.concat(updateStream, finishedStream)
    }).pipe(
      Effect.mapError((e) => (Schema.is(TurnError)(e) ? e : new TurnError({ message: String(e) }))),
    )

    return Stream.unwrap(runTurn)
  },
})
