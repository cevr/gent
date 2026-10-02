import { Effect, Option, Schema, type Scope } from "effect"

/** A worker could not finish its search. Feature owners retain their own error contract. */
export class RegexMatcherError extends Schema.TaggedError<RegexMatcherError>()(
  "RegexMatcherError",
  { message: Schema.String, pattern: Schema.String },
) {}

const MatcherReply = Schema.Struct({
  id: Schema.Int,
  /** Each matching input's index and match offset, at most `limit + 1`. */
  hits: Schema.Array(Schema.Tuple([Schema.Int, Schema.Int])),
  undecided: Schema.Int,
})
type MatcherReply = typeof MatcherReply.Type

/**
 * JavaScriptCore can exhaust its backtracking limit and report a miss even
 * when a later match exists. A slow miss is undecided, as in grep's existing
 * contract: 50 ms is below the fastest measured give-up, and load only slows
 * it. This timing signal also counts some real misses; it is not proof of a
 * backtracking-limit event.
 */
const UNDECIDED_INPUT_MS = 50

// No imports: this Blob runs from source and from the compiled Bun binary.
const MATCHER_SOURCE = [
  "let regex",
  "onmessage = (event) => {",
  "  const { id, source, flags, inputs, limit } = event.data",
  "  regex ??= new RegExp(source, flags)",
  "  const hits = []",
  "  let undecided = 0",
  "  for (let index = 0; index < inputs.length && hits.length <= limit; index++) {",
  "    const started = performance.now()",
  "    const hit = regex.exec(inputs[index])",
  "    if (hit !== null) hits.push([index, hit.index])",
  `    else if (performance.now() - started > ${UNDECIDED_INPUT_MS}) undecided++`,
  "  }",
  "  postMessage({ id, hits, undecided })",
  "}",
].join("\n")

export interface RegexMatcher {
  /** Inputs are searched apart: grep's lines, or a monitor's retained head and tail. */
  readonly search: (
    inputs: ReadonlyArray<string>,
    limit: number,
  ) => Effect.Effect<MatcherReply, RegexMatcherError>
}

/** One scope owns the worker and Blob URL; interruption ends CPU-bound work. */
export const makeRegexMatcher = Effect.fn("RegexMatcher.make")(function* (
  regex: RegExp,
): Effect.fn.Return<RegexMatcher, RegexMatcherError, Scope.Scope> {
  const pending = new Map<number, (reply: Effect.Effect<MatcherReply, RegexMatcherError>) => void>()
  const failAll = (message: string) => {
    for (const resume of pending.values()) {
      resume(Effect.fail(new RegexMatcherError({ message, pattern: regex.source })))
    }
    pending.clear()
  }
  const url = yield* Effect.acquireRelease(
    Effect.sync(() => URL.createObjectURL(new Blob([MATCHER_SOURCE]))),
    (created) => Effect.sync(() => URL.revokeObjectURL(created)),
  )
  const thread = yield* Effect.acquireRelease(
    Effect.try({
      // oxlint-disable-next-line effect/noGlobals -- Bun's terminable Blob worker isolates arbitrary regex CPU work; an Effect Worker needs a separately bundled process entry.
      try: () => new Worker(url),
      catch: (cause) =>
        new RegexMatcherError({
          message: `Could not start regex matcher: ${String(cause)}`,
          pattern: regex.source,
        }),
    }),
    (started) =>
      Effect.sync(() => {
        started.terminate()
        failAll("Regex matching ended")
      }),
  )
  thread.onmessage = (event: MessageEvent) => {
    const reply = Schema.decodeUnknownOption(MatcherReply)(event.data)
    if (Option.isNone(reply)) return failAll("Regex matcher sent an unreadable reply")
    const resume = pending.get(reply.value.id)
    pending.delete(reply.value.id)
    resume?.(Effect.succeed(reply.value))
  }
  thread.onerror = (event: ErrorEvent) => failAll(`Regex matcher failed: ${event.message}`)
  let nextId = 0
  return {
    search: Effect.fn("RegexMatcher.search")(function* (inputs, limit) {
      return yield* Effect.callback<MatcherReply, RegexMatcherError>((resume) => {
        const id = nextId++
        pending.set(id, resume)
        thread.postMessage({ id, source: regex.source, flags: regex.flags, inputs, limit })
        return Effect.sync(() => {
          pending.delete(id)
        })
      })
    }),
  }
})
