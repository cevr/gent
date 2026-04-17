// @ts-nocheck — fixture file
// EXPECTED: rule `gent/all-errors-are-tagged` fires for FooError + FooFailure
export class FooError extends Error {
  readonly _tag = "FooError"
}

export class FooFailure extends Error {}
