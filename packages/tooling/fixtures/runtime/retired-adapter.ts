// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` fires
// Retired Bun APIs are banned even in an adapter: `Bun.Glob` gave way to Effect
// `FileSystem`, and `Bun.randomUUIDv7` belongs to GentPlatform alone.
declare const Bun: {
  Glob: new (pattern: string) => { match: (path: string) => boolean }
  randomUUIDv7: () => string
}

export const matcher = new Bun.Glob("**/*.ts")
export const id = Bun.randomUUIDv7()
