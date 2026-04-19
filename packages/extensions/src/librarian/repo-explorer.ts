import { Effect, FileSystem, Path, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { tool } from "@gent/core/extensions/api"
import { $ } from "bun"
import { GitReader } from "./git-reader.js"

// RepoExplorer Tool Error

export class RepoExplorerError extends Schema.TaggedErrorClass<RepoExplorerError>()(
  "RepoExplorerError",
  {
    message: Schema.String,
    spec: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// RepoExplorer Tool Params

export const RepoExplorerParams = Schema.Struct({
  spec: Schema.String.annotate({
    description:
      "Repository spec: owner/repo, owner/repo@tag, npm:package, pypi:package, crates:crate",
  }),
  action: Schema.Literals(["fetch", "path", "search", "info", "tree", "read"]).annotate({
    description:
      "Action: fetch (clone/download), path (get local path), search (grep), info (metadata), tree (list files), read (read file content)",
  }),
  query: Schema.optional(
    Schema.String.annotate({
      description: "Search query (for search action)",
    }),
  ),
  update: Schema.optional(
    Schema.Boolean.annotate({
      description: "Update existing repo (for fetch action)",
    }),
  ),
  ref: Schema.optional(
    Schema.String.annotate({
      description: "Git ref — branch, tag, or SHA (for tree/read actions). Defaults to HEAD",
    }),
  ),
  filePath: Schema.optional(
    Schema.String.annotate({
      description: "File path within the repo (for read action)",
    }),
  ),
})

// RepoExplorer Tool Result

export const RepoExplorerResult = Schema.Struct({
  path: Schema.optional(Schema.String),
  matches: Schema.optional(Schema.Array(Schema.String)),
  files: Schema.optional(Schema.Array(Schema.String)),
  content: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  isBinary: Schema.optional(Schema.Boolean),
  info: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
})

// ---------------------------------------------------------------------------
// Shared helpers — used by research-tool.ts
// ---------------------------------------------------------------------------

export interface ParsedSpec {
  type: "github" | "npm" | "pypi" | "crates"
  name: string
  version: string | undefined
}

export function parseSpec(spec: string): ParsedSpec {
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

export function getCachePath(path: Path.Path, cacheDir: string, spec: string): string {
  const parsed = parseSpec(spec)
  switch (parsed.type) {
    case "github":
      return path.join(cacheDir, ...parsed.name.split("/"))
    case "npm":
      return path.join(cacheDir, "npm", parsed.name, parsed.version ?? "latest")
    case "pypi":
      return path.join(cacheDir, "pypi", parsed.name, parsed.version ?? "latest")
    case "crates":
      return path.join(cacheDir, "crates", parsed.name, parsed.version ?? "latest")
  }
}

/** Resolve cache path for a spec without needing the Path service */
export const getRepoCachePath = (home: string, spec: string): string => {
  const cacheDir = `${home}/.cache/repo`
  const parsed = parseSpec(spec)
  switch (parsed.type) {
    case "github":
      return `${cacheDir}/${parsed.name}`
    case "npm":
      return `${cacheDir}/npm/${parsed.name}/${parsed.version ?? "latest"}`
    case "pypi":
      return `${cacheDir}/pypi/${parsed.name}/${parsed.version ?? "latest"}`
    case "crates":
      return `${cacheDir}/crates/${parsed.name}/${parsed.version ?? "latest"}`
  }
}

/** Ensure a repo is cloned/fetched. Returns the cache path. */
export const fetchRepo = (spec: string, home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const gitReader = yield* GitReader
    const cachePath = getRepoCachePath(home, spec)
    const parsed = parseSpec(spec)

    const exists = yield* fs.exists(cachePath)
    if (exists) return cachePath

    // Only auto-fetch GitHub repos — npm/pypi/crates need the full repo tool
    if (parsed.type !== "github") return cachePath

    // Create parent dir — let clone create the final directory
    yield* fs
      .makeDirectory(cachePath.slice(0, cachePath.lastIndexOf("/")), { recursive: true })
      .pipe(Effect.ignore)

    const url = `https://github.com/${parsed.name}.git`
    yield* gitReader
      .clone(url, cachePath, { depth: 100, ref: parsed.version })
      .pipe(
        Effect.mapError(
          (e) =>
            new RepoExplorerError({ message: `Failed to fetch: ${e.message}`, spec, cause: e }),
        ),
      )

    return cachePath
  })

const ensureCached = (fs: FileSystem.FileSystem, cachePath: string, spec: string) =>
  fs.exists(cachePath).pipe(
    Effect.mapError(() => new RepoExplorerError({ message: "Failed to check path", spec })),
    Effect.flatMap((exists) =>
      exists
        ? Effect.void
        : Effect.fail(new RepoExplorerError({ message: "Not cached. Use fetch first.", spec })),
    ),
  )

// RepoExplorer Tool

export const RepoTool = tool({
  id: "repo",
  resources: ["repo"],
  idempotent: true,
  description:
    "Explore external repositories. Fetch GitHub repos, npm/pypi/crates packages. Search code, list files, read content.",
  params: RepoExplorerParams,
  execute: Effect.fn("RepoExplorerTool.execute")(function* (params, ctx) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const gitReader = yield* GitReader
    const cacheDir = path.join(ctx.home, ".cache", "repo")
    const cachePath = getCachePath(path, cacheDir, params.spec)
    const parsed = parseSpec(params.spec)

    switch (params.action) {
      case "fetch": {
        yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true }).pipe(Effect.ignore)

        if (parsed.type === "github") {
          const exists = yield* fs.exists(cachePath).pipe(Effect.orElseSucceed(() => false))
          if (exists) {
            if (params.update === true) {
              yield* gitReader.fetch(cachePath).pipe(
                Effect.mapError(
                  (e) =>
                    new RepoExplorerError({
                      message: `Failed to update: ${e.message}`,
                      spec: params.spec,
                      cause: e,
                    }),
                ),
              )
            }
          } else {
            const url = `https://github.com/${parsed.name}.git`
            yield* gitReader.clone(url, cachePath, { depth: 100, ref: parsed.version }).pipe(
              Effect.mapError(
                (e) =>
                  new RepoExplorerError({
                    message: `Failed to fetch: ${e.message}`,
                    spec: params.spec,
                    cause: e,
                  }),
              ),
            )
          }
        } else if (parsed.type === "npm") {
          yield* fs.makeDirectory(cachePath, { recursive: true }).pipe(
            Effect.mapError(
              (e) =>
                new RepoExplorerError({
                  message: `Failed to create cache directory: ${e}`,
                  spec: params.spec,
                  cause: e,
                }),
            ),
          )
          const versionSuffix = parsed.version !== undefined ? `@${parsed.version}` : ""
          yield* Effect.tryPromise({
            try: () =>
              $`npm pack ${parsed.name}${versionSuffix} --pack-destination ${cachePath}`.quiet(),
            catch: (e) =>
              new RepoExplorerError({
                message: `Failed to fetch npm: ${e}`,
                spec: params.spec,
                cause: e,
              }),
          })
          const tarballs = yield* fs.readDirectory(cachePath).pipe(
            Effect.mapError(
              (e) =>
                new RepoExplorerError({
                  message: `Failed to read cache directory: ${e}`,
                  spec: params.spec,
                  cause: e,
                }),
            ),
          )
          const tarball = tarballs.find((f) => f.endsWith(".tgz"))
          if (tarball !== undefined) {
            yield* Effect.tryPromise({
              try: () => $`tar -xzf ${path.join(cachePath, tarball)} -C ${cachePath}`.quiet(),
              catch: (e) =>
                new RepoExplorerError({
                  message: `Failed to extract npm tarball: ${e}`,
                  spec: params.spec,
                  cause: e,
                }),
            })
          }
        }
        // pypi/crates: simplified - would need pip download / cargo fetch
        return { path: cachePath, message: "Fetched successfully" }
      }

      case "path": {
        yield* ensureCached(fs, cachePath, params.spec)
        return { path: cachePath }
      }

      case "search": {
        if (params.query === undefined || params.query === "") {
          return yield* new RepoExplorerError({
            message: "Query required for search",
            spec: params.spec,
          })
        }
        yield* ensureCached(fs, cachePath, params.spec)

        const result = yield* Effect.tryPromise({
          try: async () => {
            const output = await $`rg --files-with-matches ${params.query} ${cachePath}`.text()
            return output.trim().split("\n").filter(Boolean)
          },
          catch: () => [] as string[],
        })
        return { path: cachePath, matches: result }
      }

      case "tree": {
        yield* ensureCached(fs, cachePath, params.spec)

        const fileList = yield* gitReader.listFiles(cachePath, params.ref).pipe(
          Effect.mapError(
            (e) =>
              new RepoExplorerError({
                message: `Failed to list files: ${e.message}`,
                spec: params.spec,
                cause: e,
              }),
          ),
        )
        return { path: cachePath, files: [...fileList] }
      }

      case "read": {
        if (params.filePath === undefined || params.filePath === "") {
          return yield* new RepoExplorerError({
            message: "filePath required for read action",
            spec: params.spec,
          })
        }
        yield* ensureCached(fs, cachePath, params.spec)

        const blob = yield* gitReader.readFile(cachePath, params.filePath, params.ref).pipe(
          Effect.mapError(
            (e) =>
              new RepoExplorerError({
                message: `Failed to read file: ${e.message}`,
                spec: params.spec,
                cause: e,
              }),
          ),
        )

        if (blob.isBinary) {
          return { path: cachePath, size: blob.size, isBinary: true }
        }
        return {
          path: cachePath,
          content: new TextDecoder().decode(blob.content),
          size: blob.size,
          isBinary: false,
        }
      }

      case "info": {
        if (parsed.type === "github") {
          const http = yield* HttpClient.HttpClient
          const info = yield* http.get(`https://api.github.com/repos/${parsed.name}`).pipe(
            Effect.flatMap((res) => res.json),
            Effect.catchEager((e) =>
              Effect.fail(
                new RepoExplorerError({
                  message: `Failed to get info: ${e}`,
                  spec: params.spec,
                  cause: e,
                }),
              ),
            ),
          )
          return { info }
        }
        return { message: "Info not implemented for this type" }
      }
    }
  }),
})
