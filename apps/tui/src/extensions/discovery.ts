/**
 * TUI extension discovery — scan extension directories for *.client.* files.
 *
 * Mirrors the server's discoverDir() but for client-side modules only.
 * Files are tagged with "user" or "project" scope based on their source directory.
 */

import type { AsyncFileSystem } from "@gent/core/domain/extension-client"
import type { Path } from "effect"

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

const discoverDir = async (
  dir: string,
  kind: DiscoveredTuiExtension["kind"],
  fs: AsyncFileSystem,
  path: Path.Path,
): Promise<DiscoveredTuiExtension[]> => {
  const exists = await fs.exists(dir)
  if (!exists) return []

  let entries: string[]
  try {
    entries = await fs.readDirectory(dir)
  } catch {
    return []
  }

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
    let info: { type: string }
    try {
      info = await fs.stat(filePath) // oxlint-disable-line no-await-in-loop -- sequential: type determines action
    } catch {
      continue
    }

    if (info.type === "File" && isClientFile(entry)) {
      results.push({ filePath, kind })
    } else if (info.type === "Directory") {
      let subEntries: string[]
      try {
        subEntries = await fs.readDirectory(filePath) // oxlint-disable-line no-await-in-loop
      } catch {
        continue
      }
      const clientFiles = subEntries.filter((e) => CLIENT_INDEX_PATTERN.test(e)).sort()
      if (clientFiles.length > 1) {
        console.log(
          `[tui-ext] Warning: multiple client entrypoints in ${filePath}: ${clientFiles.join(", ")}. Using ${clientFiles[0]}.`,
        )
      }
      const firstClient = clientFiles[0]
      if (firstClient !== undefined) {
        results.push({ filePath: path.join(filePath, firstClient), kind })
      }
    }
  }

  return results.sort((a, b) => a.filePath.localeCompare(b.filePath))
}

/** Discover TUI extension files from user and project directories. */
export const discoverTuiExtensions = async (
  opts: {
    readonly userDir: string
    readonly projectDir: string
  },
  fs: AsyncFileSystem,
  path: Path.Path,
): Promise<ReadonlyArray<DiscoveredTuiExtension>> => {
  const [user, project] = await Promise.all([
    discoverDir(opts.userDir, "user", fs, path),
    discoverDir(opts.projectDir, "project", fs, path),
  ])
  return [...user, ...project]
}
