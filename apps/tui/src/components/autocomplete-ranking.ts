/**
 * Relevance ranking for the composer's autocomplete rows, and the completion
 * the ghost line offers.
 *
 * Three prefixes feed the popup and they did not agree on what "best match"
 * meant. `@` files were already ranked — FFF scores them by fuzzy distance,
 * filename hits and frecency — while `/` commands and `$` skills were merely
 * filtered by `String.includes` and left in registration order. That is why
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
 * `@` is deliberately not routed through this. FFF ranks files better than a
 * string matcher can, because it knows which files this reader actually opens
 * — it already keeps its own frecency, and a second layer on top would fight
 * it rather than help.
 *
 * @module
 */

import { Option } from "effect"
import type { AutocompleteItem } from "../extensions/client-facets.js"
import { noFrecency, type FrecencyLookup } from "./autocomplete-frecency"

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
export interface RankOptions {
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
  const lookup = Option.getOrElse(Option.fromNullishOr(options.frecency), () => noFrecency)

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
