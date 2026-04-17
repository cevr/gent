// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-dynamic-imports` does NOT fire — only static imports.

import * as Fs from "node:fs"

export const readFile = (path: string) => Fs.readFileSync(path, "utf-8")
