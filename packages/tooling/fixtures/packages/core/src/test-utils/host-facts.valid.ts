// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` does NOT fire
// The test harness backs the platform itself, so it reads host facts directly.
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

export const cwd = process.cwd()
export const digest = createHash("sha256")
export const file = fileURLToPath(url)
