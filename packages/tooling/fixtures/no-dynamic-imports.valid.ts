// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-dynamic-imports` does NOT fire for static imports
// or exact-site opt-ins with a reason.

import * as Fs from "node:fs"
import { createRequire } from "node:module"

export const readFile = (path: string) => Fs.readFileSync(path, "utf-8")

export const loadRuntimeDiscoveredModule = async (path: string) => {
  // gent/no-dynamic-imports: allow runtime extension path is discovered from user configuration
  return await import(path)
}

// gent/no-dynamic-imports: allow legacy package only exposes a CommonJS entrypoint
const requireLegacy = createRequire(import.meta.url)

export const loadLegacyPackage = () => {
  // gent/no-dynamic-imports: allow legacy package only exposes a CommonJS entrypoint
  return requireLegacy("legacy-package")
}
