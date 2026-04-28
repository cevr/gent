import { Schema } from "effect"

/** Failure raised by a turn projection reaction. Carries slot id + cause for diagnostics. */
export class ProjectionError extends Schema.TaggedErrorClass<ProjectionError>()("ProjectionError", {
  projectionId: Schema.String,
  reason: Schema.String,
}) {}
