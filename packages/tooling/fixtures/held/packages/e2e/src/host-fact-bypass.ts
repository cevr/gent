// @ts-nocheck — held-shapes fixture
// Retired: gent/no-host-fact-bypass (f12e3076f). The harness may reach Bun,
// but not its retired members, in any spelling.
export const glob = new globalThis.Bun.Glob("*") // held-by: effect/noGlobals
export const id = globalThis["Bun"].randomUUIDv7() // held-by: effect/noGlobals
export const computed = new Bun["Glob"]("*") // held-by: effect/noGlobals
