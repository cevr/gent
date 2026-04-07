// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readdirSync, readFileSync } from "node:fs"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, basename } from "node:path"

const DATA_DIR = new URL("data/", import.meta.url).pathname

/** Sorted list of all principle names (without .md extension) */
export const PRINCIPLE_NAMES: ReadonlyArray<string> = readdirSync(DATA_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => basename(f, ".md"))
  .sort()

/** Lazily loaded principle content map */
let cached: Map<string, string> | undefined

export const loadPrinciples = (): Map<string, string> => {
  if (cached !== undefined) return cached
  cached = new Map<string, string>()
  for (const name of PRINCIPLE_NAMES) {
    cached.set(name, readFileSync(join(DATA_DIR, `${name}.md`), "utf-8"))
  }
  return cached
}
