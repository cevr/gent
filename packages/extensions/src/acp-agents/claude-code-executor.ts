/**
 * Claude Code Turn Executor — uses `@anthropic-ai/claude-agent-sdk` directly.
 *
 * SDK-based path, distinct from `executor.ts` (the ACP protocol path used
 * by opencode / gemini-cli). The Claude SDK is session-shaped, not
 * per-turn: one `query()` per gent session, prompts pushed across the
 * shared input stream.
 *
 * Tool authority — gent owns tools exclusively. SDK runs with `tools: []`
 * (set in claude-sdk.ts), the only tool the model sees is the codemode
 * MCP `execute` proxy.
 *
 * Lifecycle (per codex review of Commit 1):
 *   - Per-turn cancel: `ctx.abortSignal` is forwarded into
 *     `session.prompt(text, signal)`, which calls `q.interrupt()` on
 *     abort. The SDK session itself stays cached for the next turn.
 *   - Process death: any stream error during `prompt` is treated as
 *     session-fatal — the manager evicts the cached session via
 *     `tapErrorCause` so the next turn rebuilds.
 *
 * Streaming: `mapSdkMessage` consumes both full `assistant` messages
 * (for tool_use blocks; text/thinking are taken from the partial
 * stream_event path so we don't double-emit) and `stream_event`
 * partial deltas (for token-level text/thinking).
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
 * Map a `result` message to the terminal `finished` event.
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

/**
 * Map a full `assistant` message. Text/thinking are emitted via the
 * partial `stream_event` path (`mapStreamEvent`) — we only surface
 * `tool_use` here so we don't double-emit text. (Reference impl in
 * `claude-agent-acp` does the same: stream_event for deltas, full
 * assistant message for tool_use only.)
 */
const mapAssistantMessage = (
  msg: Extract<SDKMessage, { type: "assistant" }>,
): ReadonlyArray<TurnEvent> => {
  const events: TurnEvent[] = []
  const rawBlocks: unknown = msg.message.content ?? []
  if (!Array.isArray(rawBlocks)) return events
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const blocks = rawBlocks as ReadonlyArray<Record<string, unknown>>
  for (const block of blocks) {
    if (block["type"] !== "tool_use") continue
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

/**
 * Map a `stream_event` partial assistant delta — token-level text and
 * thinking. Handles `content_block_delta` events with `text_delta` and
 * `thinking_delta` shapes.
 */
const mapStreamEvent = (
  msg: Extract<SDKMessage, { type: "stream_event" }>,
): ReadonlyArray<TurnEvent> => {
  const rawEvent: unknown = msg.event
  if (typeof rawEvent !== "object" || rawEvent === null) return []
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const e = rawEvent as Record<string, unknown>
  if (e["type"] !== "content_block_delta") return []
  const delta = e["delta"]
  if (typeof delta !== "object" || delta === null) return []
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const d = delta as Record<string, unknown>
  if (d["type"] === "text_delta" && typeof d["text"] === "string" && d["text"] !== "") {
    return [{ _tag: "text-delta", text: d["text"] }]
  }
  if (d["type"] === "thinking_delta" && typeof d["thinking"] === "string" && d["thinking"] !== "") {
    return [{ _tag: "reasoning-delta", text: d["thinking"] }]
  }
  return []
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
  if (msg.type === "stream_event") return mapStreamEvent(msg)
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
  readonly fingerprint: string
}

/**
 * Fingerprint covers every session-defining input passed to the SDK
 * `query()` call. If any of these change for the same gent session,
 * the cached SDK session is stale (wrong cwd, prompt, or tool surface)
 * and must be torn down and rebuilt — otherwise a runtime driver
 * override or extension list change would silently keep serving the
 * old configuration.
 */
const fingerprintSession = (
  cwd: string,
  systemPrompt: string,
  codemodeConfig: CodemodeConfig | undefined,
): string => {
  const toolNames =
    codemodeConfig === undefined
      ? []
      : codemodeConfig.tools
          .map((t) => t.name)
          .slice()
          .sort()
  return JSON.stringify({ cwd, systemPrompt, tools: toolNames })
}

export interface ClaudeCodeSessionManager {
  readonly getOrCreate: (
    gentSessionId: string,
    cwd: string,
    systemPrompt: string,
    codemodeConfig: CodemodeConfig | undefined,
  ) => Effect.Effect<ClaudeSdkSession, ClaudeSdkError>
  readonly invalidate: (gentSessionId: string) => Effect.Effect<void>
  readonly disposeAll: Effect.Effect<void>
}

/**
 * In-memory, per-process map of gent session id → SDK session. Created
 * at extension setup time; lives under a `process`-scoped
 * `defineResource` `stop` finalizer so subprocesses are torn down when
 * the host shuts down.
 *
 * The SDK service is captured at construction time so the executor's
 * `executeTurn` Stream stays free of any service requirement —
 * `TurnExecutor.executeTurn` returns a Stream without a context channel.
 */
export const createClaudeCodeSessionManager = (
  sdk: ClaudeSdkServiceShape,
): ClaudeCodeSessionManager => {
  const sessions = new Map<string, ClaudeCodeProcess>()

  const tearDown = (entry: ClaudeCodeProcess): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* entry.session.close
      entry.codemode?.stop()
    })

  const getOrCreate = (
    gentSessionId: string,
    cwd: string,
    systemPrompt: string,
    codemodeConfig: CodemodeConfig | undefined,
  ): Effect.Effect<ClaudeSdkSession, ClaudeSdkError> =>
    Effect.gen(function* () {
      const fingerprint = fingerprintSession(cwd, systemPrompt, codemodeConfig)
      const existing = sessions.get(gentSessionId)
      if (existing !== undefined) {
        if (existing.fingerprint === fingerprint) return existing.session
        sessions.delete(gentSessionId)
        yield* tearDown(existing).pipe(Effect.ignore)
      }

      const oauthToken = yield* readClaudeCodeOAuthToken().pipe(
        Effect.mapError(
          (err) =>
            new ClaudeSdkError({
              kind: "init",
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
        })
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              codemode?.stop()
            }),
          ),
        )

      sessions.set(gentSessionId, { session, codemode, fingerprint })
      return session
    })

  const invalidate = (gentSessionId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entry = sessions.get(gentSessionId)
      if (entry === undefined) return
      sessions.delete(gentSessionId)
      yield* tearDown(entry)
    })

  const disposeAll: Effect.Effect<void> = Effect.gen(function* () {
    for (const [id, entry] of sessions) {
      yield* tearDown(entry).pipe(Effect.ignore)
      sessions.delete(id)
    }
  })

  return { getOrCreate, invalidate, disposeAll }
}

// ── Turn Executor Factory ──

export const makeClaudeCodeTurnExecutor = (manager: ClaudeCodeSessionManager): TurnExecutor => ({
  executeTurn: (ctx: TurnContext) => {
    const runTurn = Effect.gen(function* () {
      const services = yield* Effect.context<never>()
      const runTool: CodemodeConfig["runTool"] = makeAcpRunTool({
        services,
        hostCtx: ctx.hostCtx,
      })

      const codemodeConfig: CodemodeConfig | undefined =
        ctx.tools.length > 0 ? { tools: ctx.tools, runTool } : undefined

      const session = yield* manager
        .getOrCreate(ctx.sessionId, ctx.cwd, ctx.systemPrompt, codemodeConfig)
        .pipe(Effect.mapError((err) => new TurnError({ message: err.message, cause: err.cause })))

      const lastUser = extractLastUserMessage(ctx.messages)

      // Per-prompt cancel — `session.prompt` calls `q.interrupt()` when
      // the signal aborts. The SDK session stays cached.
      // Stream-level errors evict the cached session (process death,
      // auth expiry, etc.) so the next turn starts fresh.
      const stream = mapSdkMessageStream(session.prompt(lastUser, ctx.abortSignal)).pipe(
        Stream.tapError(() => manager.invalidate(ctx.sessionId)),
      )
      return stream
    }).pipe(
      Effect.mapError((e) => (e instanceof TurnError ? e : new TurnError({ message: String(e) }))),
    )
    return Stream.unwrap(runTurn)
  },
  // The agent loop already wires `ctx.abortSignal`; the executor's
  // `cancel` per-driver hook is unused for the SDK path.
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
