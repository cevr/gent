// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-retired-bun-member` does NOT fire. Other Bun members
// stay open to a script with `effect/noGlobals` off, and a `Glob` read off
// anything but Bun is no Bun member.

export const file = Bun.file("/nonexistent/gent-probe-x")
export const spawn = globalThis.Bun.spawn
export const sleep = Bun["sleep"]
export const glob = tools.Glob
export const id = ids["randomUUIDv7"]()
