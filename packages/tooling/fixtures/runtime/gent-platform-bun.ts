// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-host-fact-bypass` does NOT fire. Filename matches
// `runtime/gent-platform-bun.ts` (the GentPlatform live impl), which reads Bun
// and the host directly.

export const id = globalThis.Bun.randomUUIDv7()
export const home = Bun["env"]["HOME"]
export const pid = globalThis.process.pid
