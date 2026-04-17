// @ts-nocheck — fixture file
// EXPECTED: rule `gent/all-errors-are-tagged` does NOT fire
import { Schema } from "effect"

export class FooError extends Schema.TaggedErrorClass<FooError>("FooError")("FooError", {
  message: Schema.String,
}) {}

// Names that don't end in Error/Failure are unaffected
export class SomeRegularClass extends Object {}

// Classes without `extends` are unaffected
export class StandaloneError {}
