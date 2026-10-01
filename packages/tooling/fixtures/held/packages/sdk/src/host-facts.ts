// @ts-nocheck — held-shapes fixture
// Retired: gent/no-bun-outside-adapter (7a96103e6). The SDK composes a
// server; its host facts come from GentPlatform.
import { homedir } from "node:os" // held-by: effect/noNodeBuiltinImport

export const platform = process.platform // held-by: effect/noGlobals
export const pid = process.pid // held-by: effect/noGlobals
export const proc = Bun.spawn(["echo", "hi"]) // held-by: effect/noGlobals
export const home = homedir()
