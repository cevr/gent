import { Effect, Option, Schema, Stream } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { defineTool } from "@gent/core"
import { Glob } from "bun"

// Grep Tool Error

export class GrepError extends Schema.TaggedError<GrepError>()("GrepError", {
  message: Schema.String,
  pattern: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Grep Tool Params

export const GrepParams = Schema.Struct({
  pattern: Schema.String.annotations({
    description: "Regex pattern to search for",
  }),
  path: Schema.optional(
    Schema.String.annotations({
      description: "File or directory to search (default: cwd)",
    }),
  ),
  glob: Schema.optional(
    Schema.String.annotations({
      description: "Glob pattern to filter files (e.g., *.ts)",
    }),
  ),
  caseSensitive: Schema.optional(
    Schema.Boolean.annotations({
      description: "Case sensitive search (default: true)",
    }),
  ),
  context: Schema.optional(
    Schema.Number.annotations({
      description: "Lines of context around matches",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotations({
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

export const GrepTool = defineTool({
  name: "grep",
  concurrency: "parallel",
  description: "Search file contents with regex. Returns matching lines.",
  params: GrepParams,
  execute: Effect.fn("GrepTool.execute")(function* (params) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const basePath = params.path !== undefined ? pathService.resolve(params.path) : process.cwd()
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
      const globPattern = params.glob ?? "**/*"
      const glob = new Glob(globPattern)

      // Create stream from async iterable
      const fileStream = Stream.fromAsyncIterable(
        glob.scan({ cwd: basePath, absolute: true }),
        (e) =>
          new GrepError({
            message: `Failed to glob: ${e}`,
            pattern: params.pattern,
            cause: e,
          }),
      )

      // Collect files and search each
      const files = yield* Stream.runCollect(fileStream)

      for (const file of files) {
        if (matches.length >= limit) break
        const fileStat = yield* fs.stat(file).pipe(Effect.option)
        if (Option.isSome(fileStat) && fileStat.value.type === "File") {
          yield* searchFile(file)
        }
      }
    }

    return {
      matches,
      truncated: matches.length >= limit,
    }
  }),
})
