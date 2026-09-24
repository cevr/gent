/**
 * One JSON file per branch under `<data directory>/<directory>`: the directory
 * `GENT_DATA_DIR` names, else `~/.gent`, resolved as the server resolves the
 * database it sits beside.
 *
 * Every store that keeps branch state on disk has the same three needs: a
 * missing file reads as the empty value, a write replaces the file atomically
 * so a reader never sees a half-written document, and a read-modify-write
 * cycle is serialized under the file lock across concurrent hooks. The
 * consumer binds only what differs: the directory, the codec, the empty value,
 * and the error a corrupt file raises.
 *
 * The store reads the current branch by default; `at(branchId)` binds the
 * same operations to another branch's file, for a hook that runs on a child
 * and writes its parent's record.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import {
  type BranchId,
  ExtensionContext,
  resolveDataDir,
  writeFileAtomic,
} from "@gent/core/extensions/api"

interface BranchStateStoreInput<A, E> {
  /** Span prefix, e.g. `GoalStore`. */
  readonly name: string
  /** Directory under the data directory that holds one `<branchId>.json` per branch. */
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

  const bind = (branch: Option.Option<BranchId>) => {
    const location = Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const path = yield* Path.Path
      const directory = path.resolve(yield* resolveDataDir(ctx.home), input.directory)
      const branchId = Option.getOrElse(branch, () => ctx.branchId)
      return { directory, file: path.join(directory, `${branchId}.json`) }
    })

    const read = Effect.fn(`${input.name}.read`)(function* () {
      const fs = yield* FileSystem.FileSystem
      const { file } = yield* location
      if (!(yield* fs.exists(file))) return input.empty
      const text = yield* fs.readFileString(file)
      return yield* decode(text).pipe(Effect.mapError((cause) => input.invalid(file, cause)))
    })

    const write = Effect.fn(`${input.name}.write`)(function* (value: A) {
      const fs = yield* FileSystem.FileSystem
      const { directory, file } = yield* location
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* writeFileAtomic(file, encode(value))
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
        const { file } = yield* location
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

  return { ...bind(Option.none()), at: (branchId: BranchId) => bind(Option.some(branchId)) }
}
