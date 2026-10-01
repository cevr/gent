// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-hand-rolled-module-path` fires 2 times. Core source
// reads its own file path through Effect `Path.fromFileUrl`, not off a URL.

export const here = new URL(import.meta.url).pathname
export const href = new URL(import.meta.url).href
