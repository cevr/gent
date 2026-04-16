import { Effect, Schema, Path } from "effect"
import { defineTool, FileIndex } from "@gent/core/extensions/api"
import { Glob } from "bun"

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
  path: Schema.optional(
    Schema.String.annotate({
      description: "Directory to search in (default: cwd)",
    }),
  ),
  limit: Schema.optional(
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

export const GlobTool = defineTool({
  name: "glob",
  concurrency: "parallel",
  idempotent: true,
  description: "Find files matching glob pattern. Returns paths sorted by mtime.",
  promptSnippet: "Find files by glob pattern",
  promptGuidelines: ["Use instead of bash find/ls"],
  params: GlobParams,
  execute: Effect.fn("GlobTool.execute")(function* (params, ctx) {
    const pathService = yield* Path.Path
    const fileIndex = yield* FileIndex

    const basePath = params.path !== undefined ? pathService.resolve(params.path) : ctx.cwd
    const limit = params.limit ?? 100

    const allFiles = yield* fileIndex.listFiles({ cwd: basePath })
    const glob = new Glob(params.pattern)

    const matched = allFiles.filter((f) => glob.match(f.relativePath))

    // Sort by mtime desc
    matched.sort((a, b) => b.modifiedMs - a.modifiedMs)

    const truncated = matched.length > limit
    const resultFiles = matched.slice(0, limit).map((m) => m.path)

    return { files: resultFiles, truncated }
  }),
})
