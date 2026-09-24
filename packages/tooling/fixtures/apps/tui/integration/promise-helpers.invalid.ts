// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-promise-control-flow-in-tests` fires once. An
// `integration/` helper is test code like a `tests/` one.
export const settled = () => work().then((value) => value)
