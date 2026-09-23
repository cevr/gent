// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` does NOT fire
declare const platform: { pid: number }

export const pid = platform.pid
