// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` does NOT fire
// Filename matches `*-adapter.ts`, so platform-specific Bun APIs are allowed.
declare const Bun: {
  Glob: new (pattern: string) => { match: (path: string) => boolean }
}

export const matcher = new Bun.Glob("**/*.ts")
