import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core"
import { Glob } from "bun"
import * as path from "node:path"
import * as fs from "node:fs/promises"

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
    })
  ),
  glob: Schema.optional(
    Schema.String.annotations({
      description: "Glob pattern to filter files (e.g., *.ts)",
    })
  ),
  caseSensitive: Schema.optional(
    Schema.Boolean.annotations({
      description: "Case sensitive search (default: true)",
    })
  ),
  context: Schema.optional(
    Schema.Number.annotations({
      description: "Lines of context around matches",
    })
  ),
  limit: Schema.optional(
    Schema.Number.annotations({
      description: "Maximum number of matches (default: 100)",
    })
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
    })
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
  description: "Search file contents with regex. Returns matching lines.",
  params: GrepParams,
  execute: Effect.fn("GrepTool.execute")(function* (params) {
    const basePath = params.path ? path.resolve(params.path) : process.cwd()
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

    const searchFile = async (filePath: string) => {
      try {
        const content = await fs.readFile(filePath, "utf-8")
        const lines = content.split("\n")

        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          const line = lines[i]!
          if (regex.test(line)) {
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
      } catch {
        // Skip files we can't read
      }
    }

    yield* Effect.tryPromise({
      try: async () => {
        const stat = await fs.stat(basePath)

        if (stat.isFile()) {
          await searchFile(basePath)
        } else {
          const globPattern = params.glob ?? "**/*"
          const glob = new Glob(globPattern)

          for await (const file of glob.scan({
            cwd: basePath,
            absolute: true,
          })) {
            if (matches.length >= limit) break
            const fileStat = await fs.stat(file).catch(() => null)
            if (fileStat?.isFile()) {
              await searchFile(file)
            }
          }
        }
      },
      catch: (e) =>
        new GrepError({
          message: `Failed to search: ${e}`,
          pattern: params.pattern,
          cause: e,
        }),
    })

    return {
      matches,
      truncated: matches.length >= limit,
    }
  }),
})
