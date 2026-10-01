// @ts-nocheck — held-shapes fixture
// Retired: gent/no-bun-outside-adapter (7a96103e6), gent/no-host-fact-bypass
// (f12e3076f), gent/no-dynamic-imports (d7ef1eb17). Core source takes its
// working directory, host modules and ids through Effect services.
import { hostname } from "node:os" // held-by: effect/noNodeBuiltinImport
import os from "os" // held-by: effect/noNodeBuiltinImport
import { $ } from "bun" // held-by: effect/noNodeBuiltinImport
import { createHash } from "crypto" // held-by: effect/noNodeBuiltinImport
import { randomBytes } from "node:crypto" // held-by: effect/noNodeBuiltinImport
import { fileURLToPath } from "node:url" // held-by: effect/noNodeBuiltinImport
import { pathToFileURL } from "url" // held-by: effect/noNodeBuiltinImport
import "node:crypto" // held-by: effect/noNodeBuiltinImport

export const cwd = process.cwd() // held-by: effect/noGlobals
export const fallback = globalThis.process.cwd() // held-by: effect/noGlobals
export const pid = globalThis["process"].pid // held-by: effect/noGlobals
export const execPath = process.execPath // held-by: effect/noGlobals
export const platform = process.platform // held-by: effect/noGlobals
process.kill(1, 0) // held-by: effect/noGlobals
export const id = Bun.randomUUIDv7() // held-by: effect/noGlobals
export const home = Bun.env["HOME"] // held-by: effect/noGlobals
export const args = Bun.argv.slice(2) // held-by: effect/noGlobals
export const proc = globalThis.Bun.spawn(["echo", "hi"]) // held-by: effect/noGlobals
export const spawnRef = Bun["spawn"] // held-by: effect/noGlobals
export const hasher = new Bun.CryptoHasher("sha256") // held-by: effect/noGlobals
export const here = new URL(import.meta.url).pathname // held-by: gent/no-hand-rolled-module-path
export const lazyCrypto = import("node:crypto") // held-by: effect/noDynamicImports
export const requiredUrl = require("node:url") // held-by: effect/noDynamicImports
export const requiredCrypto = module.require("node:crypto") // held-by: effect/noDynamicImports
export const used = [hostname, os, $, createHash, randomBytes, fileURLToPath, pathToFileURL]
