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
 * `autocomplete-frecency-store.ts` owns the file. That is what keeps the
 * ranker unit-testable at a fixed instant.
 *
 * @module
 */

import { Option, Schema } from "effect"

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
 * The filter that produced the pick is deliberately *not* stored. FFF keys its
 * own frecency by `(query, path)`, which answers "for this exact query, this
 * pick" — but it means `t`, `te` and `tes` are three unrelated keys, and a
 * reader must re-teach every prefix of a name separately. The tie this fixes
 * appears at one and two characters, where per-query keying has learned
 * nothing yet. Keying by id alone means one pick of `test` lifts `test` for
 * every filter that matches it, which is the behaviour actually wanted.
 */
export const FrecencyEntry = Schema.Struct({
  count: Schema.Finite,
  lastAt: Schema.Finite,
})

/**
 * The persisted store: a map from `prefix + id` to that row's history.
 *
 * The prefix is part of the key so a `/model` command and a hypothetical
 * `$model` skill never share a count.
 */
export const FrecencyStore = Schema.Struct({
  entries: Schema.Record(Schema.String, FrecencyEntry),
})

export type FrecencyStoreValue = typeof FrecencyStore.Type

/** An empty store — what a missing, unreadable or corrupt file degrades to. */
export const emptyFrecencyStore = (): FrecencyStoreValue => ({ entries: {} })

/** The store key for a row, namespaced by the prefix that offered it. */
export const frecencyKey = (prefix: string, id: string): string => `${prefix}${id}`

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
