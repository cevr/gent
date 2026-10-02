// @ts-nocheck — held-shapes fixture
// Test code. Held by the repo config, not a retired rule: `Bun.fetch` is a
// read-only property the test preload's network guard cannot replace, so
// test code reaches the network only through the guarded `globalThis.fetch`.
import { fetch as bunFetch } from "bun" // held-by: effect/noNodeBuiltinImport

export const member = () => Bun.fetch("http://127.0.0.1/") // held-by: effect/noGlobals
export const throughGlobal = () => globalThis.Bun.fetch("http://127.0.0.1/") // held-by: effect/noGlobals
export const imported = () => bunFetch("http://127.0.0.1/")
