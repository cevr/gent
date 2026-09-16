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

import { Effect, FileSystem, Option, Path, Schema, Semaphore } from "effect"
import {
  FrecencyStore,
  emptyFrecencyStore,
  recordPick,
  type FrecencyStoreValue,
} from "./autocomplete-frecency"

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
    // Write beside the target, then rename onto it. `rename` within one
    // directory is atomic on every filesystem the TUI runs on, so a reader
    // opening the file sees either the whole previous store or the whole new
    // one — never the half-written JSON that a direct overwrite exposes. The
    // pid names the temp file because a second `gent` may be writing its own
    // at the same instant, and two writers sharing one temp path would
    // corrupt each other rather than merely race.
    const temp = `${paths.file}.${process.pid}.tmp`
    yield* fs.writeFileString(temp, encodeStore(store))
    yield* Effect.onError(fs.rename(temp, paths.file), () =>
      fs.remove(temp, { force: true }).pipe(Effect.ignoreCause),
    )
  }).pipe(Effect.ignoreCause)

/**
 * Serializes the read-modify-write below.
 *
 * Two surfaces record picks — the `/` commands registry and the `$` skills
 * extension — and before this gate they wrote by different strategies. `$`
 * re-read the file every time; `/` serialized a snapshot the module had
 * loaded once and never refreshed. So a `$` pick that landed after that load
 * was invisible to the `/` writer, and the next `/` pick wrote the stale
 * snapshot back over the file. Every `$` pick was erased by the next `/`
 * pick, and the reverse order lost the `/` pick the same way.
 *
 * One permit means the file is read, folded and written as one step with no
 * other pick interleaved. It is a module singleton because the thing it
 * protects is a single path on disk, not a value any one caller owns.
 *
 * Its reach is this process. Two `gent` processes sharing a home each hold
 * their own gate, so a pick from one can still be lost to a pick from the
 * other — the write is not atomic against an outside writer. That is the
 * pre-existing exposure, unchanged and untested here; what this closes is the
 * cross-surface loss inside one TUI, which is the one a reader hits, because
 * a reader uses `/` and `$` in the same session.
 */
const writeGate = Semaphore.makeUnsafe(1)

/**
 * The store as this process last saw it, for callers that must rank without
 * awaiting.
 *
 * Ranking runs inside the popup's resource callback and cannot await a file
 * read while the reader types, so it reads this snapshot synchronously. Every
 * recorded pick refreshes it, which is what lets a pick made in this session
 * steer the very next keystroke.
 */
let snapshot: FrecencyStoreValue = emptyFrecencyStore()

/** The store as last read or written by this process. Never awaits. */
export const frecencySnapshot = (): FrecencyStoreValue => snapshot

/** Replaces the snapshot — the load path's way of seeding it. */
export const setFrecencySnapshot = (value: FrecencyStoreValue): void => {
  snapshot = value
}

/**
 * Forgets every pick, on disk and in memory.
 *
 * Ranking has no other escape hatch: a store that learned the wrong row keeps
 * offering it, and the weights only halve every two weeks. Deleting the file
 * by hand works but leaves this process ranking from the snapshot it already
 * holds, so the clear has to happen on both sides of the gate — inside it, so
 * a concurrent pick cannot interleave and re-create what was just removed.
 *
 * Removing the file rather than writing an empty store keeps "never picked
 * anything" and "picked then cleared" the same state, which is what the read
 * path already degrades to.
 */
export const clearFrecencyStore = (
  home: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* frecencyPaths(home)
    yield* fs.remove(paths.file, { force: true })
    snapshot = emptyFrecencyStore()
  }).pipe(Effect.ignoreCause, writeGate.withPermits(1))

/**
 * Records a pick against the file, folding it into whatever is on disk.
 *
 * This is the only write. A caller hands over the prefix and the id and gets
 * back the store that was written, so an in-memory reader can refresh from the
 * same value the file now holds rather than from a guess.
 *
 * Reading inside the gate is the point. The alternative — folding into a
 * cached value — is what lost picks: the cache goes stale the moment another
 * surface writes, and nothing tells it so.
 */
export const recordFrecencyPick = (
  home: string,
  prefix: string,
  id: string,
  now: number,
): Effect.Effect<FrecencyStoreValue, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const current = yield* readFrecencyStore(home)
    const next = recordPick(
      Option.getOrElse(current, () => emptyFrecencyStore()),
      prefix,
      id,
      now,
    )
    yield* writeFrecencyStore(home, next)
    snapshot = next
    return next
  }).pipe(writeGate.withPermits(1))
