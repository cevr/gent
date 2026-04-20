/**
 * Claude Code Turn Executor — uses `@anthropic-ai/claude-agent-sdk` directly.
 *
 * This is the SDK-based path, distinct from `executor.ts` (the ACP protocol
 * path used by opencode / gemini-cli). The Claude SDK is session-shaped, not
 * per-turn: one `query()` per gent session, prompts pushed across the
 * shared Pushable input stream.
 *
 * Tool authority — gent owns tools exclusively. SDK runs with `tools: []`,
 * the only tool the model sees is the codemode MCP `execute` proxy.
 *
 * @module
 */
import { Effect, Stream } from "effect"
import {
  TurnError,
  type TurnContext,
  type TurnEvent,
  type TurnExecutor,
} from "@gent/core/extensions/api"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeSdkError, type ClaudeSdkServiceShape, type ClaudeSdkSession } from "./claude-sdk.js"
import { startCodemodeServer, type CodemodeConfig, type CodemodeServer } from "./mcp-codemode.js"
import { makeAcpRunTool } from "./executor-boundary.js"
import { readClaudeCodeOAuthToken } from "./claude-code-auth.js"

// ── SDK message → TurnEvent mapping ──

/**
 * Map a single SDK message to a TurnEvent. Returns `undefined` for
 * messages gent doesn't surface (system, status, hooks, etc.).
 *
 * Block-bearing messages (`assistant`) yield multiple events — handled
 * by `mapAssistantMessage`, called inline by `mapSdkMessageStream`.
 */
const mapResultMessage = (msg: Extract<SDKMessage, { type: "result" }>): TurnEvent => ({
  _tag: "finished",
  stopReason: msg.subtype === "success" ? (msg.stop_reason ?? "end_turn") : msg.subtype,
  usage:
    msg.usage !== undefined
      ? {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
        }
      : undefined,
})

const mapAssistantMessage = (
  msg: Extract<SDKMessage, { type: "assistant" }>,
): ReadonlyArray<TurnEvent> => {
  const events: TurnEvent[] = []
  const rawBlocks: unknown = msg.message.content ?? []
  if (!Array.isArray(rawBlocks)) return events
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const blocks = rawBlocks as ReadonlyArray<Record<string, unknown>>
  for (const block of blocks) {
    const t = block["type"]
    if (t === "text") {
      const text = typeof block["text"] === "string" ? block["text"] : ""
      if (text !== "") events.push({ _tag: "text-delta", text })
      continue
    }
    if (t === "thinking") {
      const text = typeof block["thinking"] === "string" ? block["thinking"] : ""
      if (text !== "") events.push({ _tag: "reasoning-delta", text })
      continue
    }
    if (t === "tool_use") {
      const id = typeof block["id"] === "string" ? block["id"] : undefined
      const name = typeof block["name"] === "string" ? block["name"] : "unknown"
      if (id !== undefined) {
        events.push({
          _tag: "tool-started",
          toolCallId: id,
          toolName: name,
          input: block["input"],
        })
      }
      continue
    }
  }
  return events
}

const mapUserMessage = (msg: Extract<SDKMessage, { type: "user" }>): ReadonlyArray<TurnEvent> => {
  const events: TurnEvent[] = []
  const rawBlocks: unknown = msg.message.content ?? []
  if (!Array.isArray(rawBlocks)) return events
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const blocks = rawBlocks as ReadonlyArray<Record<string, unknown>>
  for (const block of blocks) {
    if (block["type"] !== "tool_result") continue
    const id = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : undefined
    if (id === undefined) continue
    if (block["is_error"] === true) {
      const errText = stringifyContent(block["content"]) ?? "tool failed"
      events.push({ _tag: "tool-failed", toolCallId: id, error: errText })
    } else {
      events.push({ _tag: "tool-completed", toolCallId: id, output: block["content"] })
    }
  }
  return events
}

const stringifyContent = (content: unknown): string | undefined => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts = content
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      .map((c: Record<string, unknown>) => (typeof c["text"] === "string" ? c["text"] : ""))
      .filter((s: string) => s !== "")
    return parts.length > 0 ? parts.join("") : undefined
  }
  return undefined
}

/** @internal Exported for testing — convert one SDK message into 0..N TurnEvents. */
export const mapSdkMessage = (msg: SDKMessage): ReadonlyArray<TurnEvent> => {
  if (msg.type === "result") return [mapResultMessage(msg)]
  if (msg.type === "assistant") return mapAssistantMessage(msg)
  if (msg.type === "user") return mapUserMessage(msg)
  return []
}

const mapSdkMessageStream = (
  stream: Stream.Stream<SDKMessage, ClaudeSdkError>,
): Stream.Stream<TurnEvent, TurnError> =>
  stream.pipe(
    Stream.mapEffect((msg) => Effect.succeed(mapSdkMessage(msg))),
    Stream.flatMap((events) => Stream.fromIterable(events)),
    Stream.mapError((err) => new TurnError({ message: err.message, cause: err.cause })),
  )

// ── Session manager (SDK-backed) ──

interface ClaudeCodeProcess {
  readonly session: ClaudeSdkSession
  readonly codemode?: CodemodeServer
}

export interface ClaudeCodeSessionManager {
  readonly getOrCreate: (
    gentSessionId: string,
    cwd: string,
    systemPrompt: string,
    codemodeConfig: CodemodeConfig | undefined,
    abortSignal?: AbortSignal,
  ) => Effect.Effect<ClaudeSdkSession, ClaudeSdkError>
  readonly invalidate: (gentSessionId: string) => Effect.Effect<void>
  readonly disposeAll: Effect.Effect<void>
}

/**
 * In-memory, per-process map of gent session id → SDK session. Created at
 * extension setup time; lives under a `process`-scoped `defineResource`
 * `stop` finalizer so subprocesses are torn down when the host shuts down.
 *
 * The SDK service is captured at construction time (rather than yielded
 * per-turn) so the executor's `executeTurn` Stream stays free of any
 * service requirement — `TurnExecutor.executeTurn` returns a Stream
 * without a context channel.
 */
export const createClaudeCodeSessionManager = (
  sdk: ClaudeSdkServiceShape,
): ClaudeCodeSessionManager => {
  const sessions = new Map<string, ClaudeCodeProcess>()

  const getOrCreate = (
    gentSessionId: string,
    cwd: string,
    systemPrompt: string,
    codemodeConfig: CodemodeConfig | undefined,
    abortSignal?: AbortSignal,
  ): Effect.Effect<ClaudeSdkSession, ClaudeSdkError> =>
    Effect.gen(function* () {
      const existing = sessions.get(gentSessionId)
      if (existing !== undefined) return existing.session

      const oauthToken = yield* readClaudeCodeOAuthToken().pipe(
        Effect.mapError(
          (err) =>
            new ClaudeSdkError({
              message: `Failed to read Claude Code OAuth token: ${err.message}`,
              cause: err,
            }),
        ),
      )

      let codemode: CodemodeServer | undefined
      let mcpServers: { gent: { type: "http"; url: string } } | undefined
      if (codemodeConfig !== undefined && codemodeConfig.tools.length > 0) {
        codemode = yield* startCodemodeServer(codemodeConfig)
        mcpServers = { gent: { type: "http", url: `${codemode.url}/mcp` } }
      }

      const session = yield* sdk
        .createSession({
          cwd,
          oauthToken,
          systemPrompt,
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          ...(abortSignal !== undefined ? { abortSignal } : {}),
        })
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              codemode?.stop()
            }),
          ),
        )

      sessions.set(gentSessionId, { session, codemode })
      return session
    })

  const invalidate = (gentSessionId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entry = sessions.get(gentSessionId)
      if (entry === undefined) return
      sessions.delete(gentSessionId)
      yield* entry.session.close
      entry.codemode?.stop()
    })

  const disposeAll: Effect.Effect<void> = Effect.gen(function* () {
    for (const [id, entry] of sessions) {
      yield* entry.session.close.pipe(Effect.ignore)
      entry.codemode?.stop()
      sessions.delete(id)
    }
  })

  return { getOrCreate, invalidate, disposeAll }
}

// ── Turn Executor Factory ──

export const makeClaudeCodeTurnExecutor = (manager: ClaudeCodeSessionManager): TurnExecutor => ({
  executeTurn: (ctx: TurnContext) => {
    const runTurn = Effect.gen(function* () {
      // Tool runner adapter — mirrors `makeAcpTurnExecutor`. The codemode JS
      // sandbox calls `runTool` as a Promise function; the only Effect that
      // crosses that boundary is `toolRunner.run(...)`, pinned by
      // `makeAcpRunTool`.
      const services = yield* Effect.context<never>()
      const runTool: CodemodeConfig["runTool"] = makeAcpRunTool({
        services,
        hostCtx: ctx.hostCtx,
      })

      const codemodeConfig: CodemodeConfig | undefined =
        ctx.tools.length > 0 ? { tools: ctx.tools, runTool } : undefined

      const session = yield* manager
        .getOrCreate(ctx.sessionId, ctx.cwd, ctx.systemPrompt, codemodeConfig, ctx.abortSignal)
        .pipe(Effect.mapError((err) => new TurnError({ message: err.message, cause: err.cause })))

      // Wire upstream abort → SDK interrupt. The SDK's abortController option
      // (passed to createSession) tears down on signal too; this extra hook
      // is belt-and-braces for prompts started after the controller was set.
      if (ctx.abortSignal !== undefined) {
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            Effect.runFork(session.interrupt.pipe(Effect.ignore))
          },
          { once: true },
        )
      }

      const lastUser = extractLastUserMessage(ctx.messages)
      return mapSdkMessageStream(session.prompt(lastUser))
    }).pipe(
      Effect.mapError((e) => (e instanceof TurnError ? e : new TurnError({ message: String(e) }))),
    )
    return Stream.unwrap(runTurn)
  },
  // The driver's `cancel` is per-turn. The agent loop already wires
  // `ctx.abortSignal` to the SDK abort controller in `executeTurn`, so
  // there's nothing extra to do here — the in-flight prompt aborts via the
  // signal, and the SDK session itself stays cached for the next turn.
  // (Use `manager.invalidate(sessionId)` if you need to recycle the
  // subprocess entirely.)
  cancel: () => Effect.void,
})

// ── Helpers ──

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
