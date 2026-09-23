// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` does NOT fire
// Filename matches `*-adapter.ts`, so platform-specific Bun APIs are allowed.
declare const Bun: {
  file: (path: string) => { text: () => Promise<string> }
}

export const source = Bun.file("package.json")
