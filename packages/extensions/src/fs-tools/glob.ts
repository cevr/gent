import { Effect, Schema, Path } from "effect"
import { tool, FileIndex, ToolNeeds } from "@gent/core/extensions/api"
import picomatch from "picomatch"

// Glob Tool Error

export class GlobError extends Schema.TaggedErrorClass<GlobError>()("GlobError", {
  message: Schema.String,
  pattern: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Glob Tool Params

export const GlobParams = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "Glob pattern (e.g., **/*.ts, src/**/*.tsx)",
  }),
  path: Schema.optionalKey(
    Schema.String.annotate({
      description: "Directory to search in (default: cwd)",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Number.annotate({
      description: "Maximum number of results (default: 100)",
    }),
  ),
})

// Glob Tool Result

export const GlobResult = Schema.Struct({
  files: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
})

// Glob Tool

export const GlobTool = tool({
  id: "glob",
  intent: "read",
  needs: [ToolNeeds.read("fs")],
  description: "Find files matching glob pattern. Returns paths sorted by mtime.",
  promptSnippet: "Find files by glob pattern",
  promptGuidelines: ["Use instead of bash find/ls"],
  params: GlobParams,
  output: GlobResult,
  execute: Effect.fn("GlobTool.execute")(function* (params, ctx) {
    const pathService = yield* Path.Path
    const fileIndex = yield* FileIndex

    const basePath = params.path !== undefined ? pathService.resolve(params.path) : ctx.cwd
    const limit = params.limit ?? 100

    const allFiles = yield* fileIndex.listFiles({ cwd: basePath })
    const matches = yield* Effect.try({
      try: () => picomatch(params.pattern, { dot: true }),
      catch: (e) =>
        new GlobError({
          message: `Invalid glob pattern: ${e}`,
          pattern: params.pattern,
          cause: e,
        }),
    })

    const matched = allFiles.filter((f) => matches(f.relativePath))

    // Sort by mtime desc
    matched.sort((a, b) => b.modifiedMs - a.modifiedMs)

    const truncated = matched.length > limit
    const resultFiles = matched.slice(0, limit).map((m) => m.path)

    return { files: resultFiles, truncated }
  }),
})
