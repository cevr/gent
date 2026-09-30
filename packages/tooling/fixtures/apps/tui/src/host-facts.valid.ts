// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` does NOT fire
declare const env: Record<string, string | undefined>

export const authDirectory = env["GENT_AUTH_DIRECTORY"]
