import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core"
import { Glob } from "bun"
import * as path from "node:path"
import * as fs from "node:fs/promises"

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
    })
  ),
  limit: Schema.optional(
    Schema.Number.annotations({
      description: "Maximum number of results (default: 100)",
    })
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
  description:
    "Find files matching glob pattern. Returns paths sorted by mtime.",
  params: GlobParams,
  execute: Effect.fn("GlobTool.execute")(function* (params) {
    const basePath = params.path ? path.resolve(params.path) : process.cwd()
    const limit = params.limit ?? 100

    const glob = new Glob(params.pattern)
    const matches: Array<{ path: string; mtime: number }> = []

    yield* Effect.tryPromise({
      try: async () => {
        for await (const file of glob.scan({
          cwd: basePath,
          absolute: true,
        })) {
          try {
            const stat = await fs.stat(file)
            matches.push({ path: file, mtime: stat.mtimeMs })
          } catch {
            // Skip files we can't stat
          }
        }
      },
      catch: (e) =>
        new GlobError({
          message: `Failed to glob: ${e}`,
          pattern: params.pattern,
          cause: e,
        }),
    })

    // Sort by mtime desc
    matches.sort((a, b) => b.mtime - a.mtime)

    const truncated = matches.length > limit
    const files = matches.slice(0, limit).map((m) => m.path)

    return { files, truncated }
  }),
})
