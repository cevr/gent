// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-hand-rolled-module-path` does NOT fire. A file URL
// goes through Path, and a URL built from anything else is no module path.

export const here = path.fromFileUrl(new URL(import.meta.url))
export const sibling = path.fromFileUrl(new URL("./cell.ts", import.meta.url))
export const site = new URL("https://example.com/a").pathname
export const meta = import.meta.url
