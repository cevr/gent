/**
 * ACP Turn Executor — maps ACP session events to gent TurnEvents.
 *
 * Implements the TurnExecutor interface from @gent/core. Each turn:
 * 1. Gets/creates an ACP connection + session via the session manager
 * 2. Forks a listener on conn.updates → maps to TurnEvent stream
 * 3. Sends conn.prompt with the last user message
 * 4. Emits "finished" when prompt response returns
 *
 * @module
 */
import { Deferred, Effect, Stream } from "effect"
import {
  ReasoningDelta,
  TextDelta,
  ToolCompleted,
  TurnError,
  ToolFailed,
  ToolStarted,
  TurnFinished,
  type TurnContext,
  type TurnEvent,
  type TurnExecutor,
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

// ── ACP → TurnEvent mapping ──

/** Extract text from an ACP content block. Returns undefined for non-text content. */
const extractTextFromContent = (content: unknown): string | undefined => {
  if (typeof content !== "object" || content === null) return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
  const c = content as Record<string, unknown>
  return c["type"] === "text" && typeof c["text"] === "string" ? c["text"] : undefined
}

/** Map a tool_call_update to a TurnEvent based on status. */
const mapToolCallUpdate = (obj: Record<string, unknown>): TurnEvent | undefined => {
  const toolCallId = typeof obj["toolCallId"] === "string" ? obj["toolCallId"] : undefined
  const status = typeof obj["status"] === "string" ? obj["status"] : undefined
  if (toolCallId === undefined) return undefined
  if (status === "completed") return ToolCompleted.make({ toolCallId })
  if (status === "failed") {
    return ToolFailed.make({
      toolCallId,
      error: typeof obj["error"] === "string" ? obj["error"] : "tool failed",
    })
  }
  return undefined
}

/** @internal Exported for testing. */
export const mapAcpUpdateToTurnEvent = (
  notification: SessionNotification,
): TurnEvent | undefined => {
  const update = notification.update
  if (typeof update !== "object" || update === null) return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
  const obj = update as Record<string, unknown>
  const kind = obj["sessionUpdate"]

  switch (kind) {
    case "agent_message_chunk": {
      const text = extractTextFromContent(obj["content"])
      return text !== undefined ? TextDelta.make({ text }) : undefined
    }
    case "agent_thought_chunk": {
      const text = extractTextFromContent(obj["content"])
      return text !== undefined ? ReasoningDelta.make({ text }) : undefined
    }
    case "tool_call": {
      const toolCallId = typeof obj["toolCallId"] === "string" ? obj["toolCallId"] : undefined
      if (toolCallId === undefined) return undefined
      return ToolStarted.make({
        toolCallId,
        toolName: typeof obj["title"] === "string" ? obj["title"] : "unknown",
      })
    }
    case "tool_call_update":
      return mapToolCallUpdate(obj)
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
  executeTurn: (ctx: TurnContext) => {
    const runTurn = Effect.gen(function* () {
      // SDK boundary: the codemode JS sandbox invokes `runTool` as a
      // Promise-returning function. Adapter built in
      // `executor-boundary.ts` — the only Effect crossing the SDK edge
      // is `toolRunner.run(...)`, pinned by `makeAcpRunTool`. No generic
      // Effect-runner is exposed.
      const services = yield* Effect.context<never>()
      const runTool: CodemodeConfig["runTool"] = makeAcpRunTool({
        services,
        hostCtx: ctx.hostCtx,
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
            e instanceof AcpClosedError
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
            Effect.runFork(session.conn.cancel(session.acpSessionId))
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
              e instanceof AcpClosedError
                ? new TurnError({ message: `driver invalidated: ${e.reason}`, cause: e })
                : new TurnError({ message: e instanceof AcpError ? e.message : String(e) }),
            ),
          ),
          Effect.forkScoped,
        )

      // Stream updates until the prompt completes
      const updateStream: Stream.Stream<TurnEvent, TurnError> = session.conn.updates.pipe(
        Stream.map(mapAcpUpdateToTurnEvent),
        Stream.filter((e): e is TurnEvent => e !== undefined),
        Stream.interruptWhen(Deferred.await(promptDone)),
        Stream.mapError((e) =>
          e instanceof AcpError
            ? new TurnError({ message: e.message })
            : new TurnError({ message: String(e) }),
        ),
      )

      // After updates drain, emit the finished event
      const finishedStream: Stream.Stream<TurnEvent, TurnError> = Stream.fromEffect(
        Deferred.await(promptDone).pipe(
          Effect.map((stopReason): TurnEvent => TurnFinished.make({ stopReason })),
        ),
      )

      return Stream.concat(updateStream, finishedStream)
    }).pipe(
      Effect.mapError((e) => (e instanceof TurnError ? e : new TurnError({ message: String(e) }))),
    )

    return Stream.unwrap(runTurn)
  },
})
