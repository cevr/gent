import { Effect, Option, Schema, Stream } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { defineTool } from "@gent/core"
import { Glob } from "bun"

// Glob Tool Error

export class GlobError extends Schema.TaggedError<GlobError>()("GlobError", {
  message: Schema.String,
  pattern: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Glob Tool Params

export const GlobParams = Schema.Struct({
  pattern: Schema.String.annotations({
    description: "Glob pattern (e.g., **/*.ts, src/**/*.tsx)",
  }),
  path: Schema.optional(
    Schema.String.annotations({
      description: "Directory to search in (default: cwd)",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotations({
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
  description: "Find files matching glob pattern. Returns paths sorted by mtime.",
  params: GlobParams,
  execute: Effect.fn("GlobTool.execute")(function* (params) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const basePath = params.path !== undefined ? pathService.resolve(params.path) : process.cwd()
    const limit = params.limit ?? 100

    const glob = new Glob(params.pattern)

    // Create stream from async iterable
    const fileStream = Stream.fromAsyncIterable(
      glob.scan({ cwd: basePath, absolute: true }),
      (e) =>
        new GlobError({
          message: `Failed to glob: ${e}`,
          pattern: params.pattern,
          cause: e,
        }),
    )

    // Collect all files, stat each for mtime
    const files = yield* Stream.runCollect(fileStream)

    const matches: Array<{ path: string; mtime: number }> = []
    for (const file of files) {
      const statResult = yield* fs.stat(file).pipe(Effect.option)
      if (Option.isSome(statResult)) {
        const mtime = Option.getOrElse(statResult.value.mtime, () => new Date(0))
        matches.push({ path: file, mtime: mtime.getTime() })
      }
    }

    // Sort by mtime desc
    matches.sort((a, b) => b.mtime - a.mtime)

    const truncated = matches.length > limit
    const resultFiles = matches.slice(0, limit).map((m) => m.path)

    return { files: resultFiles, truncated }
  }),
})
