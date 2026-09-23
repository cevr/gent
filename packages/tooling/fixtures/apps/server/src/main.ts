// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` fires
// The server launcher reads its environment and calls Gent.server; it reads
// no host facts of its own.
declare const process: { execPath: string }

export const execPath = process.execPath
