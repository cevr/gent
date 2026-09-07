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
 * Streaming: `mapSdkMessageToResponseParts` consumes both full `assistant` messages
 * (for tool_use blocks; text/thinking are taken from the partial
 * stream_event path so we don't double-emit) and `stream_event`
 * partial deltas (for token-level text/thinking).
 *
 * @module
 */
import { Predicate, Effect, Exit, Option, Ref, Schema, Scope, Stream } from "effect"
import * as Response from "effect/unstable/ai/Response"
import {
  ExternalToolRunner,
  InteractionPendingError,
  TurnError,
  type TurnContext,
  type TurnExecutor,
  type TurnStreamPart,
} from "@gent/core/extensions/api"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeSdkError, type ClaudeSdkServiceApi, type ClaudeSdkSession } from "./claude-sdk.js"
import { startCodemodeServer, type CodemodeConfig, type CodemodeServer } from "./mcp-codemode.js"
import { makeAcpInteractionPendingNotifier, makeAcpRunTool } from "./executor-boundary.js"
import { CLAUDE_CODE_AGENT_NAME } from "./config.js"
import type { ExternalSessionKey } from "./executor.js"
import {
  composePromptWithTranscript,
  findLastUserMessage,
  renderLiveUserPrompt,
} from "./transcript.js"
import { toResponseFinishReason } from "./response-finish.js"

const ABSENT = Option.getOrUndefined(Option.none())

// ── SDK message → Response part mapping ──

export interface SdkResponsePartMapper {
  readonly toolNamesById: Map<string, string>
}

export const makeSdkResponsePartMapper = (): SdkResponsePartMapper => ({
  toolNamesById: new Map(),
})

/**
 * Map a `result` message to the terminal finish part.
 */
const mapResultMessage = (msg: Extract<SDKMessage, { type: "result" }>): TurnStreamPart => {
  let reason = String(msg.subtype)
  if (msg.subtype === "success") reason = msg.stop_reason ?? "end_turn"
  let usage = emptyUsage()
  if (Predicate.isNotUndefined(msg.usage)) {
    usage = new Response.Usage({
      inputTokens: {
        uncached: ABSENT,
        total: msg.usage.input_tokens,
        cacheRead: ABSENT,
        cacheWrite: ABSENT,
      },
      outputTokens: {
        total: msg.usage.output_tokens,
        text: ABSENT,
        reasoning: ABSENT,
      },
    })
  }
  return Response.makePart("finish", {
    reason: toResponseFinishReason(reason),
    usage,
    response: ABSENT,
  })
}

const emptyUsage = (): Response.Usage =>
  new Response.Usage({
    inputTokens: {
      uncached: ABSENT,
      total: ABSENT,
      cacheRead: ABSENT,
      cacheWrite: ABSENT,
    },
    outputTokens: {
      total: ABSENT,
      text: ABSENT,
      reasoning: ABSENT,
    },
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
  mapper: SdkResponsePartMapper,
): ReadonlyArray<TurnStreamPart> => {
  const parts: TurnStreamPart[] = []
  const blocks = msg.message.content ?? []
  if (!Array.isArray(blocks)) return parts
  for (const block of blocks) {
    if (block["type"] !== "tool_use") continue
    const id = block.id
    let name = "unknown"
    if (Predicate.isString(block.name)) name = block.name
    if (Predicate.isString(id)) {
      mapper.toolNamesById.set(id, name)
      parts.push(
        Response.makePart("tool-call", {
          id,
          name,
          params: block["input"] ?? {},
          providerExecuted: false,
        }),
      )
    }
  }
  return parts
}

const mapUserMessage = (
  msg: Extract<SDKMessage, { type: "user" }>,
  mapper: SdkResponsePartMapper,
): ReadonlyArray<TurnStreamPart> => {
  const parts: TurnStreamPart[] = []
  const blocks = msg.message.content ?? []
  if (!Array.isArray(blocks)) return parts
  for (const block of blocks) {
    if (block["type"] !== "tool_result") continue
    const id = block.tool_use_id
    if (!Predicate.isString(id)) continue
    const name = mapper.toolNamesById.get(id) ?? "external"
    if (block["is_error"] === true) {
      const errText = Option.getOrElse(stringifyContent(block.content ?? []), () => "tool failed")
      parts.push(
        Response.makePart("tool-result", {
          id,
          name,
          result: errText,
          encodedResult: { error: errText },
          isFailure: true,
          providerExecuted: false,
          preliminary: false,
        }),
      )
    } else {
      const result = Option.getOrNull(Option.fromNullishOr(block.content))
      parts.push(
        Response.makePart("tool-result", {
          id,
          name,
          result,
          encodedResult: result,
          isFailure: false,
          providerExecuted: false,
          preliminary: false,
        }),
      )
    }
  }
  return parts
}

/**
 * Map a `stream_event` partial assistant delta — token-level text and
 * thinking. Handles `content_block_delta` events with `text_delta` and
 * `thinking_delta` shapes.
 */
const mapStreamEvent = (
  msg: Extract<SDKMessage, { type: "stream_event" }>,
): ReadonlyArray<TurnStreamPart> => {
  const e = msg.event
  if (!Predicate.isObjectOrArray(e)) return []
  if (e["type"] !== "content_block_delta") return []
  const d = e.delta
  if (!Predicate.isObjectOrArray(d)) return []
  let index = 0
  if (Predicate.isNumber(e.index)) index = e.index
  if (d["type"] === "text_delta" && Predicate.isString(d["text"]) && d["text"] !== "") {
    return [
      Response.makePart("text-delta", {
        id: `claude-text-${index}`,
        delta: d["text"],
      }),
    ]
  }
  if (d["type"] === "thinking_delta" && Predicate.isString(d["thinking"]) && d["thinking"] !== "") {
    return [
      Response.makePart("reasoning-delta", {
        id: `claude-reasoning-${index}`,
        delta: d["thinking"],
      }),
    ]
  }
  return []
}

type SdkUserContentBlock = Exclude<
  Extract<SDKMessage, { type: "user" }>["message"]["content"],
  string
>[number]
type SdkToolResultContent = Extract<SdkUserContentBlock, { type: "tool_result" }>["content"]

const stringifyContent = (content: SdkToolResultContent): Option.Option<string> => {
  if (Predicate.isString(content)) return Option.some(content)
  if (Array.isArray(content)) {
    const parts = content.flatMap((block) => {
      if ("text" in block && Predicate.isString(block.text) && block.text.length > 0)
        return [block.text]
      return []
    })
    if (parts.length > 0) return Option.some(parts.join(""))
  }
  return Option.none()
}

/** @internal Exported for testing — convert one SDK message into 0..N response parts. */
export const mapSdkMessageToResponseParts = (
  msg: SDKMessage,
  mapper: SdkResponsePartMapper = makeSdkResponsePartMapper(),
): ReadonlyArray<TurnStreamPart> => {
  if (msg.type === "result") return [mapResultMessage(msg)]
  if (msg.type === "assistant") return mapAssistantMessage(msg, mapper)
  if (msg.type === "user") return mapUserMessage(msg, mapper)
  if (msg.type === "stream_event") return mapStreamEvent(msg)
  return []
}

const mapSdkMessageStream = (
  stream: Stream.Stream<SDKMessage, ClaudeSdkError>,
): Stream.Stream<TurnStreamPart, TurnError> => {
  const mapper = makeSdkResponsePartMapper()
  return stream.pipe(
    Stream.mapEffect((msg) => Effect.succeed(mapSdkMessageToResponseParts(msg, mapper))),
    Stream.flatMap((events) => Stream.fromIterable(events)),
    Stream.mapError((err) => new TurnError({ message: err.message, cause: err.cause })),
  )
}

// ── Session manager (SDK-backed) ──

interface ClaudeCodeProcess {
  readonly session: ClaudeSdkSession
  readonly codemode: Option.Option<CodemodeServer>
  readonly codemodeScope: Option.Option<Scope.Closeable>
  readonly fingerprint: string
}

// `ExternalSessionKey` is defined in `executor.ts` and re-used by both
// session managers (SDK + ACP-protocol) so the cache-key shape stays in
// one place.
const cacheKey = (k: ExternalSessionKey): string => `${k.driverId}::${k.sessionId}::${k.branchId}`

/**
 * Fingerprint covers every session-defining input passed to the SDK
 * `query()` call. If any of these change for the same composite key,
 * the cached SDK session is stale (wrong cwd, prompt, or tool surface)
 * and must be torn down and rebuilt.
 */
const fingerprintSession = (
  cwd: string,
  systemPrompt: string,
  codemodeConfig?: CodemodeConfig,
): string => {
  let toolNames: ReadonlyArray<string> = []
  if (Predicate.isNotUndefined(codemodeConfig)) {
    toolNames = codemodeConfig.tools
      .map((t) => t.id)
      .slice()
      .sort()
  }
  // oxlint-disable-next-line effect/noGlobals -- the SDK session fingerprint uses a stable JSON key.
  return JSON.stringify({ cwd, systemPrompt, tools: toolNames })
}

export interface ClaudeCodeManagedSession {
  readonly session: ClaudeSdkSession
  /**
   * `true` when this call built (or rebuilt) the SDK session. Callers
   * use it to seed the freshly-created remote session with the prior
   * transcript before sending the new turn — without seeding, a
   * fingerprint mismatch / `invalidateDriver` silently drops the
   * conversation on the floor.
   */
  readonly created: boolean
}

export interface ClaudeCodeSessionManager {
  readonly getOrCreate: (
    key: ExternalSessionKey,
    cwd: string,
    systemPrompt: string,
    codemodeConfig?: CodemodeConfig,
  ) => Effect.Effect<ClaudeCodeManagedSession, ClaudeSdkError>
  /** Invalidate one specific (sessionId, branchId, driverId) entry. */
  readonly invalidate: (key: ExternalSessionKey) => Effect.Effect<void>
  /** Invalidate every entry whose driverId matches — used by `driver.set` /
   *  `driver.clear` so the next turn cannot land on a stale conversation. */
  readonly invalidateDriver: (driverId: string) => Effect.Effect<void>
  readonly disposeAll: Effect.Effect<void>
}

/**
 * In-memory, per-process map of gent session id → SDK session. Created
 * at extension setup time; lives under a `process`-scoped
 * `defineResource` `stop` finalizer so subprocesses are torn down when
 * the host shuts down.
 *
 * The SDK service is captured at construction time so the executor only
 * inherits the per-turn tool runner context from `ExternalToolRunner`.
 */
/** Resolves the Claude Code OAuth token. Defaults to the macOS keychain
 *  reader; tests inject a stub so they can exercise lifecycle/cache
 *  invariants without a real keychain entry. The error type is left
 *  wide enough to accept either the production `ProviderAuthError` or
 *  test stubs returning a plain `{ message }`. */
export type ClaudeCodeTokenReader = () => Effect.Effect<string, { readonly message: string }>

export const createClaudeCodeSessionManager = (
  sdk: ClaudeSdkServiceApi,
  tokenReader: ClaudeCodeTokenReader,
): ClaudeCodeSessionManager => {
  const sessions = new Map<string, ClaudeCodeProcess>()
  // Parallel index from driverId → set of cache keys. Lets `invalidateDriver`
  // run in O(matched) rather than O(all sessions). Maintained alongside
  // `sessions` on every set/delete.
  const byDriver = new Map<string, Set<string>>()

  const tearDown = (entry: ClaudeCodeProcess): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* entry.session.close
      if (Option.isSome(entry.codemodeScope)) {
        yield* Scope.close(entry.codemodeScope.value, Exit.void).pipe(Effect.ignore)
      }
    })

  const removeFromDriverIndex = (driverId: string, k: string) => {
    const set = Option.fromNullishOr(byDriver.get(driverId))
    if (Option.isNone(set)) return
    set.value.delete(k)
    if (set.value.size === 0) byDriver.delete(driverId)
  }

  const getOrCreate = (
    key: ExternalSessionKey,
    cwd: string,
    systemPrompt: string,
    codemodeConfig?: CodemodeConfig,
  ): Effect.Effect<ClaudeCodeManagedSession, ClaudeSdkError> =>
    Effect.gen(function* () {
      const fingerprint = fingerprintSession(cwd, systemPrompt, codemodeConfig)
      const k = cacheKey(key)
      const existing = Option.fromNullishOr(sessions.get(k))
      if (Option.isSome(existing)) {
        if (existing.value.fingerprint === fingerprint) {
          if (Option.isSome(existing.value.codemode) && Predicate.isNotUndefined(codemodeConfig)) {
            yield* existing.value.codemode.value.updateConfig(codemodeConfig)
          }
          return { session: existing.value.session, created: false }
        }
        sessions.delete(k)
        removeFromDriverIndex(key.driverId, k)
        yield* tearDown(existing.value).pipe(Effect.ignore)
      }

      const oauthToken = yield* tokenReader().pipe(
        Effect.mapError(
          (err) =>
            new ClaudeSdkError({
              kind: "init",
              message: `Failed to read Claude Code OAuth token: ${err.message}`,
              cause: err,
            }),
        ),
      )

      let codemode = Option.none<CodemodeServer>()
      let codemodeScope = Option.none<Scope.Closeable>()
      let mcpServers = Option.none<{ gent: { type: "http"; url: string } }>()
      if (Predicate.isNotUndefined(codemodeConfig) && codemodeConfig.tools.length > 0) {
        const localCodemodeScope = yield* Scope.make()
        codemodeScope = Option.some(localCodemodeScope)
        const server = yield* startCodemodeServer(codemodeConfig).pipe(
          Scope.provide(localCodemodeScope),
          Effect.mapError(
            (e) =>
              new ClaudeSdkError({
                kind: "init",
                message: e.message,
                cause: e,
              }),
          ),
          // Close codemode scope on startup failure so the bound HTTP port
          // is released even if startCodemodeServer fails after acquireRelease
          // resolved.
          Effect.tapError(() => Scope.close(localCodemodeScope, Exit.void).pipe(Effect.ignore)),
        )
        codemode = Option.some(server)
        mcpServers = Option.some({
          gent: { type: "http", url: `${server.url}/mcp` },
        })
      }

      const session = yield* sdk
        .createSession({
          cwd,
          oauthToken,
          systemPrompt,
          mcpServers,
        })
        .pipe(
          Effect.tapError(() =>
            Option.match(codemodeScope, {
              onNone: () => Effect.void,
              onSome: (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
            }),
          ),
        )

      sessions.set(k, {
        session,
        codemode,
        codemodeScope,
        fingerprint,
      })
      const driverSet = byDriver.get(key.driverId) ?? new Set<string>()
      driverSet.add(k)
      byDriver.set(key.driverId, driverSet)
      return { session, created: true }
    })

  const invalidate = (key: ExternalSessionKey): Effect.Effect<void> =>
    Effect.gen(function* () {
      const k = cacheKey(key)
      const entry = Option.fromNullishOr(sessions.get(k))
      if (Option.isNone(entry)) return
      sessions.delete(k)
      removeFromDriverIndex(key.driverId, k)
      yield* tearDown(entry.value)
    })

  const invalidateDriver = (driverId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const keys = Option.fromNullishOr(byDriver.get(driverId))
      if (Option.isNone(keys)) return
      // Snapshot the key set before mutating — `tearDown` is async and
      // re-entries via getOrCreate during teardown would otherwise see
      // a partially-cleared set.
      const keysArr = [...keys.value]
      byDriver.delete(driverId)
      for (const k of keysArr) {
        const entry = Option.fromNullishOr(sessions.get(k))
        sessions.delete(k)
        if (Option.isSome(entry)) yield* tearDown(entry.value).pipe(Effect.ignore)
      }
    })

  const disposeAll: Effect.Effect<void> = Effect.gen(function* () {
    for (const [k, entry] of sessions) {
      yield* tearDown(entry).pipe(Effect.ignore)
      sessions.delete(k)
    }
    byDriver.clear()
  })

  return { getOrCreate, invalidate, invalidateDriver, disposeAll }
}

// ── Turn Executor Factory ──

export const makeClaudeCodeTurnExecutor = (manager: ClaudeCodeSessionManager): TurnExecutor => ({
  executeTurn: (ctx: TurnContext) => {
    const runTurn = Effect.gen(function* () {
      const services = yield* Effect.context<never>()
      const toolRunner = yield* ExternalToolRunner
      const pendingInteraction = yield* Ref.make<Option.Option<InteractionPendingError>>(
        Option.none(),
      )
      const runTool: CodemodeConfig["runTool"] = makeAcpRunTool({
        services,
        runTool: toolRunner.runTool,
      })

      let codemodeConfig = Option.none<CodemodeConfig>()
      if (ctx.tools.length > 0) {
        codemodeConfig = Option.some({
          tools: ctx.tools,
          runTool,
          onInteractionPending: makeAcpInteractionPendingNotifier({
            services,
            notify: (pending) => Ref.set(pendingInteraction, Option.some(pending)),
          }),
        })
      }

      // Driver id is hardcoded to the contribution registered in
      // `acp-agents/index.ts`; matches the value used in the
      // `invalidateDriver` calls from `driver.set` / `driver.clear`.
      const key: ExternalSessionKey = {
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        driverId: `acp-${CLAUDE_CODE_AGENT_NAME}`,
      }

      const managed = yield* manager
        .getOrCreate(key, ctx.cwd, ctx.systemPrompt, Option.getOrUndefined(codemodeConfig))
        .pipe(Effect.mapError((err) => new TurnError({ message: err.message, cause: err.cause })))

      // On a fresh / rebuilt SDK session we send the prior transcript as
      // a single preamble user message before the new turn — the SDK
      // exposes no other channel for backfilling assistant history, so a
      // bare `prompt(lastUser)` would silently drop everything before
      // the cache miss. The preamble is suppressed when reusing a warm
      // session.
      const lastUser = findLastUserMessage(ctx.messages)
      let promptText = renderLiveUserPrompt(lastUser)
      if (managed.created) promptText = composePromptWithTranscript(ctx.messages, lastUser)

      // Per-prompt cancel — `session.prompt` calls `q.interrupt()` when
      // the signal aborts. The SDK session stays cached.
      // Stream-level errors evict the cached session (process death,
      // auth expiry, etc.) so the next turn starts fresh.
      const stream = mapSdkMessageStream(
        managed.session.prompt(promptText, Option.some(ctx.abortSignal)),
      ).pipe(Stream.tapError(() => manager.invalidate(key)))
      const pendingCheck = Stream.fromEffect(
        Ref.get(pendingInteraction).pipe(
          Effect.flatMap((pending) =>
            Option.match(pending, {
              onNone: () => Effect.void,
              onSome: (error) => Effect.fail(error),
            }),
          ),
        ),
      ).pipe(Stream.flatMap(() => Stream.empty))
      return Stream.concat(stream, pendingCheck)
    }).pipe(
      Effect.mapError((e) => {
        if (Schema.is(TurnError)(e) || Schema.is(InteractionPendingError)(e)) return e
        return new TurnError({ message: String(e) })
      }),
    )
    return Stream.unwrap(runTurn)
  },
})

// ── Helpers ──
