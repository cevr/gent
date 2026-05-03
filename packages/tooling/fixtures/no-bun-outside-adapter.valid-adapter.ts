// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` does NOT fire
// Filename ends in `-adapter.ts` (the convention for platform boundaries),
// so `Bun.*` references are allowed.
declare const Bun: {
  randomUUIDv7: () => string
  env: Record<string, string | undefined>
  CryptoHasher: new (algo: string) => { update: (s: string) => unknown }
}

export const id = Bun.randomUUIDv7()
export const home = Bun.env["HOME"]
export const hasher = new Bun.CryptoHasher("sha256")
