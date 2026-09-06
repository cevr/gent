/**
 * ClaudeSdk — thin Effect wrapper around `@anthropic-ai/claude-agent-sdk`.
 *
 * Owns the SDK `query()` lifecycle: pushable input stream, async-iterator
 * messages, abort, interrupt. Surface is small (`createSession` →
 * `prompt` / `interrupt` / `close`) so the executor (claude-code-executor.ts)
 * stays thin.
 *
 * Two wirings:
 *   - `ClaudeSdk.live(...)` — real SDK, with host platform values captured
 *                             by the extension at setup time.
 *   - `ClaudeSdk.test(...)` — canned per-prompt messages, no subprocess,
 *                            for executor mapping tests.
 *
 * No `Context.Service` / Layer wrapping — nothing yields the tag, and
 * the executor manager captures the impl by reference at construction
 * time. Tests build their own manager from `ClaudeSdk.test(...)` and
 * exercise the executor directly.
 *
 * Lifecycle invariants (per codex review of Commit 1):
 *   - `createSession` does NOT take a per-turn `abortSignal`. A long-lived
 *     teardown `AbortController` lives on the session, threaded into the
 *     SDK `options.abortController` to scope process death + close.
 *   - `prompt(text, signal?)` accepts a per-turn signal; on abort it
 *     calls `q.interrupt()` to cancel that prompt only.
 *   - `close()` ends the input stream, aborts the teardown controller,
 *     and calls `q.close()` (the SDK's documented teardown method).
 *   - `prompt` errors typed as `ClaudeSdkError` so the manager can
 *     `tapErrorCause` and evict dead sessions.
 *
 * Streaming: `includePartialMessages: true` gives `stream_event` deltas
 * via `SDKPartialAssistantMessage`. The executor maps those for token-
 * by-token text/thinking.
 *
 * @module
 */
import { Context, Effect, Option, Queue, Schema, Stream } from "effect"
import type { Cause } from "effect"
import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { PublicExtensionSetupContext } from "@gent/core/extensions/api"
import {
  closeClaudeQuery,
  interruptClaudeQuery,
  makeClaudeUserMessage,
  nextClaudeMessage,
} from "./claude-sdk-boundary.js"

// ── Public service shape ──

export interface AcpAgentsPlatformApi {
  readonly parentEnv: PublicExtensionSetupContext["Process"]["parentEnv"]
}

/**
 * Per-session SDK handle. The shape hides the input queue and the
 * `Query` async iterator behind two Effects.
 */
export interface ClaudeSdkSession {
  /**
   * Push a user message and stream the resulting SDK messages until a
   * `result` boundary. The optional signal cancels just this prompt via
   * `query.interrupt()`.
   */
  readonly prompt: (
    text: string,
    signal: Option.Option<AbortSignal>,
  ) => Stream.Stream<SDKMessage, ClaudeSdkError>
  /**
   * Idempotent: `input.end()` + abort the session-lifetime controller +
   * `q.close()`. Safe to call multiple times.
   */
  readonly close: Effect.Effect<void>
}

/**
 * Failure raised by the SDK service. Two shapes share this type:
 *   - `kind: "init"`     — `createSession` failed (auth, missing exec).
 *   - `kind: "stream"`   — `prompt` stream errored mid-flight (process
 *     death, abort). The manager treats this as session-fatal and
 *     evicts the cached session.
 */
export class ClaudeSdkError extends Schema.TaggedError<ClaudeSdkError>()("ClaudeSdkError", {
  kind: Schema.Literals(["init", "stream"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface ClaudeSdkServiceApi {
  readonly createSession: (params: {
    readonly cwd: string
    readonly oauthToken: string
    readonly systemPrompt: string
    readonly mcpServers: Option.Option<Options["mcpServers"]>
  }) => Effect.Effect<ClaudeSdkSession, ClaudeSdkError>
}

// ── Implementations ──

/** Live implementation — talks to the real SDK subprocess. */
export const live = (platform: AcpAgentsPlatformApi): ClaudeSdkServiceApi =>
  makeLiveService(platform)

/**
 * Test implementation — canned messages per prompt, no subprocess. Each
 * call to `prompt(text)` yields the next chunk of canned messages. The
 * `close` Effect succeeds.
 */
export const test = (canned: ReadonlyArray<ReadonlyArray<SDKMessage>>): ClaudeSdkServiceApi => ({
  createSession: () =>
    Effect.sync(() => {
      let cursor = 0
      return {
        prompt: () => {
          const batch = canned[cursor] ?? []
          cursor += 1
          return Stream.fromIterable(batch)
        },
        close: Effect.void,
      } satisfies ClaudeSdkSession
    }),
})

/** Namespaced exports for the canonical shape. */
export const ClaudeSdk = { live, test }

// ── Live implementation internals ──

// The Claude SDK accepts an AbortController so the session owner can abort
// the subprocess during close. Keep construction at this named host boundary.
const makeTeardownAbortController = (): AbortController => new AbortController()

function makeLiveService(platform: AcpAgentsPlatformApi): ClaudeSdkServiceApi {
  return {
    createSession: ({ cwd, oauthToken, systemPrompt, mcpServers }) =>
      Effect.gen(function* () {
        const inputQueue = yield* Queue.unbounded<SDKUserMessage, Cause.Done>()
        const input = Stream.fromQueue(inputQueue).pipe(Stream.toAsyncIterableWith(Context.empty()))

        // Session-lifetime teardown controller — distinct from any
        // per-prompt cancel signal. Aborting this scopes process death
        // and full close.
        const teardownController = makeTeardownAbortController()

        const options: Options = {
          cwd,
          systemPrompt,
          // Tool authority: gent owns tools exclusively. SDK native tools
          // are off; the only tool surface is the codemode MCP `execute`
          // proxy passed via `mcpServers`. Plan invariant.
          tools: [],
          // Bare-mode isolation. The original plan target was a hypothetical
          // `claude acp --bare` CLI; the SDK has no equivalent flag, but
          // omitting `settingSources` puts the SDK in "isolation mode" — no
          // user/project/local settings, no CLAUDE.md, no project-defined
          // agents/hooks/mcp servers leak in. Set to `[]` explicitly so the
          // intent is visible and survives a future SDK default change.
          settingSources: [],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          // Token-by-token deltas via `SDKPartialAssistantMessage` —
          // the executor's mapper relies on these to avoid replaying
          // full assistant messages as single chunks.
          includePartialMessages: true,
          abortController: teardownController,
          env: {
            ...platform.parentEnv,
            CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
          },
        }
        if (Option.isSome(mcpServers)) options.mcpServers = mcpServers.value

        const q = yield* Effect.try({
          try: () => sdkQuery({ prompt: input, options }),
          catch: (err) => {
            const decodedError = Schema.decodeUnknownOption(Schema.instanceOf(Error))(err)
            const message = Option.match(decodedError, {
              onNone: () => String(err),
              onSome: (error) => error.message,
            })
            return new ClaudeSdkError({
              kind: "init",
              message: `Failed to start Claude SDK query: ${message}`,
              cause: err,
            })
          },
        })

        // Await initializationResult — surfaces auth / missing executable
        // failures before the first prompt is pushed.
        yield* Effect.tryPromise({
          try: () => q.initializationResult(),
          catch: (err) => {
            const decodedError = Schema.decodeUnknownOption(Schema.instanceOf(Error))(err)
            const message = Option.match(decodedError, {
              onNone: () => String(err),
              onSome: (error) => error.message,
            })
            return new ClaudeSdkError({
              kind: "init",
              message: `Claude SDK initialization failed: ${message}`,
              cause: err,
            })
          },
        })

        let closed = false
        const close = Effect.suspend(() => {
          if (closed) return Effect.void
          closed = true
          Queue.endUnsafe(inputQueue)
          teardownController.abort()
          return closeClaudeQuery(q)
        }).pipe(Effect.ignore)

        const prompt = (
          text: string,
          signal: Option.Option<AbortSignal>,
        ): Stream.Stream<SDKMessage, ClaudeSdkError> =>
          Stream.suspend(() => {
            Queue.offerUnsafe(inputQueue, makeClaudeUserMessage(text))
            // Per-prompt cancel: hook the signal to `q.interrupt()`. The
            // SDK doc reserves `interrupt` for current-query cancel and
            // `abortController.abort()` for full teardown.
            let detach = Option.none<() => void>()
            if (Option.isSome(signal)) {
              const onAbort = (): void => {
                interruptClaudeQuery(q)
              }
              if (signal.value.aborted) onAbort()
              else {
                signal.value.addEventListener("abort", onAbort, { once: true })
                detach = Option.some(() => signal.value.removeEventListener("abort", onAbort))
              }
            }
            // Drain the shared Query iterator until we see a `result` —
            // that marks the end of this prompt's response.
            return Stream.fromAsyncIterable(takeUntilResult(q), (err) => {
              if (Schema.is(ClaudeSdkError)(err)) return err
              const decodedError = Schema.decodeUnknownOption(Schema.instanceOf(Error))(err)
              const message = Option.match(decodedError, {
                onNone: () => String(err),
                onSome: (error) => error.message,
              })
              return new ClaudeSdkError({
                kind: "stream",
                message: `Claude SDK stream error: ${message}`,
                cause: err,
              })
            }).pipe(
              Stream.ensuring(
                Effect.sync(() =>
                  Option.match(detach, {
                    onNone: () => {},
                    onSome: (detachSignal) => detachSignal(),
                  }),
                ),
              ),
            )
          })

        return {
          prompt,
          close,
        } satisfies ClaudeSdkSession
      }),
  }
}

/**
 * Yield SDK messages until a `result` boundary. The Query is shared
 * across prompts, so we cannot drain it to completion — only up to the
 * next result.
 */
function takeUntilResult(q: Query): AsyncIterable<SDKMessage> {
  const iterator = q[Symbol.asyncIterator]()
  let done = false
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
      return {
        next: () =>
          nextClaudeMessage(iterator, done).then((result) => {
            if (result.done === true) {
              done = true
              return result
            }
            if (result.value.type === "result") done = true
            return result
          }),
      }
    },
  }
}
