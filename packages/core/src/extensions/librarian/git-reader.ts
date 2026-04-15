import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { $ } from "bun"

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class GitReaderError extends Schema.TaggedErrorClass<GitReaderError>()("GitReaderError", {
  message: Schema.String,
  operation: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// ---------------------------------------------------------------------------
// Credential resolution (internal)
// ---------------------------------------------------------------------------

type Credential =
  | { type: "SSHKeyFromPath"; username: string; privateKeyPath: string; publicKeyPath?: string }
  | { type: "Plain"; username: string; password: string }

/** Resolve git credentials for a URL. Uses captured `fs` to avoid leaking FileSystem into R. */
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

    // HTTPS URLs — try gh auth token
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
    return undefined
  }).pipe(Effect.orElseSucceed(() => undefined))

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

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
  "@gent/core/src/extensions/librarian/git-reader/GitReader",
) {
  // ---------------------------------------------------------------------------
  // Live — es-git NAPI backend
  // ---------------------------------------------------------------------------

  static Live = (home: string): Layer.Layer<GitReader, never, FileSystem.FileSystem> =>
    Layer.effect(
      GitReader,
      Effect.gen(function* () {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, typescript-eslint/consistent-type-imports
        const esGit: typeof import("es-git") = require("es-git")
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
              yield* Effect.try({
                try: () => {
                  remote.fetch(["refs/heads/*:refs/remotes/origin/*"], {
                    fetch: { credential },
                  })
                  const headOid = repo.revparseSingle("origin/HEAD")
                  const headCommit = repo.getCommit(headOid)
                  repo.setHeadDetached(headCommit)
                  repo.checkoutHead({ force: true })
                },
                catch: (e) =>
                  new GitReaderError({ message: String(e), operation: "fetch", cause: e }),
              })
            }),

          listFiles: (repoPath, ref) =>
            Effect.tryPromise({
              try: async () => {
                const repo = await esGit.openRepository(repoPath)
                const oid = repo.revparseSingle(ref ?? "HEAD")
                const commit = repo.getCommit(oid)
                const tree = commit.tree()
                const files: string[] = []
                tree.walk("PreOrder", (entry) => {
                  if (entry.type() === "Blob") {
                    files.push(entry.name())
                  }
                  return 0
                })
                return files
              },
              catch: (e) =>
                new GitReaderError({ message: String(e), operation: "listFiles", cause: e }),
            }),

          readFile: (repoPath, filePath, ref) =>
            Effect.tryPromise({
              try: async () => {
                const repo = await esGit.openRepository(repoPath)
                const oid = repo.revparseSingle(ref ?? "HEAD")
                const commit = repo.getCommit(oid)
                const tree = commit.tree()
                const entry = tree.getPath(filePath)
                if (entry === null || entry === undefined) {
                  throw new Error(`File not found: ${filePath}`)
                }
                const blob = entry.toObject(repo).peelToBlob()
                if (blob === null || blob === undefined) {
                  throw new Error(`Not a blob: ${filePath}`)
                }
                return {
                  content: new Uint8Array(blob.content()),
                  size: Number(blob.size()),
                  isBinary: blob.isBinary(),
                }
              },
              catch: (e) =>
                new GitReaderError({ message: String(e), operation: "readFile", cause: e }),
            }),
        }
      }),
    )

  // ---------------------------------------------------------------------------
  // Test — mock layer
  // ---------------------------------------------------------------------------

  static Test: Layer.Layer<GitReader> = Layer.succeed(GitReader, {
    clone: () => Effect.void,
    fetch: () => Effect.void,
    listFiles: () => Effect.succeed([]),
    readFile: () => Effect.succeed({ content: new Uint8Array(), size: 0, isBinary: false }),
  })
}
