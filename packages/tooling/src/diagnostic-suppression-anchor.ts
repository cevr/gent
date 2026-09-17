/**
 * Guard: a next-line diagnostic suppression must sit above the code it covers.
 *
 * `// @effect-diagnostics-next-line <rule>:off` silences the rule on the line
 * directly below it and nowhere else. When a formatter re-wraps an expression,
 * or an edit inserts a line, the comment can end up above a blank line or
 * above the tail of the statement before it. The suppression then covers
 * nothing: the diagnostic it was written for comes back somewhere further
 * down, and the comment stays as a claim that it is handled.
 *
 * Only the `-next-line` form is read. The file-scoped
 * `// @effect-diagnostics <rule>:off` applies to the whole file, so no line
 * follows it in the sense this guard checks.
 *
 * The typechecker does report a detached suppression, and the turbo task hashes
 * these files by content, so a reformat is a cache miss and the next typecheck
 * sees it. What that run cannot do is come before the formatter: a typecheck
 * that already finished is not re-run by a later reformat in the same sitting.
 * This guard is cheap enough to run first, which is where the hook puts it.
 *
 * What is reported: a `-next-line` comment whose following line cannot carry a
 * diagnostic, which is one of four shapes, plus the comment on the last line
 * of a file, where nothing follows it at all:
 *
 * - a blank line, which a formatter or an edit left between the two;
 * - closing punctuation alone -- `)`, `}`, `]`, and any run of those with a
 *   trailing comma or semicolon -- which ends a statement that opened earlier,
 *   so the expression the comment meant to cover begins above it;
 * - a bare `.pipe(` continuation, which is the tail of the expression above;
 * - a second suppression comment, which pushes the first one two lines away
 *   from any code.
 *
 * A line holding real code is never reported. Which diagnostic the rule name
 * refers to, and whether it would fire, is the typechecker's question; this
 * guard only asks whether the comment is attached to anything.
 *
 * @module
 */

import { Option } from "effect"

/** A next-line suppression that no line of code follows. */
export interface DiagnosticSuppressionAnchorFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/** Source this guard reads. The suppressions live in shipped code and tests. */
const SOURCE = /\.[cm]?[jt]sx?$/

/**
 * This guard and its test, which have to spell the marker to match it and to
 * build the detached shapes the test asserts on. Reading them would report the
 * description of the rule as a violation of it.
 */
const SELF = new Set([
  "packages/tooling/src/diagnostic-suppression-anchor.ts",
  "packages/tooling/tests/diagnostic-suppression-anchor.test.ts",
])

/** The line-scoped form. The file-scoped `@effect-diagnostics` has no anchor. */
const NEXT_LINE_SUPPRESSION = /@effect-diagnostics-next-line\b/

/** Closing punctuation that ends a statement opened on an earlier line. */
const CLOSERS_ONLY = /^[)}\]]+[,;]?$/

/** The tail of a pipeline that began above, so the comment trails its subject. */
const BARE_PIPE = /^\.pipe\($/

/** Why the following line cannot carry the diagnostic, or none if it can. */
const detachmentReason = (next: string): Option.Option<string> => {
  const trimmed = next.trim()
  if (trimmed.length === 0) return Option.some("a blank line")
  if (NEXT_LINE_SUPPRESSION.test(trimmed)) return Option.some("a second suppression comment")
  if (CLOSERS_ONLY.test(trimmed)) return Option.some(`closing punctuation alone (\`${trimmed}\`)`)
  if (BARE_PIPE.test(trimmed)) return Option.some("a bare `.pipe(` continuation")
  return Option.none()
}

export const findDiagnosticSuppressionAnchors = (
  file: string,
  text: string,
): ReadonlyArray<DiagnosticSuppressionAnchorFinding> => {
  if (!SOURCE.test(file) || SELF.has(file)) return []

  const lines = text.split("\n")
  const findings: DiagnosticSuppressionAnchorFinding[] = []
  for (const [index, line] of lines.entries()) {
    if (!NEXT_LINE_SUPPRESSION.test(line)) continue
    const next = Option.fromNullishOr(lines[index + 1])
    if (Option.isNone(next)) {
      findings.push({
        file,
        line: index + 1,
        message:
          "this `@effect-diagnostics-next-line` comment ends the file, so it suppresses nothing -- put it directly above the line the diagnostic reports",
      })
      continue
    }
    const reason = detachmentReason(next.value)
    if (Option.isNone(reason)) continue
    findings.push({
      file,
      line: index + 1,
      message: `this \`@effect-diagnostics-next-line\` comment is followed by ${reason.value}, so it suppresses nothing -- put it directly above the line the diagnostic reports, or drop it`,
    })
  }
  return findings
}
