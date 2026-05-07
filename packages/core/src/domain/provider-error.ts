/**
 * Domain-layer provider error.
 *
 * `ProviderError` is a tagged error referenced by `domain/driver.ts`'s
 * `TurnExecutor` failure channel. It lives in `domain/` because the driver
 * primitive is a domain concept; putting the class in `providers/` would
 * force the domain layer to back-import infrastructure.
 *
 * Model resolution imports the same class from here. One definition; the
 * brand lives in domain.
 *
 * @module
 */
import { Schema } from "effect"

export class ProviderError extends Schema.TaggedErrorClass<ProviderError>()("ProviderError", {
  message: Schema.String,
  model: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}
