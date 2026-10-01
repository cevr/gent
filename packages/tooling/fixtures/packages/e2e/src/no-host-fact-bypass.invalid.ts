// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-host-fact-bypass` fires 3 times. The e2e harness may
// reach Bun, but the retired `Bun.Glob` and `Bun.randomUUIDv7` stay out
// however they are spelled.

export const glob = new globalThis.Bun.Glob("*")
export const id = globalThis["Bun"].randomUUIDv7()
export const glob2 = new Bun["Glob"]("*")
