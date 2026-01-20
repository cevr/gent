#!/usr/bin/env bun
/**
 * Remove .js and .ts extensions from import/export statements
 */

import { Glob } from "bun"

const glob = new Glob("**/*.{ts,tsx}")
const files: string[] = []

for await (const file of glob.scan({
  cwd: process.cwd(),
  onlyFiles: true,
  absolute: true,
})) {
  // Skip node_modules and dist
  if (file.includes("node_modules") || file.includes("/dist/")) continue
  files.push(file)
}

const importRegex = /^(import|export)(.+from\s+['"])([^'"]+)(\.(?:js|ts))(['"];?)$/gm

let totalFixed = 0

for (const file of files) {
  const content = await Bun.file(file).text()
  const fixed = content.replace(importRegex, "$1$2$3$5")

  if (fixed !== content) {
    await Bun.write(file, fixed)
    const count = (content.match(importRegex) || []).length
    console.log(`${file}: ${count} import(s) fixed`)
    totalFixed += count
  }
}

console.log(`\nTotal: ${totalFixed} imports fixed across ${files.length} files scanned`)
