// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-host-fact-bypass` does NOT fire. A dotted host
// global read is `effect/noGlobals`'s to report, a file URL goes through
// Path, and other globals and look-alike names are no host facts.

export const proc = Bun.spawn(["echo", "hi"])
export const here = path.fromFileUrl(new URL(import.meta.url))
export const sibling = path.fromFileUrl(new URL("./cell.ts", import.meta.url))
export const fetcher = globalThis.fetch
export const named = config["Bun"]
export const field = settings.process.cwd
