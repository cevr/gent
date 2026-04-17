// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-define-extension-throw` fires
// The `setup` callback throws synchronously instead of using Effect.fail.
declare const definePackage: (cfg: unknown) => unknown

export const ext = definePackage({
  id: "@example/ext",
  setup: () => {
    throw new Error("missing prereq during setup")
  },
})
