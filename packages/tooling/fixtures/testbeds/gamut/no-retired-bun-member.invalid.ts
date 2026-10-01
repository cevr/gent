// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-retired-bun-member` fires 6 times. A script with
// `effect/noGlobals` off may reach Bun, but not its retired members.

export const files = new Bun.Glob("*")
export const computed = new Bun["Glob"]("*")
export const id = Bun.randomUUIDv7()
export const viaGlobal = new globalThis.Bun.Glob("*")
export const viaComputedGlobal = globalThis["Bun"].randomUUIDv7()
export const optional = Bun?.randomUUIDv7()
