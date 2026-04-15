/**
 * TUI extension discovery — scan extension directories for *.client.* files.
 *
 * Mirrors the server's discoverDir() but for client-side modules only.
 * Files are tagged with "user" or "project" scope based on their source directory.
 */

import { Effect, FileSystem, Path } from "effect"

export interface DiscoveredTuiExtension {
  readonly filePath: string
  readonly kind: "user" | "project"
}

/** Match *.client.{tsx,ts,js,jsx,mjs} */
const CLIENT_FILE_PATTERN = /\.client\.(?:[tj]sx?|mjs)$/

/** Match client.{tsx,ts,js,jsx,mjs} */
const CLIENT_INDEX_PATTERN = /^client\.(?:[tj]sx?|mjs)$/

const isClientFile = (entry: string): boolean =>
  CLIENT_FILE_PATTERN.test(entry) || CLIENT_INDEX_PATTERN.test(entry)

const discoverDir = (
  dir: string,
  kind: DiscoveredTuiExtension["kind"],
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<DiscoveredTuiExtension[]> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(dir)
    if (!exists) return []

    const entries = yield* fs.readDirectory(dir)
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
      const info = yield* fs.stat(filePath).pipe(Effect.option)
      if (info._tag === "None") continue

      if (info.value.type === "File" && isClientFile(entry)) {
        results.push({ filePath, kind })
      } else if (info.value.type === "Directory") {
        // Check for client.{tsx,ts,js,jsx,mjs} in subdirectory
        const subEntries = yield* fs
          .readDirectory(filePath)
          .pipe(Effect.orElseSucceed((): string[] => []))
        const clientFiles = subEntries.filter((e) => CLIENT_INDEX_PATTERN.test(e)).sort()
        if (clientFiles.length > 1) {
          yield* Effect.logWarning("multiple client entrypoints").pipe(
            Effect.annotateLogs({
              dir: filePath,
              files: clientFiles.join(", "),
              using: clientFiles[0] ?? "",
            }),
          )
        }
        const firstClient = clientFiles[0]
        if (firstClient !== undefined) {
          results.push({ filePath: path.join(filePath, firstClient), kind })
        }
      }
    }

    return results.sort((a, b) => a.filePath.localeCompare(b.filePath))
  }).pipe(Effect.orElseSucceed((): DiscoveredTuiExtension[] => []))

/** Discover TUI extension files from user and project directories.
 *  Builtins are provided as pre-imported modules — see loader.ts. */
export const discoverTuiExtensions = async (
  opts: {
    readonly userDir: string
    readonly projectDir: string
  },
  runEffect: <A, E = never, R = never>(effect: Effect.Effect<A, E, R>) => Promise<A>,
): Promise<ReadonlyArray<DiscoveredTuiExtension>> => {
  const [user, project] = await runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const userExts = yield* discoverDir(opts.userDir, "user", fs, path)
      const projectExts = yield* discoverDir(opts.projectDir, "project", fs, path)
      return [userExts, projectExts] as const
    }),
  )
  return [...user, ...project]
}
