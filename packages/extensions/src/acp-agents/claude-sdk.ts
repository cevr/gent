/**
 * ClaudeSdk — thin Effect wrapper around `@anthropic-ai/claude-agent-sdk`.
 *
 * Owns the SDK `query()` lifecycle: pushable input stream, async-iterator
 * messages, abort, interrupt. Surface is small (`createSession` →
 * `prompt` / `interrupt` / `close`) so the executor (claude-code-executor.ts)
 * stays thin.
 *
 * Two wirings:
 *   - `ClaudeSdk.live`     — real SDK, pinned `liveImpl` value injected
 *                            by the extension at setup time.
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
import { Effect, Schema, Stream } from "effect"
import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

// ── Public service shape ──

/**
 * Per-session SDK handle. The shape hides the Pushable input stream and
 * the `Query` async iterator behind two Effects.
 */
export interface ClaudeSdkSession {
  /**
   * Push a user message and stream the resulting SDK messages until a
   * `result` boundary. The optional signal cancels just this prompt via
   * `query.interrupt()`.
   */
  readonly prompt: (text: string, signal?: AbortSignal) => Stream.Stream<SDKMessage, ClaudeSdkError>
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
export class ClaudeSdkError extends Schema.TaggedErrorClass<ClaudeSdkError>()("ClaudeSdkError", {
  kind: Schema.Literals(["init", "stream"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface ClaudeSdkServiceShape {
  readonly createSession: (params: {
    readonly cwd: string
    readonly oauthToken: string
    readonly systemPrompt: string
    readonly mcpServers?: Options["mcpServers"]
  }) => Effect.Effect<ClaudeSdkSession, ClaudeSdkError>
}

// ── Implementations ──

/** Live implementation — talks to the real SDK subprocess. */
export const live: ClaudeSdkServiceShape = makeLiveService()

/**
 * Test implementation — canned messages per prompt, no subprocess. Each
 * call to `prompt(text)` yields the next chunk of canned messages. The
 * `close` Effect succeeds.
 */
export const test = (canned: ReadonlyArray<ReadonlyArray<SDKMessage>>): ClaudeSdkServiceShape => ({
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
export const ClaudeSdk = { live, test } as const

// ── Live implementation internals ──

/**
 * Pushable async iterable for SDK input. Each `push` either resolves a
 * waiting consumer or queues. `end` closes the stream so the SDK exits.
 *
 * Mirrors `agentclientprotocol/claude-agent-acp` `utils.ts` `Pushable`.
 */
class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private done = false

  push(item: T): void {
    const resolve = this.resolvers.shift()
    if (resolve !== undefined) {
      resolve({ value: item, done: false })
    } else {
      this.queue.push(item)
    }
  }

  end(): void {
    this.done = true
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
      resolve?.({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const queued = this.queue.shift()
        if (queued !== undefined) {
          return Promise.resolve({ value: queued, done: false })
        }
        if (this.done) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve)
        })
      },
    }
  }
}

const makeUserMessage = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
})

function makeLiveService(): ClaudeSdkServiceShape {
  return {
    createSession: ({ cwd, oauthToken, systemPrompt, mcpServers }) =>
      Effect.gen(function* () {
        const input = new Pushable<SDKUserMessage>()

        // Session-lifetime teardown controller — distinct from any
        // per-prompt cancel signal. Aborting this scopes process death
        // and full close.
        const teardownController = new AbortController()

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
            // eslint-disable-next-line no-process-env -- Claude SDK child process inherits the user's shell environment
            ...process.env,
            CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
          },
          ...(mcpServers !== undefined ? { mcpServers } : {}),
        }

        let q: Query
        try {
          q = sdkQuery({ prompt: input, options })
        } catch (err) {
          return yield* Effect.fail(
            new ClaudeSdkError({
              kind: "init",
              message: `Failed to start Claude SDK query: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
          )
        }

        // Await initializationResult — surfaces auth / missing executable
        // failures before the first prompt is pushed.
        yield* Effect.tryPromise({
          try: () => q.initializationResult(),
          catch: (err) =>
            new ClaudeSdkError({
              kind: "init",
              message: `Claude SDK initialization failed: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
        })

        let closed = false
        const close = Effect.tryPromise({
          try: async () => {
            if (closed) return
            closed = true
            input.end()
            teardownController.abort()
            await q.close()
          },
          catch: () => undefined,
        }).pipe(Effect.ignore)

        const prompt = (
          text: string,
          signal?: AbortSignal,
        ): Stream.Stream<SDKMessage, ClaudeSdkError> =>
          Stream.suspend(() => {
            input.push(makeUserMessage(text))
            // Per-prompt cancel: hook the signal to `q.interrupt()`. The
            // SDK doc reserves `interrupt` for current-query cancel and
            // `abortController.abort()` for full teardown.
            let detach: (() => void) | undefined
            if (signal !== undefined) {
              const onAbort = (): void => {
                void q.interrupt().catch(() => undefined)
              }
              if (signal.aborted) onAbort()
              else {
                signal.addEventListener("abort", onAbort, { once: true })
                detach = () => signal.removeEventListener("abort", onAbort)
              }
            }
            // Drain the shared Query iterator until we see a `result` —
            // that marks the end of this prompt's response.
            return Stream.fromAsyncIterable(takeUntilResult(q), (err) =>
              err instanceof ClaudeSdkError
                ? err
                : new ClaudeSdkError({
                    kind: "stream",
                    message: `Claude SDK stream error: ${err instanceof Error ? err.message : String(err)}`,
                    cause: err,
                  }),
            ).pipe(Stream.ensuring(Effect.sync(() => detach?.())))
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
async function* takeUntilResult(q: Query): AsyncIterable<SDKMessage> {
  for await (const msg of q) {
    yield msg
    if (msg.type === "result") return
  }
}
