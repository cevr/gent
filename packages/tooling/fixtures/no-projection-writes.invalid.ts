// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-projection-writes` fires
// Query handlers must be read-only. The three forms below — factory call,
// typed VariableDeclarator, and `satisfies` expression — each contain a
// write-shaped method call inside `handler` and should each report.
declare const query: (cfg: unknown) => unknown
declare const store: {
  create: (x: unknown) => unknown
  update: (id: string, patch: unknown) => unknown
  delete: (id: string) => unknown
  set: (k: string, v: unknown) => unknown
  write: (x: unknown) => unknown
  get: (id: string) => unknown
}
declare type QueryContribution = unknown
declare type AnyQueryContribution = unknown

// Form 1: factory call — `.update(` inside handler
export const a = query({
  id: "a",
  handler: () => store.update("x", { v: 1 }),
})

// Form 2: VariableDeclarator with `QueryContribution` annotation — `.create(` inside handler
export const b: QueryContribution = {
  id: "b",
  handler: () => store.create({ v: 2 }),
}

// Form 3: TSSatisfiesExpression — `.delete(` inside handler
export const c = {
  id: "c",
  handler: () => store.delete("x"),
} satisfies AnyQueryContribution
