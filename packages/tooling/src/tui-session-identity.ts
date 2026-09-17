/**
 * Guard: a reactive effect must not track the whole session record.
 *
 * `transitionSessionState` rebuilds the `Session` object for `UpdateName` and
 * `UpdateSettings`, so a rename or a `/model` change hands every reader a new
 * object carrying the same ids. An effect that tracks the record restarts for
 * a change it does not care about: the child-session tracker lost its fiber and
 * every projected row, the extension resources blanked and round-tripped, and
 * the slash-command list cleared for the duration of an RPC. One reducer
 * produced four defects that way.
 *
 * The client answers "which session" once, with `sessionIdentity()` and
 * `activeSessionId()` — memos with an equivalence on the ids. Anything that
 * reacts to the session rather than displays it reads those.
 *
 * What is reported: a `.session()` read inside a `createEffect`, a
 * `createMemo`, a `createResource` or an `on(...)` source — the places Solid
 * records a dependency and re-runs on it. A read in a JSX expression, in an
 * event handler, or in a plain accessor is untouched: those want the record,
 * and the name and the model live on the record.
 *
 * `transport.currentSession()` is not reported: it already answers with the
 * identity alone, and `extensions/context.tsx` builds it from the client's
 * `sessionIdentity()` memo.
 *
 * @module
 */

import { Option } from "effect"

export interface TuiSessionIdentityFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const TUI_SOURCE = /^apps\/tui\/src\//

/** Opens a reactive scope: Solid re-runs what follows when its reads change. */
const TRACKING_OPENER = /\b(?:createEffect|createMemo|createResource|on)\(/

/** The record accessor. `sessionIdentity`/`activeSessionId` are the narrowed ones. */
const RECORD_READ = /(?<!current)\.session\(\)/i

/**
 * How far a reactive scope is followed. Long enough for the dependency list and
 * the head of the body this codebase writes, short enough that a later callback
 * in the same function is not attributed to the effect.
 */
const SCOPE_LINES = 12

export const findTuiSessionIdentityReads = (
  file: string,
  text: string,
): ReadonlyArray<TuiSessionIdentityFinding> => {
  if (!TUI_SOURCE.test(file)) return []

  const lines = text.split("\n")
  const reported = new Set<number>()
  const findings: TuiSessionIdentityFinding[] = []
  for (const [index, line] of lines.entries()) {
    if (!TRACKING_OPENER.test(line)) continue
    const openerIndent = line.length - line.trimStart().length
    const limit = Math.min(index + 1 + SCOPE_LINES, lines.length)
    for (let cursor = index; cursor < limit; cursor += 1) {
      const candidate = Option.getOrElse(Option.fromNullishOr(lines[cursor]), () => "")
      const trimmed = candidate.trim()
      // The scope closes when the nesting returns to the opener's column.
      if (cursor > index && trimmed.length > 0) {
        const indent = candidate.length - candidate.trimStart().length
        if (indent <= openerIndent && !TRACKING_OPENER.test(candidate)) break
      }
      if (!RECORD_READ.test(candidate)) continue
      if (reported.has(cursor)) break
      reported.add(cursor)
      findings.push({
        file,
        line: cursor + 1,
        message:
          "this reactive scope reads the whole session record, so a rename or a model change re-runs it -- read `sessionIdentity()` or `activeSessionId()`, which move only when the session or the branch does",
      })
      break
    }
  }
  return findings
}
