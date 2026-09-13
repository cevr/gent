import { Schema } from "effect"

// Entity not found at the server-mutation/query boundary. Distinct from
// generic StorageError so clients can branch on the tag.
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  message: Schema.String,
}) {}

// Business-rule violation surfaced from the server-side mutation layer
// (e.g. "cannot delete the active branch", "branch has child sessions").
export class InvalidStateError extends Schema.TaggedError<InvalidStateError>()(
  "InvalidStateError",
  { message: Schema.String },
) {}
