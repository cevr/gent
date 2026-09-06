import { Effect, Option, Schema } from "effect"
import { ExtensionContext, tool } from "@gent/core/extensions/api"

// Edit Tool Error

export class EditError extends Schema.TaggedError<EditError>()("EditError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Edit Tool Params

export const EditParams = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path to file to edit",
  }),
  oldString: Schema.String.annotate({
    description: "Exact string to replace",
  }),
  newString: Schema.String.annotate({
    description: "Replacement string",
  }),
  replaceAll: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Replace all occurrences (default: false)",
    }),
  ),
})

// Edit Tool Result

export const EditResult = Schema.Struct({
  path: Schema.String,
  replacements: Schema.Finite,
})

// Redaction detection

const REDACTION_PATTERNS = [
  /\[REDACTED\]/i,
  /\[\.\.\.omitted.*?\]/i,
  /\[rest of .{1,40} unchanged\]/i,
  /\[remaining .{1,40} unchanged\]/i,
  /\/\/ \.\.\.( rest| remaining)? (of )?(the )?(file|code|content|implementation)( remains?)? (unchanged|the same|as before|omitted)/i,
  /\/\/ \.\.\. existing (code|content|implementation)/i,
  /# \.\.\. existing (code|content|implementation)/i,
]

export function detectRedaction(oldString: string, newString: string): Option.Option<string> {
  for (const pattern of REDACTION_PATTERNS) {
    if (pattern.test(newString) && !pattern.test(oldString)) {
      const match = Option.fromNullishOr(newString.match(pattern))
      const placeholder = Option.match(match, {
        onNone: () => "redacted content",
        onSome: (parts) => parts[0],
      })
      return Option.some(
        `newString contains redaction placeholder "${placeholder}". Provide the full replacement content — do not abbreviate or omit code.`,
      )
    }
  }
  return Option.none()
}

// 3-tier fuzzy matching

export function unescapeStr(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\\\/g, "\\")
}

export function normalizeWhitespace(s: string): string {
  return (
    s
      // Trailing whitespace per line
      .replace(/[ \t]+$/gm, "")
      // Unicode quotes → ASCII
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      // Em-dash → hyphen
      .replace(/\u2014/g, "-")
      // NBSP → space
      .replace(/\u00A0/g, " ")
  )
}

export type MatchStrategy = "exact" | "unescaped" | "normalized"

export interface MatchResult {
  strategy: MatchStrategy
  searchStr: string
  index: number
}

const findNormalizedMatch = (content: string, search: string): Option.Option<MatchResult> => {
  const normalizedContent = normalizeWhitespace(content)
  const normalizedSearch = normalizeWhitespace(search)
  if (normalizedSearch === search && normalizedContent === content) return Option.none()
  if (!normalizedContent.includes(normalizedSearch)) return Option.none()

  const lines = content.split("\n")
  const searchLines = normalizedSearch.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const slice = lines.slice(index, index + searchLines.length)
    if (slice.length !== searchLines.length) continue
    const matchString = slice.join("\n")
    if (normalizeWhitespace(matchString) !== normalizedSearch) continue
    const realIndex = content.indexOf(matchString)
    if (realIndex !== -1) {
      return Option.some({ strategy: "normalized", searchStr: matchString, index: realIndex })
    }
  }
  return Option.none()
}

export function findMatch(content: string, oldString: string): Option.Option<MatchResult> {
  // Tier 1: exact
  const exactIdx = content.indexOf(oldString)
  if (exactIdx !== -1) {
    return Option.some({ strategy: "exact", searchStr: oldString, index: exactIdx })
  }

  // Tier 2: unescape literal \n, \t, \\ in oldString
  const unescaped = unescapeStr(oldString)
  if (unescaped !== oldString) {
    const unescIdx = content.indexOf(unescaped)
    if (unescIdx !== -1) {
      return Option.some({ strategy: "unescaped", searchStr: unescaped, index: unescIdx })
    }
  }

  // Tier 3: normalize whitespace + unicode in both
  return findNormalizedMatch(content, unescaped)
}

// Edit Tool

export const EditTool = tool({
  id: "edit",
  destructive: true,
  description:
    "Edit file by replacing exact string matches. Fails if oldString not found or not unique (unless replaceAll).",
  promptSnippet: "Apply targeted edits to existing files",
  promptGuidelines: ["Use for partial changes, not full rewrites", "old_string must match exactly"],
  params: EditParams,
  output: EditResult,
  execute: Effect.fn("EditTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext

    const filePath = ctx.Files.resolve(params.path)

    // Redaction check
    const redaction = detectRedaction(params.oldString, params.newString)
    if (Option.isSome(redaction)) {
      return yield* new EditError({ message: redaction.value, path: filePath })
    }

    return yield* ctx.FileLock.withLock(
      filePath,
      Effect.gen(function* () {
        const content = yield* ctx.Files.read(filePath).pipe(
          Effect.mapError(
            (e) =>
              new EditError({
                message: `Failed to read file: ${e.message}`,
                path: filePath,
                cause: e,
              }),
          ),
        )

        const replaceAll = params.replaceAll === true

        // Try fuzzy match strategy
        const match = findMatch(content, params.oldString)

        if (Option.isNone(match)) {
          return yield* new EditError({
            message: "oldString not found in file",
            path: filePath,
          })
        }

        // Use the resolved search string for occurrence counting
        const searchStr = match.value.searchStr
        const occurrences = content.split(searchStr).length - 1

        if (occurrences > 1 && !replaceAll) {
          return yield* new EditError({
            message: `oldString found ${occurrences} times. Use replaceAll to replace all, or provide more context for unique match.`,
            path: filePath,
          })
        }

        let newContent = content.replace(searchStr, params.newString)
        let replacements = 1
        if (replaceAll) {
          newContent = content.split(searchStr).join(params.newString)
          replacements = occurrences
        }

        yield* ctx.Files.write(filePath, newContent).pipe(
          Effect.mapError(
            (e) =>
              new EditError({
                message: `Failed to write file: ${e.message}`,
                path: filePath,
                cause: e,
              }),
          ),
        )

        return {
          path: filePath,
          replacements,
        }
      }),
    )
  }),
})
