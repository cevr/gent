/**
 * TUI extension discovery — scan extension directories for *.client.* files.
 *
 * Mirrors the server's discoverDir() but for client-side modules only.
 * Files are tagged with "user" or "project" scope based on their source directory.
 *
 * C9.3: takes Effect's `FileSystem.FileSystem` directly — the
 * `AsyncFileSystem` Promise-proxy was deleted in the same wave.
 */

import { Effect, FileSystem, Path } from "effect"

export interface DiscoveredTuiExtension {
  readonly filePath: string
  readonly scope: "user" | "project"
}

/** Match *.client.{tsx,ts,js,jsx,mjs} */
const CLIENT_FILE_PATTERN = /\.client\.(?:[tj]sx?|mjs)$/

/** Match client.{tsx,ts,js,jsx,mjs} */
const CLIENT_INDEX_PATTERN = /^client\.(?:[tj]sx?|mjs)$/

const isClientFile = (entry: string): boolean =>
  CLIENT_FILE_PATTERN.test(entry) || CLIENT_INDEX_PATTERN.test(entry)

const discoverDir = (
  dir: string,
  scope: DiscoveredTuiExtension["scope"],
): Effect.Effect<DiscoveredTuiExtension[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return [] as DiscoveredTuiExtension[]

    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))

    const results: DiscoveredTuiExtension[] = []

    for (const entry of entries) {
      if (
        entry.startsWith(".") ||
        entry.startsWith("_") ||
        entry === "__tests__" ||
        entry === "node_modules"
      )
        continue

      const filePath = path.join(dir, entry)
      // oxlint-disable-next-line no-await-in-loop -- sequential: type determines action
      const info = yield* fs.stat(filePath).pipe(Effect.option)
      if (info._tag === "None") continue

      if (info.value.type === "File" && isClientFile(entry)) {
        results.push({ filePath, scope })
      } else if (info.value.type === "Directory") {
        // oxlint-disable-next-line no-await-in-loop -- sequential: directory scan recurses through nested scopes
        const subEntries = yield* fs
          .readDirectory(filePath)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
        const clientFiles = subEntries
          .filter((e) => CLIENT_INDEX_PATTERN.test(e))
          .slice()
          .sort()
        if (clientFiles.length > 1) {
          yield* Effect.logWarning("tui-ext.discovery.multiple-entrypoints").pipe(
            Effect.annotateLogs({
              dir: filePath,
              candidates: clientFiles.join(", "),
              picked: clientFiles[0],
            }),
          )
        }
        const firstClient = clientFiles[0]
        if (firstClient !== undefined) {
          results.push({ filePath: path.join(filePath, firstClient), scope })
        }
      }
    }

    return results.sort((a, b) => a.filePath.localeCompare(b.filePath))
  })

/** Discover TUI extension files from user and project directories. */
export const discoverTuiExtensions = (opts: {
  readonly userDir: string
  readonly projectDir: string
}): Effect.Effect<
  ReadonlyArray<DiscoveredTuiExtension>,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const [user, project] = yield* Effect.all(
      [discoverDir(opts.userDir, "user"), discoverDir(opts.projectDir, "project")],
      { concurrency: 2 },
    )
    return [...user, ...project]
  })
