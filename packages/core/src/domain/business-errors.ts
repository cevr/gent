import { Schema } from "effect"

// Entity not found at the server-mutation/query boundary.
// Distinct from generic StorageError so clients can branch on missing-entity
// versus other storage failures without string-matching messages.
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  message: Schema.String,
  entity: Schema.Literals(["session", "branch", "message", "driver"]),
}) {}

// Business-rule violation surfaced from the server-side mutation layer
// (e.g. "cannot delete the active branch", "branch has child sessions").
// Distinct from NotFoundError so clients can tell missing-entity from
// invalid-operation without string-matching messages.
export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()(
  "InvalidStateError",
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {}
