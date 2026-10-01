// @ts-nocheck — held-shapes fixture
// Retired: gent/no-bun-outside-adapter (7a96103e6). Shipped extensions take
// host facts through services, as core does.
import os from "os" // held-by: effect/noNodeBuiltinImport
import { createHash } from "node:crypto" // held-by: effect/noNodeBuiltinImport
import { fileURLToPath } from "url" // held-by: effect/noNodeBuiltinImport

export const cwd = process.cwd() // held-by: effect/noGlobals
export const proc = Bun.spawn(["echo", "hi"]) // held-by: effect/noGlobals
export const used = [os, createHash, fileURLToPath]
