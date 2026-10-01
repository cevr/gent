// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-host-fact-bypass` fires 5 times. Core source reads
// no host global past `effect/noGlobals`, and hand-rolls no file path.

export const cwd = globalThis.process.cwd()
export const proc = globalThis.Bun.spawn(["echo", "hi"])
export const pid = globalThis["process"].pid
export const spawn = Bun["spawn"]
export const here = new URL(import.meta.url).pathname
