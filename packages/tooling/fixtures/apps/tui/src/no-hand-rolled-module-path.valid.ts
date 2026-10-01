// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-hand-rolled-module-path` does NOT fire. The TUI is
// a process host, so a path built from its own module URL is its own business.

export const root = new URL(import.meta.url).pathname
