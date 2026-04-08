/**
 * Codegen — scans builtins/ for *.client.{ts,tsx} files and generates a
 * static import registry. Bun's bundler needs these reachable at compile
 * time for the binary.
 *
 * Run: bun scripts/generate-builtin-imports.ts
 */

import { readdirSync, writeFileSync, readFileSync } from "fs"
import { join, dirname, basename } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const builtinsDir = join(__dirname, "..", "src", "extensions", "builtins")
const outFile = join(builtinsDir, "index.ts")

const CLIENT_PATTERN = /\.client\.tsx?$/

const files = readdirSync(builtinsDir)
  .filter((f) => CLIENT_PATTERN.test(f) && f !== "index.ts")
  .sort()

const imports: string[] = []
const names: string[] = []

for (const file of files) {
  const base = basename(file).replace(CLIENT_PATTERN, "")
  // camelCase the import name: "auto" → "auto", "tools" → "tools"
  const name = `builtin${base.charAt(0).toUpperCase()}${base.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`
  const importPath = `./${file.replace(/\.tsx?$/, "")}`
  imports.push(`import ${name} from "${importPath}"`)
  names.push(name)
}

const content = `/**
 * AUTO-GENERATED — do not edit manually.
 * Run: bun scripts/generate-builtin-imports.ts
 */

import type { ExtensionClientModule } from "@gent/core/domain/extension-client.js"

${imports.join("\n")}

export const builtinClientModules: ReadonlyArray<ExtensionClientModule> = [
  ${names.join(",\n  ")},
]
`

// Only write if content changed
let existing = ""
try {
  existing = readFileSync(outFile, "utf8")
} catch {
  // file doesn't exist yet
}

if (existing !== content) {
  writeFileSync(outFile, content)
  console.log(`Generated ${outFile} (${files.length} builtins)`)
} else {
  console.log(`${outFile} is up to date`)
}
