/**
 * One JSON file per branch under `~/.gent/<directory>`.
 *
 * Every store that keeps branch state on disk has the same three needs: a
 * missing file reads as the empty value, a write replaces the file atomically
 * so a reader never sees a half-written document, and a read-modify-write
 * cycle is serialized under the file lock across concurrent hooks. The
 * consumer binds only what differs: the directory, the codec, the empty value,
 * and the error a corrupt file raises.
 */
import { Effect, Schema } from "effect"
import { ExtensionContext } from "@gent/core/extensions/api"

export interface BranchStateStoreInput<A, E> {
  /** Span prefix, e.g. `GoalStore`. */
  readonly name: string
  /** Directory under `~/.gent` that holds one `<branchId>.json` per branch. */
  readonly directory: string
  readonly codec: Schema.Codec<A, string>
  /** What a missing file reads as. */
  readonly empty: A
  /** Corrupt state is an error the user must see, never a silently missing value. */
  readonly invalid: (file: string, cause: Schema.SchemaError) => E
}

export const makeBranchStateStore = <A, E>(input: BranchStateStoreInput<A, E>) => {
  const decode = Schema.decodeUnknownEffect(input.codec)
  const encode = Schema.encodeSync(input.codec)

  const path = Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const directory = ctx.Files.join(ctx.home, ".gent", input.directory)
    return { directory, file: ctx.Files.join(directory, `${ctx.branchId}.json`) }
  })

  const read = Effect.fn(`${input.name}.read`)(function* () {
    const ctx = yield* ExtensionContext
    const { file } = yield* path
    if (!(yield* ctx.Files.exists(file))) return input.empty
    const text = yield* ctx.Files.read(file)
    return yield* decode(text).pipe(Effect.mapError((cause) => input.invalid(file, cause)))
  })

  const write = Effect.fn(`${input.name}.write`)(function* (value: A) {
    const ctx = yield* ExtensionContext
    const { directory, file } = yield* path
    yield* ctx.Files.makeDirectory(directory, { recursive: true })
    yield* ctx.Files.write(file, encode(value), { atomic: true })
  })

  /**
   * Serializes read-modify-write cycles on one branch across concurrent hooks.
   * Returning the value that was read skips the write.
   */
  const modify = <B, E2, R>(
    update: (current: A) => Effect.Effect<{ readonly next: A; readonly result: B }, E2, R>,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const { file } = yield* path
      return yield* ctx.FileLock.withLock(
        file,
        Effect.gen(function* () {
          const current = yield* read()
          const { next, result } = yield* update(current)
          if (next !== current) yield* write(next)
          return result
        }),
      )
    })

  /** A pure replacement of the branch value under the lock; resolves to the value written. */
  const update = (change: (current: A) => A) =>
    modify((current) => {
      const next = change(current)
      return Effect.succeed({ next, result: next })
    })

  return { read, modify, update }
}
