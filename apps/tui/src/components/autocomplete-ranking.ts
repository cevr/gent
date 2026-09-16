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
 * `@` is deliberately not routed through this. FFF ranks files better than a
 * string matcher can, because it knows which files this reader actually opens.
 *
 * @module
 */

import { Option } from "effect"
import type { AutocompleteItem } from "../extensions/client-facets.js"

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
): ReadonlyArray<AutocompleteItem> => {
  if (filter.length === 0) return items

  const scored: Array<{
    readonly item: AutocompleteItem
    readonly score: number
    readonly index: number
  }> = []
  for (const [index, item] of items.entries()) {
    const score = scoreItem(item, filter)
    if (score <= NO_MATCH) continue
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
