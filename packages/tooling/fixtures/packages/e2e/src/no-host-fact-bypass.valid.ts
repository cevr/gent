// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-host-fact-bypass` does NOT fire. The e2e harness
// reaches Bun and the host directly; only the retired members stay out.

export const proc = globalThis.Bun.spawn(["echo", "hi"])
export const env = Bun["env"]
export const pid = globalThis.process.pid
