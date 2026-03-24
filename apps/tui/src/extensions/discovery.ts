/**
 * TUI extension discovery — scan extension directories for *.client.* files.
 *
 * Mirrors the server's discoverDir() but for client-side modules only.
 * Files are tagged with "user" or "project" scope based on their source directory.
 *
 * Uses Node builtins (not Effect services) because this runs synchronously at
 * TUI startup before the Effect runtime is available.
 */

// @effect-diagnostics nodeBuiltinImport:off
import { readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"

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

const discoverDir = (dir: string, kind: "user" | "project"): DiscoveredTuiExtension[] => {
  if (!existsSync(dir)) return []

  const entries = readdirSync(dir)
  const results: DiscoveredTuiExtension[] = []

  for (const entry of entries) {
    if (
      entry.startsWith(".") ||
      entry.startsWith("_") ||
      entry === "__tests__" ||
      entry === "node_modules"
    )
      continue

    const filePath = join(dir, entry)
    const stat = statSync(filePath)

    if (stat.isFile() && isClientFile(entry)) {
      results.push({ filePath, kind })
    } else if (stat.isDirectory()) {
      // Check for client.{tsx,ts,js,jsx,mjs} in subdirectory
      const subEntries = readdirSync(filePath)
      for (const subEntry of subEntries) {
        if (CLIENT_INDEX_PATTERN.test(subEntry)) {
          results.push({ filePath: join(filePath, subEntry), kind })
          break
        }
      }
    }
  }

  return results.sort((a, b) => a.filePath.localeCompare(b.filePath))
}

/** Discover TUI extension files from user and project directories */
export const discoverTuiExtensions = (opts: {
  readonly userDir: string
  readonly projectDir: string
}): ReadonlyArray<DiscoveredTuiExtension> => [
  ...discoverDir(opts.userDir, "user"),
  ...discoverDir(opts.projectDir, "project"),
]
