// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-host-fact-bypass` does NOT fire. The test harness
// backs the platform itself, so it reads host facts directly.

export const cwd = globalThis.process.cwd()
export const here = new URL(import.meta.url).pathname
