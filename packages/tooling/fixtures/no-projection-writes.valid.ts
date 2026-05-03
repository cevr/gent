// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-projection-writes` does NOT fire
// Read-only handlers (only `.get`/`.list`/`.find`) are fine. A non-query
// factory call with a write method is also fine — the rule only fences
// `query(...)` handlers and typed Query contributions.
declare const query: (cfg: unknown) => unknown
declare const someOtherFactory: (cfg: unknown) => unknown
declare const store: {
  create: (x: unknown) => unknown
  update: (id: string, patch: unknown) => unknown
  get: (id: string) => unknown
  list: () => unknown
  find: (id: string) => unknown
}
declare type QueryContribution = unknown

// Valid: query handler reads only
export const a = query({
  id: "a",
  handler: () => store.get("x"),
})

// Valid: typed Query contribution reads only
export const b: QueryContribution = {
  id: "b",
  handler: () => store.list(),
}

// Valid: not a query factory — write methods allowed
export const c = someOtherFactory({
  id: "c",
  handler: () => store.update("x", { v: 1 }),
})
