// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-hand-rolled-module-path` does NOT fire. The test
// harness backs the platform itself, so it reads its own path directly.

export const here = new URL(import.meta.url).pathname
