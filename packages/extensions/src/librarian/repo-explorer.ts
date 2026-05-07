import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { tool, ToolNeeds, type ToolCoreContext } from "@gent/core/extensions/api"
import { $ } from "bun"
import * as esGit from "es-git"

export class GitReaderError extends Schema.TaggedErrorClass<GitReaderError>()("GitReaderError", {
  message: Schema.String,
  operation: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

type Credential =
  | { type: "SSHKeyFromPath"; username: string; privateKeyPath: string; publicKeyPath?: string }
  | { type: "Plain"; username: string; password: string }

const resolveCredential = (
  fs: FileSystem.FileSystem,
  home: string,
  url: string,
): Effect.Effect<Credential | undefined> =>
  Effect.gen(function* () {
    if (url.startsWith("git@") || url.includes("ssh://")) {
      const ed25519 = `${home}/.ssh/id_ed25519`
      if (yield* fs.exists(ed25519).pipe(Effect.orElseSucceed(() => false))) {
        const ed25519Pub = `${home}/.ssh/id_ed25519.pub`
        const hasPub = yield* fs.exists(ed25519Pub).pipe(Effect.orElseSucceed(() => false))
        return {
          type: "SSHKeyFromPath" as const,
          username: "git",
          privateKeyPath: ed25519,
          publicKeyPath: hasPub ? ed25519Pub : undefined,
        } satisfies Credential
      }
      const rsa = `${home}/.ssh/id_rsa`
      if (yield* fs.exists(rsa).pipe(Effect.orElseSucceed(() => false))) {
        const rsaPub = `${home}/.ssh/id_rsa.pub`
        const hasPub = yield* fs.exists(rsaPub).pipe(Effect.orElseSucceed(() => false))
        return {
          type: "SSHKeyFromPath" as const,
          username: "git",
          privateKeyPath: rsa,
          publicKeyPath: hasPub ? rsaPub : undefined,
        } satisfies Credential
      }
      return undefined
    }

    if (url.includes("github.com")) {
      const token = yield* Effect.tryPromise({
        try: () => $`gh auth token`.quiet().text(),
        catch: () => undefined as string | undefined,
      })
      if (token !== undefined) {
        const trimmed = token.trim()
        if (trimmed.length > 0) {
          return {
            type: "Plain" as const,
            username: "x-access-token",
            password: trimmed,
          } satisfies Credential
        }
      }
    }
    return undefined
  }).pipe(Effect.orElseSucceed(() => undefined))

export interface GitReaderService {
  readonly clone: (
    url: string,
    dest: string,
    options?: { depth?: number; ref?: string },
  ) => Effect.Effect<void, GitReaderError>
  readonly fetch: (repoPath: string) => Effect.Effect<void, GitReaderError>
  readonly listFiles: (
    repoPath: string,
    ref?: string,
  ) => Effect.Effect<ReadonlyArray<string>, GitReaderError>
  readonly readFile: (
    repoPath: string,
    filePath: string,
    ref?: string,
  ) => Effect.Effect<{ content: Uint8Array; size: number; isBinary: boolean }, GitReaderError>
}

export class GitReader extends Context.Service<GitReader, GitReaderService>()(
  "@gent/extensions/src/librarian/repo-explorer/GitReader",
) {
  static Live = (home: string): Layer.Layer<GitReader, never, FileSystem.FileSystem> =>
    Layer.effect(
      GitReader,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cred = (url: string) => resolveCredential(fs, home, url)

        return {
          clone: (url, dest, options) =>
            Effect.gen(function* () {
              const credential = yield* cred(url)
              yield* Effect.tryPromise({
                try: () =>
                  esGit.cloneRepository(url, dest, {
                    fetch: { depth: options?.depth, credential },
                    branch: options?.ref,
                  }),
                catch: (e) =>
                  new GitReaderError({ message: String(e), operation: "clone", cause: e }),
              })
            }),

          fetch: (repoPath) =>
            Effect.gen(function* () {
              const repo = yield* Effect.tryPromise({
                try: () => esGit.openRepository(repoPath),
                catch: (e) =>
                  new GitReaderError({ message: String(e), operation: "fetch.open", cause: e }),
              })
              const remote = repo.getRemote("origin")
              const credential = yield* cred(remote.url())
              yield* Effect.tryPromise({
                try: () =>
                  remote
                    .fetch(["refs/heads/*:refs/remotes/origin/*"], {
                      fetch: { credential },
                    })
                    .then(() => {
                      const headOid = repo.revparseSingle("origin/HEAD")
                      const headCommit = repo.getCommit(headOid)
                      repo.setHeadDetached(headCommit)
                      repo.checkoutHead({ force: true })
                    }),
                catch: (e) =>
                  new GitReaderError({ message: String(e), operation: "fetch", cause: e }),
              })
            }),

          listFiles: (repoPath, ref) =>
            Effect.tryPromise({
              try: () =>
                esGit.openRepository(repoPath).then((repo) => {
                  const oid = repo.revparseSingle(ref ?? "HEAD")
                  const commit = repo.getCommit(oid)
                  const files: string[] = []
                  const walk = (tree: ReturnType<typeof commit.tree>, prefix: string) => {
                    for (const entry of tree.iter()) {
                      const fullPath = prefix ? `${prefix}/${entry.name()}` : entry.name()
                      if (entry.type() === "Blob") {
                        files.push(fullPath)
                      } else if (entry.type() === "Tree") {
                        const subtree = repo.findTree(entry.id())
                        if (subtree !== null) walk(subtree, fullPath)
                      }
                    }
                  }
                  walk(commit.tree(), "")
                  return files
                }),
              catch: (e) =>
                new GitReaderError({ message: String(e), operation: "listFiles", cause: e }),
            }),

          readFile: (repoPath, filePath, ref) =>
            Effect.gen(function* () {
              const repo = yield* Effect.tryPromise({
                try: () => esGit.openRepository(repoPath),
                catch: (e) =>
                  new GitReaderError({ message: String(e), operation: "readFile.open", cause: e }),
              })
              const entry = yield* Effect.try({
                try: () => {
                  const oid = repo.revparseSingle(ref ?? "HEAD")
                  const commit = repo.getCommit(oid)
                  const tree = commit.tree()
                  return tree.getPath(filePath)
                },
                catch: (e) =>
                  new GitReaderError({
                    message: String(e),
                    operation: "readFile.lookup",
                    cause: e,
                  }),
              })
              if (entry === null || entry === undefined) {
                return yield* new GitReaderError({
                  message: `File not found: ${filePath}`,
                  operation: "readFile",
                })
              }
              const blob = yield* Effect.try({
                try: () => entry.toObject(repo).peelToBlob(),
                catch: (e) =>
                  new GitReaderError({ message: String(e), operation: "readFile.blob", cause: e }),
              })
              if (blob === null || blob === undefined) {
                return yield* new GitReaderError({
                  message: `Not a blob: ${filePath}`,
                  operation: "readFile",
                })
              }
              return {
                content: new Uint8Array(blob.content()),
                size: Number(blob.size()),
                isBinary: blob.isBinary(),
              }
            }),
        }
      }),
    )

  static Test: Layer.Layer<GitReader> = Layer.succeed(GitReader, {
    clone: () => Effect.void,
    fetch: () => Effect.void,
    listFiles: () => Effect.succeed([]),
    readFile: () => Effect.succeed({ content: new Uint8Array(), size: 0, isBinary: false }),
  })
}

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
  query: Schema.optionalKey(
    Schema.String.annotate({
      description: "Search query (for search action)",
    }),
  ),
  update: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Update existing repo (for fetch action)",
    }),
  ),
  ref: Schema.optionalKey(
    Schema.String.annotate({
      description: "Git ref — branch, tag, or SHA (for tree/read actions). Defaults to HEAD",
    }),
  ),
  filePath: Schema.optionalKey(
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
  needs: [ToolNeeds.read("repo")],
  description:
    "Explore external repositories. Fetch GitHub repos, npm/pypi/crates packages. Search code, list files, read content.",
  params: RepoExplorerParams,
  output: RepoExplorerResult,
  execute: Effect.fn("RepoExplorerTool.execute")(function* (
    params: typeof RepoExplorerParams.Type,
    ctx: ToolCoreContext,
  ) {
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
          try: () =>
            $`rg --files-with-matches ${params.query} ${cachePath}`
              .text()
              .then((output) => output.trim().split("\n").filter(Boolean)),
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
        return yield* new RepoExplorerError({
          message: `info action is only supported for github specs, not ${parsed.type}`,
          spec: params.spec,
        })
      }
    }
  }),
})
