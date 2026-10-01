// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-hand-rolled-module-path` fires 7 times. Core source
// reads its own file path through Effect `Path.fromFileUrl`, not off a URL
// or the host's `import.meta` path facts.

export const here = new URL(import.meta.url).pathname
export const href = new URL(import.meta.url).href
export const sibling = new URL("./worker.ts", import.meta.url).pathname
export const dir = import.meta.dir
export const dirname = import.meta.dirname
export const filename = import.meta.filename
export const modulePath = import.meta.path
