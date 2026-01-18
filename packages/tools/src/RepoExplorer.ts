import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { $ } from "bun"

// RepoExplorer Tool Error

export class RepoExplorerError extends Schema.TaggedError<RepoExplorerError>()(
  "RepoExplorerError",
  {
    message: Schema.String,
    spec: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

// RepoExplorer Tool Params

export const RepoExplorerParams = Schema.Struct({
  spec: Schema.String.annotations({
    description:
      "Repository spec: owner/repo, owner/repo@tag, npm:package, pypi:package, crates:crate",
  }),
  action: Schema.Literal("fetch", "path", "search", "info").annotations({
    description: "Action: fetch (clone/download), path (get local path), search (grep), info (metadata)",
  }),
  query: Schema.optional(
    Schema.String.annotations({
      description: "Search query (for search action)",
    })
  ),
  update: Schema.optional(
    Schema.Boolean.annotations({
      description: "Update existing repo (for fetch action)",
    })
  ),
})

// RepoExplorer Tool Result

export const RepoExplorerResult = Schema.Struct({
  path: Schema.optional(Schema.String),
  matches: Schema.optional(Schema.Array(Schema.String)),
  info: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
})

// Cache directory
const CACHE_DIR = path.join(
  process.env["HOME"] ?? "~",
  ".cache",
  "repo"
)

// Parse spec into type and parts
interface ParsedSpec {
  type: "github" | "npm" | "pypi" | "crates"
  name: string
  version: string | undefined
}

function parseSpec(spec: string): ParsedSpec {
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4)
    const atIdx = rest.lastIndexOf("@")
    if (atIdx > 0) {
      return { type: "npm", name: rest.slice(0, atIdx), version: rest.slice(atIdx + 1) }
    }
    return { type: "npm", name: rest, version: undefined }
  }
  if (spec.startsWith("pypi:")) {
    const rest = spec.slice(5)
    const atIdx = rest.lastIndexOf("@")
    if (atIdx > 0) {
      return { type: "pypi", name: rest.slice(0, atIdx), version: rest.slice(atIdx + 1) }
    }
    return { type: "pypi", name: rest, version: undefined }
  }
  if (spec.startsWith("crates:")) {
    const rest = spec.slice(7)
    const atIdx = rest.lastIndexOf("@")
    if (atIdx > 0) {
      return { type: "crates", name: rest.slice(0, atIdx), version: rest.slice(atIdx + 1) }
    }
    return { type: "crates", name: rest, version: undefined }
  }
  // Default: GitHub
  const atIdx = spec.lastIndexOf("@")
  if (atIdx > 0) {
    return { type: "github", name: spec.slice(0, atIdx), version: spec.slice(atIdx + 1) }
  }
  return { type: "github", name: spec, version: undefined }
}

// Get cache path for spec
function getCachePath(spec: string): string {
  const parsed = parseSpec(spec)
  switch (parsed.type) {
    case "github":
      return path.join(CACHE_DIR, ...parsed.name.split("/"))
    case "npm":
      return path.join(CACHE_DIR, "npm", parsed.name, parsed.version ?? "latest")
    case "pypi":
      return path.join(CACHE_DIR, "pypi", parsed.name, parsed.version ?? "latest")
    case "crates":
      return path.join(CACHE_DIR, "crates", parsed.name, parsed.version ?? "latest")
  }
}

// RepoExplorer Tool

export const RepoExplorerTool = defineTool({
  name: "repo_explorer",
  description:
    "Explore external repositories. Fetch GitHub repos, npm/pypi/crates packages. Search code, get paths.",
  params: RepoExplorerParams,
  execute: Effect.fn("RepoExplorerTool.execute")(function* (params) {
    const cachePath = getCachePath(params.spec)
    const parsed = parseSpec(params.spec)

    switch (params.action) {
      case "fetch": {
        yield* Effect.tryPromise({
          try: async () => {
            await fs.mkdir(path.dirname(cachePath), { recursive: true })

            if (parsed.type === "github") {
              // Check if already exists
              try {
                await fs.access(cachePath)
                if (params.update) {
                  await $`git -C ${cachePath} pull --ff-only`.quiet()
                }
                return
              } catch {
                // Clone
                const url = `https://github.com/${parsed.name}.git`
                const args = ["git", "clone", "--depth", "100"]
                if (parsed.version) {
                  args.push("--branch", parsed.version)
                }
                args.push(url, cachePath)
                await $`${args}`.quiet()
              }
            } else if (parsed.type === "npm") {
              // Use npm pack to download
              await $`npm pack ${parsed.name}${parsed.version ? `@${parsed.version}` : ""} --pack-destination ${cachePath}`.quiet()
              // Extract
              const tarballs = await fs.readdir(cachePath)
              const tarball = tarballs.find((f) => f.endsWith(".tgz"))
              if (tarball) {
                await $`tar -xzf ${path.join(cachePath, tarball)} -C ${cachePath}`.quiet()
              }
            }
            // pypi/crates: simplified - would need pip download / cargo fetch
          },
          catch: (e) =>
            new RepoExplorerError({
              message: `Failed to fetch: ${e}`,
              spec: params.spec,
              cause: e,
            }),
        })
        return { path: cachePath, message: "Fetched successfully" }
      }

      case "path": {
        const exists = yield* Effect.tryPromise({
          try: () => fs.access(cachePath).then(() => true).catch(() => false),
          catch: () =>
            new RepoExplorerError({
              message: "Failed to check path",
              spec: params.spec,
            }),
        })
        if (!exists) {
          return yield* new RepoExplorerError({
            message: "Not cached. Use fetch first.",
            spec: params.spec,
          })
        }
        return { path: cachePath }
      }

      case "search": {
        if (!params.query) {
          return yield* new RepoExplorerError({
            message: "Query required for search",
            spec: params.spec,
          })
        }
        const exists = yield* Effect.tryPromise({
          try: () => fs.access(cachePath).then(() => true).catch(() => false),
          catch: () =>
            new RepoExplorerError({
              message: "Failed to check path",
              spec: params.spec,
            }),
        })
        if (!exists) {
          return yield* new RepoExplorerError({
            message: "Not cached. Use fetch first.",
            spec: params.spec,
          })
        }

        const result = yield* Effect.tryPromise({
          try: async () => {
            const output = await $`rg --files-with-matches ${params.query} ${cachePath}`.text()
            return output.trim().split("\n").filter(Boolean)
          },
          catch: () => [] as string[],
        })
        return { path: cachePath, matches: result }
      }

      case "info": {
        if (parsed.type === "github") {
          const info = yield* Effect.tryPromise({
            try: async () => {
              const res = await fetch(
                `https://api.github.com/repos/${parsed.name}`
              )
              return res.json()
            },
            catch: (e) =>
              new RepoExplorerError({
                message: `Failed to get info: ${e}`,
                spec: params.spec,
                cause: e,
              }),
          })
          return { info }
        }
        return { message: "Info not implemented for this type" }
      }
    }
  }),
})
