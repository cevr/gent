import { Effect, Option, Schema, FileSystem, Path } from "effect"
import { tool, FileIndex } from "@gent/core/extensions/api"
import { Glob } from "bun"

// Grep Tool Error

export class GrepError extends Schema.TaggedErrorClass<GrepError>()("GrepError", {
  message: Schema.String,
  pattern: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Grep Tool Params

export const GrepParams = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "Regex pattern to search for",
  }),
  path: Schema.optional(
    Schema.String.annotate({
      description: "File or directory to search (default: cwd)",
    }),
  ),
  glob: Schema.optional(
    Schema.String.annotate({
      description: "Glob pattern to filter files (e.g., *.ts)",
    }),
  ),
  caseSensitive: Schema.optional(
    Schema.Boolean.annotate({
      description: "Case sensitive search (default: true)",
    }),
  ),
  context: Schema.optional(
    Schema.Number.annotate({
      description: "Lines of context around matches",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: "Maximum number of matches (default: 100)",
    }),
  ),
})

// Grep Match

export const GrepMatch = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  content: Schema.String,
  context: Schema.optional(
    Schema.Struct({
      before: Schema.Array(Schema.String),
      after: Schema.Array(Schema.String),
    }),
  ),
})

// Grep Tool Result

export const GrepResult = Schema.Struct({
  matches: Schema.Array(GrepMatch),
  truncated: Schema.Boolean,
})

// Grep Tool

export const GrepTool = tool({
  id: "grep",
  idempotent: true,
  description: "Search file contents with regex. Returns matching lines.",
  promptSnippet: "Search file contents with regex",
  promptGuidelines: ["Use instead of bash grep/rg"],
  params: GrepParams,
  execute: Effect.fn("GrepTool.execute")(function* (params, ctx) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const fileIndex = yield* FileIndex

    const basePath = params.path !== undefined ? pathService.resolve(params.path) : ctx.cwd
    const limit = params.limit ?? 100
    const contextLines = params.context ?? 0
    const flags = params.caseSensitive === false ? "gi" : "g"

    const regex = yield* Effect.try({
      try: () => new RegExp(params.pattern, flags),
      catch: (e) =>
        new GrepError({
          message: `Invalid regex: ${e}`,
          pattern: params.pattern,
          cause: e,
        }),
    })

    const matches: Array<{
      file: string
      line: number
      content: string
      context?: { before: string[]; after: string[] }
    }> = []

    const searchFile = (filePath: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const contentResult = yield* fs.readFileString(filePath).pipe(Effect.option)
        if (Option.isNone(contentResult)) return

        const content = contentResult.value
        const lines = content.split("\n")

        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          const line = lines[i]
          if (line !== undefined && regex.test(line)) {
            const match: (typeof matches)[0] = {
              file: filePath,
              line: i + 1,
              content: line,
            }

            if (contextLines > 0) {
              match.context = {
                before: lines.slice(Math.max(0, i - contextLines), i),
                after: lines.slice(i + 1, i + 1 + contextLines),
              }
            }

            matches.push(match)
          }
          // Reset regex lastIndex for next test
          regex.lastIndex = 0
        }
      })

    const baseStat = yield* fs.stat(basePath).pipe(Effect.option)
    if (Option.isNone(baseStat)) {
      return yield* new GrepError({
        message: `Path not found: ${basePath}`,
        pattern: params.pattern,
      })
    }

    if (baseStat.value.type === "File") {
      yield* searchFile(basePath)
    } else {
      // Use FileIndex for directory file discovery
      const allFiles = yield* fileIndex.listFiles({ cwd: basePath })
      const globPattern = params.glob ?? "**/*"
      const glob = new Glob(globPattern)

      for (const file of allFiles) {
        if (matches.length >= limit) break
        if (!glob.match(file.relativePath)) continue
        yield* searchFile(file.path)
      }
    }

    return {
      matches,
      truncated: matches.length >= limit,
    }
  }),
})
