import { Effect, Schema, FileSystem, Path } from "effect"
import { defineTool } from "../domain/tool.js"
import { FileLockService } from "../domain/file-lock.js"

// Edit Tool Error

export class EditError extends Schema.TaggedErrorClass<EditError>()("EditError", {
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
  replaceAll: Schema.optional(
    Schema.Boolean.annotate({
      description: "Replace all occurrences (default: false)",
    }),
  ),
})

// Edit Tool Result

export const EditResult = Schema.Struct({
  path: Schema.String,
  replacements: Schema.Number,
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

export function detectRedaction(oldString: string, newString: string): string | undefined {
  for (const pattern of REDACTION_PATTERNS) {
    if (pattern.test(newString) && !pattern.test(oldString)) {
      const match = newString.match(pattern)
      return `newString contains redaction placeholder "${match?.[0]}". Provide the full replacement content — do not abbreviate or omit code.`
    }
  }
  return undefined
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

export function findMatch(content: string, oldString: string): MatchResult | undefined {
  // Tier 1: exact
  const exactIdx = content.indexOf(oldString)
  if (exactIdx !== -1) {
    return { strategy: "exact", searchStr: oldString, index: exactIdx }
  }

  // Tier 2: unescape literal \n, \t, \\ in oldString
  const unescaped = unescapeStr(oldString)
  if (unescaped !== oldString) {
    const unescIdx = content.indexOf(unescaped)
    if (unescIdx !== -1) {
      return { strategy: "unescaped", searchStr: unescaped, index: unescIdx }
    }
  }

  // Tier 3: normalize whitespace + unicode in both
  const normContent = normalizeWhitespace(content)
  const normSearch = normalizeWhitespace(unescaped)
  if (normSearch !== unescaped || normContent !== content) {
    const normIdx = normContent.indexOf(normSearch)
    if (normIdx !== -1) {
      // Map back to original content position — find the corresponding range
      // by searching for lines that match after normalization
      const lines = content.split("\n")
      const searchLines = normSearch.split("\n")
      if (searchLines.length > 0) {
        for (let i = 0; i < lines.length; i++) {
          const slice = lines.slice(i, i + searchLines.length)
          if (slice.length === searchLines.length) {
            const normSlice = normalizeWhitespace(slice.join("\n"))
            if (normSlice === normSearch) {
              const matchStr = slice.join("\n")
              const realIdx = content.indexOf(matchStr)
              if (realIdx !== -1) {
                return { strategy: "normalized", searchStr: matchStr, index: realIdx }
              }
            }
          }
        }
      }
    }
  }

  return undefined
}

// Edit Tool

export const EditTool = defineTool({
  name: "edit",
  action: "edit",
  concurrency: "serial",
  description:
    "Edit file by replacing exact string matches. Fails if oldString not found or not unique (unless replaceAll).",
  params: EditParams,
  execute: Effect.fn("EditTool.execute")(function* (params, _ctx) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const fileLock = yield* FileLockService

    const filePath = pathService.resolve(params.path)

    // Redaction check
    const redaction = detectRedaction(params.oldString, params.newString)
    if (redaction !== undefined) {
      return yield* new EditError({ message: redaction, path: filePath })
    }

    return yield* fileLock.withLock(
      filePath,
      Effect.gen(function* () {
        const content = yield* fs.readFileString(filePath).pipe(
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

        if (match === undefined) {
          return yield* new EditError({
            message: "oldString not found in file",
            path: filePath,
          })
        }

        // Use the resolved search string for occurrence counting
        const searchStr = match.searchStr
        const occurrences = content.split(searchStr).length - 1

        if (occurrences > 1 && !replaceAll) {
          return yield* new EditError({
            message: `oldString found ${occurrences} times. Use replaceAll to replace all, or provide more context for unique match.`,
            path: filePath,
          })
        }

        const newContent = replaceAll
          ? content.split(searchStr).join(params.newString)
          : content.replace(searchStr, params.newString)

        yield* fs.writeFileString(filePath, newContent).pipe(
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
          replacements: replaceAll ? occurrences : 1,
        }
      }),
    )
  }),
})
