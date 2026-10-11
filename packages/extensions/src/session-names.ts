/**
 * Session names from text: the title a session takes from its first message
 * (`sessionTitleOf`) and the shorter name a child session takes from its
 * start (`childSessionName`). Session tools, threads and delegate children
 * all name sessions by these rules.
 */
import { Option } from "effect"
import { DEFAULT_SESSION_NAME, headChars } from "@gent/core/extensions/api"

/** A code fence: three or more backticks or tildes at the start of a trimmed line. */
const FENCE = /^(?:`{3,}|~{3,})/
/** Markdown that opens a line: a heading, a quote, a list bullet, a rule, emphasis. */
const LEADING_MARKERS = /^(?:(?:#{1,6}|[-*+]|[-*_]{3,})(?=\s|$)|\*\*|__|>)\s*/
const TRAILING_EMPHASIS = /\s*(?:\*\*|__)$/

/** A line with its markdown markers taken off both ends. */
const plainWords = (line: string): string => {
  let words = line
  let previous = ""
  while (words !== previous) {
    previous = words
    words = words.replace(LEADING_MARKERS, "").replace(TRAILING_EMPHASIS, "")
  }
  return words.trim()
}

/**
 * The first plain words of `text`: the first line with words on it once its
 * markdown markers are off. A fenced block, as an `@file` reference expands
 * to, is skipped. Only a fence of the opener's character, as long or longer,
 * closes it, so a shorter fence inside is block text. Words after the closing
 * fence count: the TUI writes the user's next words on that line.
 */
export const sessionTitleOf = (text: string): Option.Option<string> => {
  let opener = Option.none<string>()
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    const fence = Option.map(Option.fromNullishOr(FENCE.exec(line)), (found) => found[0])
    let rest = line
    if (Option.isNone(opener)) {
      if (Option.isSome(fence)) {
        opener = fence
        continue
      }
    } else {
      const open = opener.value
      if (Option.isNone(fence)) continue
      if (fence.value[0] !== open[0] || fence.value.length < open.length) continue
      opener = Option.none()
      rest = line.slice(fence.value.length)
    }
    const words = plainWords(rest)
    if (words.length > 0) return Option.some(words)
  }
  return Option.none()
}

/** A child session's name from its prompt keeps at most this many units, as the TUI's head keeps a name. */
const maximumDerivedChildNameChars = 32

/** A child session's name given by its start keeps at most this many units. */
const maximumGivenChildNameChars = 80

/** Where a prompt's first clause ends: a bracket, a `;`, a sentence end, a spaced dash. */
const CLAUSE_END = /\s*(?:[([;]|[.!?](?:\s|$)|\s[-–—]\s)/u

/** `text` cut to whole words within `max` units; a first word longer than that is cut by code point. */
const wholeWords = (text: string, max: number): string => {
  if (text.length <= max) return text
  let kept = ""
  for (const word of text.split(" ")) {
    let next = `${kept} ${word}`
    if (kept.length === 0) next = word
    if (next.length > max - 1) break
    kept = next
  }
  if (kept.length === 0) kept = headChars(text, max - 1)
  return `${kept.replace(/[\s,:]+$/u, "")}…`
}

/**
 * The name of a child session (a delegate child or a thread), which the
 * tray, the sessions pane and its result row head with: the start's own
 * `name` on one line, else its prompt's first clause in whole words
 * (`Check the greeting files`), else its whole first line in whole words.
 * Never the default name: that name marks a session its first message still
 * names (`nameFromFirstMessage`), so a child named it would lose its name
 * after its first turn. None when no candidate is left; the caller names
 * its own fallback.
 */
export const childSessionName = (start: {
  readonly name: Option.Option<string>
  readonly prompt: string
}): Option.Option<string> => {
  const named = (value: string) =>
    Option.liftPredicate(value, (name) => name !== DEFAULT_SESSION_NAME)
  const given = start.name.pipe(
    Option.map((value) => value.replace(/\s+/gu, " ").trim()),
    Option.filter((value) => value.length > 0),
    Option.flatMap((value) => named(wholeWords(value, maximumGivenChildNameChars))),
  )
  if (Option.isSome(given)) return given
  return Option.flatMap(sessionTitleOf(start.prompt), (title) => {
    const clause = Option.getOrElse(
      Option.filter(
        Option.fromUndefinedOr(title.split(CLAUSE_END)[0]?.trim()),
        (value) => value.length > 0,
      ),
      () => title,
    )
    return Option.orElse(named(wholeWords(clause, maximumDerivedChildNameChars)), () =>
      named(wholeWords(title, maximumDerivedChildNameChars)),
    )
  })
}
