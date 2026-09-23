// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` does NOT fire
// Subpath modules are not host facts, and a file URL goes through Path.
import { describe } from "bun:test"
import { Database } from "bun:sqlite"

export const here = path.fromFileUrl(new URL(import.meta.url))
export const sibling = path.fromFileUrl(new URL("./cell.ts", import.meta.url))
export const cwd = runtimeEnvironment.cwd
export const used = [describe, Database]
