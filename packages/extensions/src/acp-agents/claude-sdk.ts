/**
 * ClaudeSdk — Effect service wrapping `@anthropic-ai/claude-agent-sdk`.
 *
 * Owns the SDK `query()` lifecycle: pushable input stream, async-iterator
 * messages, abort, interrupt. Surface is small (`createSession` →
 * `prompt` / `interrupt` / `close`) so the executor (claude-code-executor.ts)
 * stays thin and the SDK's complexity (Pushable, Query, process death,
 * permission mode) is hidden.
 *
 * `.Live` calls the real SDK with `CLAUDE_CODE_OAUTH_TOKEN` injected.
 * `.Test` returns canned message streams for executor mapping tests —
 * no subprocess spawned.
 *
 * @module
 */
import { Context, Effect, Layer, Schema, Stream } from "effect"
import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

// ── Public service shape ──

/**
 * Per-session SDK handle. The shape hides the Pushable input stream and the
 * `Query` async iterator behind two Effects: `prompt` (push a user message,
 * stream messages until the next `result`) and `close` (end the input,
 * stop the subprocess). `interrupt` cancels the in-flight prompt on the
 * SDK side.
 */
export interface ClaudeSdkSession {
  readonly prompt: (text: string) => Stream.Stream<SDKMessage, ClaudeSdkError>
  readonly interrupt: Effect.Effect<void, ClaudeSdkError>
  readonly close: Effect.Effect<void>
}

/**
 * Failure raised by the SDK service. Wraps both initialization failures
 * (auth, missing executable) and per-prompt errors (process death, abort).
 */
export class ClaudeSdkError extends Schema.TaggedErrorClass<ClaudeSdkError>()("ClaudeSdkError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface ClaudeSdkServiceShape {
  /**
   * Spin up an SDK session. The returned handle reuses one underlying
   * `query()` call across prompts via a Pushable input stream; per-prompt
   * `prompt()` calls push a user message and stream the resulting messages
   * until a `result` arrives.
   *
   * `oauthToken` is forwarded via `env.CLAUDE_CODE_OAUTH_TOKEN`.
   */
  readonly createSession: (params: {
    readonly cwd: string
    readonly oauthToken: string
    readonly systemPrompt: string
    readonly mcpServers?: Options["mcpServers"]
    readonly abortSignal?: AbortSignal
  }) => Effect.Effect<ClaudeSdkSession, ClaudeSdkError>
}

export class ClaudeSdk extends Context.Service<ClaudeSdk, ClaudeSdkServiceShape>()(
  "@gent/extensions/acp-agents/ClaudeSdk",
) {
  /** Live implementation — talks to the real SDK subprocess. */
  static readonly liveImpl: ClaudeSdkServiceShape = makeLiveService()

  /** Live layer — wraps {@link liveImpl} as a Context.Service Layer. */
  static readonly Live: Layer.Layer<ClaudeSdk> = Layer.succeed(ClaudeSdk, ClaudeSdk.liveImpl)

  /**
   * Test implementation — canned messages per prompt, no subprocess. Each
   * call to `prompt(text)` yields the next chunk of canned messages (in
   * order). `interrupt` and `close` succeed without effect.
   */
  static readonly testImpl = (
    canned: ReadonlyArray<ReadonlyArray<SDKMessage>>,
  ): ClaudeSdkServiceShape => ({
    createSession: () =>
      Effect.sync(() => {
        let cursor = 0
        return {
          prompt: () => {
            const batch = canned[cursor] ?? []
            cursor += 1
            return Stream.fromIterable(batch)
          },
          interrupt: Effect.void,
          close: Effect.void,
        } satisfies ClaudeSdkSession
      }),
  })

  /** Test layer — wraps {@link testImpl} as a Context.Service Layer. */
  static readonly Test = (
    canned: ReadonlyArray<ReadonlyArray<SDKMessage>>,
  ): Layer.Layer<ClaudeSdk> => Layer.succeed(ClaudeSdk, ClaudeSdk.testImpl(canned))
}

// ── Live implementation ──

/**
 * Pushable async iterable for SDK input. Each `push` either resolves a
 * waiting consumer or queues. `end` closes the stream so the SDK exits.
 *
 * Mirrors `agentclientprotocol/claude-agent-acp` `utils.ts` `Pushable` —
 * the SDK reference impl uses the same primitive because `query()`
 * requires `AsyncIterable<SDKUserMessage>`.
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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
    createSession: ({ cwd, oauthToken, systemPrompt, mcpServers, abortSignal }) =>
      Effect.gen(function* () {
        const input = new Pushable<SDKUserMessage>()

        const options: Options = {
          cwd,
          systemPrompt,
          // Tool authority: gent owns tools exclusively. The SDK's native
          // tool surface is disabled; all tool dispatch routes through the
          // codemode MCP `execute` proxy. Plan invariant — do not flip
          // without also changing the system prompt pipeline.
          tools: [],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          env: {
            // eslint-disable-next-line no-process-env
            ...process.env,
            CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
          },
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          ...(abortSignal !== undefined ? { abortController: toController(abortSignal) } : {}),
        }

        let q: Query
        try {
          q = sdkQuery({ prompt: input, options })
        } catch (err) {
          return yield* Effect.fail(
            new ClaudeSdkError({
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
              message: `Claude SDK initialization failed: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
        })

        let closed = false
        const close = Effect.sync(() => {
          if (closed) return
          closed = true
          input.end()
        })

        const interrupt = Effect.tryPromise({
          try: () => q.interrupt(),
          catch: (err) =>
            new ClaudeSdkError({
              message: `Claude SDK interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
        })

        const prompt = (text: string): Stream.Stream<SDKMessage, ClaudeSdkError> =>
          Stream.suspend(() => {
            input.push(makeUserMessage(text))
            // Drain the shared Query iterator until we see a `result` —
            // that marks the end of this prompt's response. Subsequent
            // prompts continue to consume from the same Query.
            return Stream.fromAsyncIterable(takeUntilResult(q), (err) =>
              err instanceof ClaudeSdkError
                ? err
                : new ClaudeSdkError({
                    message: `Claude SDK stream error: ${err instanceof Error ? err.message : String(err)}`,
                    cause: err,
                  }),
            )
          })

        return {
          prompt,
          interrupt,
          close,
        } satisfies ClaudeSdkSession
      }),
  }
}

/**
 * Wrap an external AbortSignal in an AbortController so the SDK option
 * (`abortController?: AbortController`) can mirror upstream cancellation.
 */
const toController = (signal: AbortSignal): AbortController => {
  const controller = new AbortController()
  if (signal.aborted) {
    controller.abort(signal.reason)
  } else {
    signal.addEventListener(
      "abort",
      () => {
        controller.abort(signal.reason)
      },
      { once: true },
    )
  }
  return controller
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
