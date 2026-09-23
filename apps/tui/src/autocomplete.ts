import { Effect, FileSystem, Option, Path, Schema, Semaphore } from "effect"
import { writeFileAtomic } from "@gent/core/host"
import type { AutocompleteItem } from "./extensions/client-facets.js"

// ── autocomplete frecency model ─────────────────────────────────────────────

/**
 * Frecency for the composer's autocomplete rows — how often a row was picked,
 * and how recently, folded into one number the ranker can add to its score.
 *
 * The subsequence scorer alone cannot separate two candidates that match the
 * filter equally well. At one typed character `$t` scores `tdd` 12.760 and
 * `test` 12.680: both earn a boundary hit and an isolated hit, and the only
 * thing between them is the length charge, 0.08 per character. The reader who
 * picks `test` every day still gets `tdd` under the cursor. The same tie puts
 * `think` permanently ahead of `thread` for `/t`, and `pr` ahead of
 * `prototype` for `$p`.
 *
 * What breaks the tie is evidence: which row this reader actually chose. That
 * evidence has to fade, or a burst of picks in one afternoon outranks a habit
 * formed over months — so a pick's weight halves every {@link HALF_LIFE_MS}.
 *
 * This module is pure. It computes scores from a store value handed to it and
 * never reads a clock or a disk of its own; the caller supplies `now`, and
 * the frecency store section below owns the file. That is what keeps the
 * ranker unit-testable at a fixed instant.
 *
 * @module
 */

/**
 * A pick's weight halves every two weeks.
 *
 * Short enough that a habit abandoned last month stops steering the popup —
 * at 90 days a pick retains 1.3% of its weight — and long enough that a
 * command used a few times a week keeps accumulating rather than decaying to
 * nothing between uses.
 */
export const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Entries kept in the store, oldest-and-faintest pruned past this.
 *
 * A reader accumulates picks across every command and skill they ever choose;
 * without a cap the file grows forever to record rows whose weight rounded
 * away years ago.
 */
export const MAX_ENTRIES = 200

/**
 * One row's pick history: how many times, and when it was last chosen.
 *
 * The filter that produced the pick is deliberately *not* stored. Keying
 * frecency by `(query, id)` answers "for this exact query, this pick" — but
 * it means `t`, `te` and `tes` are three unrelated keys, and a
 * reader must re-teach every prefix of a name separately. The tie this fixes
 * appears at one and two characters, where per-query keying has learned
 * nothing yet. Keying by id alone means one pick of `test` lifts `test` for
 * every filter that matches it, which is the behaviour actually wanted.
 */
const FrecencyEntry = Schema.Struct({
  count: Schema.Finite,
  lastAt: Schema.Finite,
})

/**
 * The persisted store: a map from `prefix + id` to that row's history.
 *
 * The prefix is part of the key so a `/model` command and a hypothetical
 * `$model` skill never share a count.
 */
const FrecencyStore = Schema.Struct({
  entries: Schema.Record(Schema.String, FrecencyEntry),
})

export type FrecencyStoreValue = typeof FrecencyStore.Type

/** An empty store — what a missing, unreadable or corrupt file degrades to. */
export const emptyFrecencyStore = (): FrecencyStoreValue => ({ entries: {} })

/** The store key for a row, namespaced by the prefix that offered it. */
const frecencyKey = (prefix: string, id: string): string => `${prefix}${id}`

/**
 * The decayed weight of an entry at `now`.
 *
 * Every pick contributed 1 at the moment it happened, and the whole entry
 * decays together from its last use. Exact decay per pick would need the full
 * timestamp list; decaying the running count from `lastAt` approximates it
 * closely enough to order rows, and costs two numbers per row instead of an
 * unbounded array.
 *
 * A future `lastAt` — a clock that moved backwards, an edited file — is
 * clamped to no decay rather than amplified into a huge score.
 */
export const decayedWeight = (entry: typeof FrecencyEntry.Type, now: number): number => {
  const age = Math.max(0, now - entry.lastAt)
  return entry.count * Math.pow(0.5, age / HALF_LIFE_MS)
}

/**
 * Records a pick of `id` under `prefix`, returning the next store value.
 *
 * The existing count is decayed to `now` before the new pick is added, so the
 * stored number is always "weight as of `lastAt`" and never an undecayed
 * lifetime total that recency can no longer touch.
 *
 * Pruning drops the faintest rows once the store passes {@link MAX_ENTRIES}.
 * The row just picked is always kept, whatever its weight: a reader whose
 * store is full of equally-weighted rows would otherwise see their newest
 * pick tie with every one of them and fall outside the cut on an arbitrary
 * sort order — recording a pick that changes nothing.
 */
export const recordPick = (
  store: FrecencyStoreValue,
  prefix: string,
  id: string,
  now: number,
): FrecencyStoreValue => {
  const key = frecencyKey(prefix, id)
  const previous = Option.match(Option.fromNullishOr(store.entries[key]), {
    onNone: () => 0,
    onSome: (entry) => decayedWeight(entry, now),
  })
  const next = {
    ...store.entries,
    [key]: { count: previous + 1, lastAt: now },
  } satisfies Record<string, typeof FrecencyEntry.Type>

  const keys = Object.keys(next)
  if (keys.length <= MAX_ENTRIES) return { entries: next }

  const weigh = (entryKey: string): number =>
    Option.match(Option.fromNullishOr(next[entryKey]), {
      onNone: () => 0,
      onSome: (entry) => decayedWeight(entry, now),
    })

  const lastAt = (entryKey: string): number =>
    Option.match(Option.fromNullishOr(next[entryKey]), {
      onNone: () => 0,
      onSome: (entry) => entry.lastAt,
    })

  const kept = keys
    .filter((entryKey) => entryKey !== key)
    .map((entryKey) => ({ key: entryKey, weight: weigh(entryKey), lastAt: lastAt(entryKey) }))
    .sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight
      return right.lastAt - left.lastAt
    })
    .slice(0, MAX_ENTRIES - 1)

  const pruned = {
    [key]: { count: previous + 1, lastAt: now },
  } satisfies Record<string, typeof FrecencyEntry.Type>
  const out: typeof pruned = pruned
  for (const entry of kept) {
    const value = Option.fromNullishOr(next[entry.key])
    if (Option.isNone(value)) continue
    out[entry.key] = value.value
  }
  return { entries: out }
}

/**
 * A reader's pick history, as the ranker consumes it: prefix plus id in, a
 * decayed weight out, with `now` already fixed.
 *
 * This is the read-only face of the store. The ranker never sees the file, the
 * clock, or the write path — only this function — which is what lets a test
 * rank against an invented history at a chosen instant.
 */
export type FrecencyLookup = (prefix: string, id: string) => number

/** The lookup that knows nothing: what ranking falls back to with no store. */
export const noFrecency: FrecencyLookup = () => 0

/** Builds a {@link FrecencyLookup} reading `store` as of `now`. */
export const frecencyLookup =
  (store: FrecencyStoreValue, now: number): FrecencyLookup =>
  (prefix, id) =>
    Option.match(Option.fromNullishOr(store.entries[frecencyKey(prefix, id)]), {
      onNone: () => 0,
      onSome: (entry) => decayedWeight(entry, now),
    })

// ── frecency store ──────────────────────────────────────────────────────────

/**
 * Persistence for autocomplete frecency — the impure edge around the pure
 * ranker above.
 *
 * Shaped after `usePromptHistory` in `session.tsx`, which has the same needs: a
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
    // A reader sees the whole previous store or the whole new one, never
    // half-written JSON. Each write stages its own uniquely named temp file,
    // so a second `gent` writing at the same instant races, never corrupts.
    yield* writeFileAtomic(paths.file, encodeStore(store))
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
let frecencyStoreSnapshot: FrecencyStoreValue = emptyFrecencyStore()

/** The store as last read or written by this process. Never awaits. */
export const frecencySnapshot = (): FrecencyStoreValue => frecencyStoreSnapshot

/** Replaces the snapshot — the load path's way of seeding it. */
export const setFrecencySnapshot = (value: FrecencyStoreValue): void => {
  frecencyStoreSnapshot = value
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
    frecencyStoreSnapshot = emptyFrecencyStore()
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
    frecencyStoreSnapshot = next
    return next
  }).pipe(writeGate.withPermits(1))

// ── autocomplete ranking ────────────────────────────────────────────────────

/**
 * Relevance ranking for the composer's autocomplete rows, and the completion
 * the ghost line offers.
 *
 * Three prefixes feed the popup and they did not agree on what "best match"
 * meant. `/` commands and `$` skills were merely filtered by
 * `String.includes` and left in registration order. That is why
 * `/ag` listed `/fork` first: "Fork from Mess**ag**e" contains the filter, and
 * it registers before `/agents`. A reader who typed the first two letters of
 * the command they wanted got a different command under the cursor.
 *
 * The matcher here is a subsequence scorer in the fzy tradition, written out
 * rather than taken from a package: it costs no dependency, and a general
 * string ranker gets this corpus wrong in a way that matters. A ranker that
 * weighs descriptions alongside names answers `ag` with `/agents` *and* three
 * commands whose descriptions happen to contain those letters. In a list that
 * is noise; under a ghost line it is a wrong suggestion, because the ghost
 * shows the top candidate alone.
 *
 * The scoring rewards what makes a match feel intentional — letters that run
 * together, and letters that start a word — and charges for what makes it feel
 * accidental: gaps between matched letters, and length. A name outranks a
 * description by a wide margin for the same reason.
 *
 * Match quality alone leaves ties it cannot break. At one typed character
 * `$t` separates `tdd` from `test` by 0.08 — one character of length charge —
 * and the reader who picks `test` daily still finds `tdd` under the cursor.
 * So a caller may supply the reader's own pick history, and a row that has
 * been chosen before earns a bounded bonus on top of its match score. Bounded
 * is the operative word: see {@link FRECENCY_MAX}.
 *
 * All three prefixes route through this: `/` commands, `$` skills and `@`
 * files, each with its own frecency prefix.
 *
 * @module
 */

/** Characters that begin a new word, so a match just after one reads as deliberate. */
const WORD_BOUNDARY = new Set(["/", "-", "_", ".", ":", " "])

/** A miss. Any real match scores above this, so callers test `> NO_MATCH`. */
const NO_MATCH = -1

/** Points for a letter that continues an unbroken run, before the run bonus. */
const CONSECUTIVE_BASE = 10
/** Added per letter of the current run, so longer runs pull away from scattered hits. */
const CONSECUTIVE_STREAK = 5
/** Points for a letter that merely appears later in the haystack. */
const ISOLATED = 1
/** Points for a letter that starts the haystack or follows a word boundary. */
const BOUNDARY = 12
/** Charged per skipped character, so near matches beat distant ones. */
const GAP = 0.7
/** Charged per character of the haystack, breaking ties toward shorter names. */
const LENGTH = 0.08
/**
 * Charged against a description match. Wide enough that no description can
 * outrank a name: it is what keeps `ag` from answering with every command
 * whose summary happens to contain those letters.
 */
const DESCRIPTION_PENALTY = 12
/**
 * The most a pick history can add to a row's score.
 *
 * Sized deliberately below {@link BOUNDARY}. A row that matches the filter at
 * a word boundary earns 12 points that no amount of history can make up, so
 * frecency can only reorder rows the matcher already considers comparable —
 * which is exactly the tie it exists to break. Raise this above 12 and a
 * stale favourite starts jumping ahead of the row the reader is spelling out,
 * which is the failure mode this whole feature has to avoid.
 */
const FRECENCY_MAX = 8
/**
 * How fast the bonus approaches {@link FRECENCY_MAX} as picks accumulate.
 *
 * The curve is logarithmic, so the first pick buys most of the benefit and the
 * fiftieth buys almost none. That is the right shape: the point is to separate
 * "chosen before" from "never chosen", not to let a hundred picks of one row
 * bury everything else.
 */
const FRECENCY_GROWTH = 1.6
/**
 * The shortest filter that may be reordered by pick history.
 *
 * At one or two characters the matcher's own separation is already thinner
 * than its tie-breaks — `$t` splits `tdd` from `test` by 0.08, one character
 * of length charge — so a single past pick decides the row under the cursor
 * for a filter that names almost nothing. That is the wrong moment to be
 * confident: the reader who types `t` has not said which `t` they mean, and a
 * favourite that jumps to the top there is harder to get past than a
 * mis-ranked list, because the ghost line offers it too.
 *
 * Three characters is where the subsequence score starts carrying real
 * signal, and it is the length at which ranking was verified live. Below it
 * rows rank purely on match quality, exactly as they did before frecency.
 */
const FRECENCY_MIN_FILTER = 3

/**
 * The score bonus for a row with decayed pick weight `weight`.
 *
 * Zero weight yields exactly zero, so a reader with no history — or a store
 * that failed to load — ranks precisely as they did before frecency existed.
 */
export const frecencyBonus = (weight: number): number => {
  if (weight <= 0) return 0
  return FRECENCY_MAX * (1 - Math.pow(2, -weight / FRECENCY_GROWTH))
}

/**
 * Scores `needle` against `haystack`, or {@link NO_MATCH} when the needle is
 * not a subsequence of it.
 *
 * Matching is case-insensitive and greedy left to right: each letter is found
 * at or after the previous match. Greedy is not optimal — it can miss a better
 * alignment further right — but on names of a few words it agrees with the
 * optimal alignment, and it costs one pass instead of a matrix.
 */
export const scoreSubsequence = (needle: string, haystack: string): number => {
  const lowerNeedle = needle.toLowerCase()
  const lowerHaystack = haystack.toLowerCase()
  if (lowerNeedle.length === 0) return 0

  let from = 0
  let total = 0
  let streak = 0

  for (let index = 0; index < lowerNeedle.length; index++) {
    const found = lowerHaystack.indexOf(lowerNeedle.charAt(index), from)
    if (found === -1) return NO_MATCH

    if (found === from && index > 0) {
      streak += 1
      total += CONSECUTIVE_BASE + streak * CONSECUTIVE_STREAK
    } else {
      streak = 0
      total += ISOLATED
    }

    if (found === 0 || WORD_BOUNDARY.has(lowerHaystack.charAt(found - 1))) total += BOUNDARY
    total -= (found - from) * GAP
    from = found + 1
  }

  return total - lowerHaystack.length * LENGTH
}

/** The best score an item can claim, across its id, its label, and its description. */
const scoreItem = (item: AutocompleteItem, filter: string): number => {
  const description = Option.getOrElse(Option.fromNullishOr(item.description), () => "")
  const descriptionScore = Option.match(
    Option.liftPredicate(description, (d) => d.length > 0),
    {
      onNone: () => NO_MATCH,
      onSome: (d) => scoreSubsequence(filter, d) - DESCRIPTION_PENALTY,
    },
  )
  return Math.max(
    scoreSubsequence(filter, item.id),
    scoreSubsequence(filter, item.label),
    descriptionScore,
  )
}

/**
 * How a caller opts into pick history.
 *
 * Both fields are optional and default to "no history", so every existing call
 * site keeps ranking purely by match quality.
 */
interface RankOptions {
  /** The prefix the rows were offered under, namespacing the store keys. */
  readonly prefix?: string
  /** The reader's decayed pick weights, already fixed at an instant. */
  readonly frecency?: FrecencyLookup
}

/**
 * Orders `items` by how well they match `filter`, best first, dropping the
 * ones the filter does not appear in at all.
 *
 * An empty filter is not a ranking question — every item matches equally — so
 * the caller's own order is preserved untouched. Ties keep their input order,
 * which is what makes the result stable as a reader types.
 */
export const rankAutocompleteItems = (
  items: ReadonlyArray<AutocompleteItem>,
  filter: string,
  options: RankOptions = {},
): ReadonlyArray<AutocompleteItem> => {
  if (filter.length === 0) return items

  const prefix = Option.getOrElse(Option.fromNullishOr(options.prefix), () => "")
  // Short filters rank on match quality alone — see FRECENCY_MIN_FILTER.
  const supplied = Option.getOrElse(Option.fromNullishOr(options.frecency), () => noFrecency)
  const lookup = Option.getOrElse(
    Option.liftPredicate(supplied, () => filter.length >= FRECENCY_MIN_FILTER),
    () => noFrecency,
  )

  const scored: Array<{
    readonly item: AutocompleteItem
    readonly score: number
    readonly index: number
  }> = []
  for (const [index, item] of items.entries()) {
    const matchScore = scoreItem(item, filter)
    if (matchScore <= NO_MATCH) continue
    // Frecency lifts a row the reader has chosen before, but only among rows
    // the matcher already admitted: a row the filter does not match is not
    // rescued by history.
    const score = matchScore + frecencyBonus(lookup(prefix, item.id))
    scored.push({ item, score, index })
  }

  return scored
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return left.index - right.index
    })
    .map((entry) => entry.item)
}

/**
 * The completion the ghost line offers for `filter`, given the top-ranked row.
 *
 * A ghost is an offer to finish the word being typed, so it is only honest
 * when the best row actually *starts* with that word. Subsequence ranking does
 * not promise that: `mdl` can rank `model` first on a scattered match, and
 * there is no single "rest of the word" to append — the popup alone reports
 * that kind of match. So a candidate that does not extend the filter yields
 * nothing.
 *
 * Matching ignores case, but the text comes from the candidate, so completing
 * `/AG` offers `agents` and Tab inserts the canonical spelling.
 */
export const ghostCompletion = (
  candidate: Option.Option<AutocompleteItem>,
  filter: string,
): Option.Option<string> => {
  if (filter.length === 0) return Option.none()
  return Option.flatMap(candidate, (item) => {
    if (item.id.length <= filter.length) return Option.none()
    if (!item.id.toLowerCase().startsWith(filter.toLowerCase())) return Option.none()
    return Option.some(item.id)
  })
}
