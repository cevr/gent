/**
 * Persistence for autocomplete frecency — the impure edge around
 * `autocomplete-frecency.ts`.
 *
 * Shaped after `use-prompt-history.ts`, which solved the same problem first: a
 * `Schema.Struct` encoded with `Schema.fromJsonString`, a path under
 * `~/.cache/gent/`, a read that answers `Option.none()` for anything it cannot
 * use, and a write that ends in `Effect.ignoreCause`. Following it rather than
 * inventing a second convention means one place to look for "where does the
 * TUI keep per-reader state".
 *
 * Degrading is the whole contract of the read. A missing file is a new reader,
 * an empty file is an interrupted write, and unparseable content is a file
 * someone edited or a format that changed. None of those are worth failing a
 * popup over: all three answer `Option.none()` and ranking proceeds on the
 * subsequence score alone, exactly as it did before frecency existed.
 *
 * @module
 */

import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { FrecencyStore, type FrecencyStoreValue } from "./autocomplete-frecency"

const decodeStore = Schema.decodeUnknownOption(Schema.fromJsonString(FrecencyStore))
const encodeStore = Schema.encodeSync(Schema.fromJsonString(FrecencyStore))

/** Where the store lives, derived from the home the shell mounted with. */
export const frecencyPaths = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = path.join(home, ".cache", "gent")
    return { directory, file: path.join(directory, "autocomplete-frecency.json") }
  })

/**
 * Absent for no file, unreadable content, or bad JSON — ranking starts fresh.
 *
 * The `orElseSucceed` catches the cases `exists` cannot predict: a permissions
 * failure, a directory where the file should be, a read that races a write.
 */
export const readFrecencyStore = (
  home: string,
): Effect.Effect<Option.Option<FrecencyStoreValue>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* frecencyPaths(home)
    const exists = yield* fs.exists(paths.file)
    if (!exists) return Option.none<FrecencyStoreValue>()
    const text = yield* fs.readFileString(paths.file)
    if (text.length === 0) return Option.none<FrecencyStoreValue>()
    return decodeStore(text)
  }).pipe(Effect.orElseSucceed(() => Option.none<FrecencyStoreValue>()))

/**
 * Writes the store, swallowing every failure.
 *
 * A pick is a side effect of a keystroke. Losing one to a full disk is
 * invisible and harmless; surfacing it would interrupt the reader mid-word.
 */
export const writeFrecencyStore = (
  home: string,
  store: FrecencyStoreValue,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* frecencyPaths(home)
    yield* fs.makeDirectory(paths.directory, { recursive: true })
    yield* fs.writeFileString(paths.file, encodeStore(store))
  }).pipe(Effect.ignoreCause)
