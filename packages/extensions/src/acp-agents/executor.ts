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
  TurnError,
  ToolCallId,
  ToolRunner,
  type TurnContext,
  type TurnEvent,
  type TurnExecutor,
} from "@gent/core/extensions/api"
import type { AcpAgentConfig } from "./config.js"
import type { AcpConnection } from "./protocol.js"
import { AcpError } from "./protocol.js"
import type { SessionNotification } from "./schema.js"
import type { CodemodeConfig } from "./mcp-codemode.js"

// ── Session Manager Interface (Batch 3 provides implementation) ──

export interface AcpManagedSession {
  readonly conn: AcpConnection
  readonly acpSessionId: string
}

export interface AcpSessionManager {
  readonly getOrCreate: (
    gentSessionId: string,
    config: AcpAgentConfig,
    cwd: string,
    codemodeConfig?: CodemodeConfig,
  ) => Effect.Effect<AcpManagedSession, AcpError>
  readonly get: (gentSessionId: string) => AcpManagedSession | undefined
  readonly disposeAll: () => Effect.Effect<void>
}

// ── ACP → TurnEvent mapping ──

/** Extract text from an ACP content block. Returns undefined for non-text content. */
const extractTextFromContent = (content: unknown): string | undefined => {
  if (typeof content !== "object" || content === null) return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const c = content as Record<string, unknown>
  return c["type"] === "text" && typeof c["text"] === "string" ? c["text"] : undefined
}

/** Map a tool_call_update to a TurnEvent based on status. */
const mapToolCallUpdate = (obj: Record<string, unknown>): TurnEvent | undefined => {
  const toolCallId = typeof obj["toolCallId"] === "string" ? obj["toolCallId"] : undefined
  const status = typeof obj["status"] === "string" ? obj["status"] : undefined
  if (toolCallId === undefined) return undefined
  if (status === "completed") return { _tag: "tool-completed", toolCallId }
  if (status === "failed") {
    return {
      _tag: "tool-failed",
      toolCallId,
      error: typeof obj["error"] === "string" ? obj["error"] : "tool failed",
    }
  }
  return undefined
}

const mapAcpUpdateToTurnEvent = (notification: SessionNotification): TurnEvent | undefined => {
  const update = notification.update
  if (typeof update !== "object" || update === null) return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const obj = update as Record<string, unknown>
  const kind = obj["sessionUpdate"]

  switch (kind) {
    case "agent_message_chunk": {
      const text = extractTextFromContent(obj["content"])
      return text !== undefined ? { _tag: "text-delta", text } : undefined
    }
    case "agent_thought_chunk": {
      const text = extractTextFromContent(obj["content"])
      return text !== undefined ? { _tag: "reasoning-delta", text } : undefined
    }
    case "tool_call": {
      const toolCallId = typeof obj["toolCallId"] === "string" ? obj["toolCallId"] : undefined
      if (toolCallId === undefined) return undefined
      return {
        _tag: "tool-started",
        toolCallId,
        toolName: typeof obj["title"] === "string" ? obj["title"] : "unknown",
      }
    }
    case "tool_call_update":
      return mapToolCallUpdate(obj)
    default:
      return undefined
  }
}

/** Extract text from the last user message in the conversation. */
const extractLastUserMessage = (
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<{ type: string; text?: string }> }>,
): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg === undefined || msg.role !== "user") continue
    for (const part of msg.parts) {
      if (part.type === "text" && part.text !== undefined) return part.text
    }
  }
  return ""
}

// ── Turn Executor Factory ──

export const makeAcpTurnExecutor = (
  config: AcpAgentConfig,
  manager: AcpSessionManager,
): TurnExecutor => ({
  executeTurn: (ctx: TurnContext) => {
    const runTurn = Effect.gen(function* () {
      // Capture the Effect context so the codemode proxy can dispatch tool
      // calls through ToolRunner.run() from Promise-land. The captured context
      // includes ToolRunner and all its dependencies — each runTool call creates
      // an Effect that yields ToolRunner and runs the tool, executed via
      // runPromiseWith with the full context.
      const services = yield* Effect.context<never>()
      const baseRun = Effect.runPromiseWith(services)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
      const run = baseRun as (e: Effect.Effect<any, any, any>) => Promise<any>

      const runTool: CodemodeConfig["runTool"] = (toolName, args) => {
        const toolCallId = ToolCallId.of(crypto.randomUUID())
        const toolCtx = { ...ctx.hostCtx, toolCallId }
        return run(
          Effect.gen(function* () {
            const toolRunner = yield* ToolRunner
            return yield* toolRunner.run({ toolCallId, toolName, input: args }, toolCtx)
          }),
        )
      }

      const codemodeConfig: CodemodeConfig = {
        tools: ctx.tools,
        runTool,
      }

      const session = yield* manager
        .getOrCreate(ctx.sessionId, config, ctx.cwd, codemodeConfig)
        .pipe(Effect.mapError((e) => new TurnError({ message: e.message })))

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

      // Fork the prompt call — runs concurrently with the update stream.
      // On failure, fail the deferred so the stream doesn't hang.
      yield* session.conn
        .prompt({
          sessionId: session.acpSessionId,
          prompt: [{ type: "text", text: extractLastUserMessage(ctx.messages) }],
        })
        .pipe(
          Effect.tap((result) => Deferred.succeed(promptDone, result.stopReason)),
          Effect.catchEager((e) =>
            Deferred.fail(
              promptDone,
              new TurnError({ message: e instanceof AcpError ? e.message : String(e) }),
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
          Effect.map(
            (stopReason): TurnEvent => ({
              _tag: "finished",
              stopReason,
            }),
          ),
        ),
      )

      return Stream.concat(updateStream, finishedStream)
    }).pipe(
      Effect.mapError((e) => (e instanceof TurnError ? e : new TurnError({ message: String(e) }))),
    )

    return Stream.unwrap(runTurn)
  },

  cancel: (sessionId: string) =>
    Effect.gen(function* () {
      const session = manager.get(sessionId)
      if (session !== undefined) {
        yield* session.conn.cancel(session.acpSessionId)
      }
    }),
})
