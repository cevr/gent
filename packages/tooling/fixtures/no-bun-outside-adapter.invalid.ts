// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-bun-outside-adapter` fires
// `Bun.*` references in a non-adapter file must be flagged. This fixture
// exercises both call-shaped (`Bun.randomUUIDv7()`) and value-shaped
// (`Bun.env`, `Bun.argv`) member expressions.
declare const Bun: {
  randomUUIDv7: () => string
  env: Record<string, string | undefined>
  argv: ReadonlyArray<string>
  spawn: (cmd: ReadonlyArray<string>) => unknown
  CryptoHasher: new (algo: string) => { update: (s: string) => unknown }
}

export const id = Bun.randomUUIDv7()
export const home = Bun.env["HOME"]
export const args = Bun.argv.slice(2)
export const proc = Bun.spawn(["echo", "hi"])
export const hasher = new Bun.CryptoHasher("sha256")
