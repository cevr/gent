// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` does NOT fire
// Subpath modules are not host facts, a file URL goes through Path, and a
// host module name used as data or a method on a service is not a host fact.
import { describe } from "bun:test"
import { Database } from "bun:sqlite"

export const here = path.fromFileUrl(new URL(import.meta.url))
export const sibling = path.fromFileUrl(new URL("./cell.ts", import.meta.url))
export const cwd = runtimeEnvironment.cwd
export const moduleName = "url"
export const note = logger.info("crypto subsystem ready")
export type Tag = "node:crypto-fact"
export const digest = platform.hash("sha256", input)
export const bytes = crypto.randomBytes(32)
export const file = platform.fileURLToPath(url)
export const resolved = gentPlatform.fileURLToPath(import.meta.resolve("x"))
export const used = [describe, Database]
