// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-host-fact-bypass` fires once. The TUI host reads no
// host global past `effect/noGlobals`; it is a process host, so a path built
// from its own module URL is its own business.

export const execPath = globalThis.process.execPath
export const root = new URL(import.meta.url).pathname
