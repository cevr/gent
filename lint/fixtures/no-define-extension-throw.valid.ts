// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-define-extension-throw` does NOT fire
declare const definePackage: (cfg: unknown) => unknown
declare const Effect: { fail: (e: unknown) => unknown; gen: (f: () => unknown) => unknown }
declare class ExtensionLoadError {
  constructor(p: { message: string })
}

// Valid: setup returns an Effect with typed error channel
export const ext = definePackage({
  id: "@example/ext",
  setup: () => Effect.fail(new ExtensionLoadError({ message: "missing prereq" })),
})

// Valid: throws inside other callbacks (not `setup`) are runtime semantics
export const other = definePackage({
  id: "@example/other",
  resolveModel: () => {
    throw new Error("model not available")
  },
  setup: () =>
    Effect.gen(function* () {
      // ok: throws inside a deeper nested function are NOT this rule's concern
      const f = () => {
        throw new Error("deferred")
      }
      return f
    }),
})
