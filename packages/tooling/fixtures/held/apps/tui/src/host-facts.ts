// @ts-nocheck — held-shapes fixture
// Retired: gent/no-bun-outside-adapter (7a96103e6), gent/no-host-fact-bypass
// (f12e3076f). The TUI reads no host facts of its own.
export const execPath = process.execPath // held-by: effect/noGlobals
export const viaGlobal = globalThis.process.execPath // held-by: effect/noGlobals
export const id = Bun.randomUUIDv7() // held-by: effect/noGlobals
