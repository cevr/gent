/**
 * Domain-layer error brands.
 *
 * Every brand here is referenced by a domain interface's failure channel.
 * They live in `domain/` because putting a class in `storage/` or
 * `providers/` would force the domain layer to back-import infrastructure.
 * One definition per brand; infrastructure imports it from here.
 *
 * @module
 */
import { Schema } from "effect"

// ── business-errors ─────────────────────────────────────────────────────────

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

// ── provider-error ──────────────────────────────────────────────────────────

// A model call that failed. The turn and model resolution raise it.
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  message: Schema.String,
  model: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// ── storage-error ───────────────────────────────────────────────────────────

// Consumed by every persistence-touching service; domain interfaces such as
// `SessionMutationsService` reference it in their failure channel.
export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Wrap a raw failure as a StorageError; a StorageError passes through unchanged. */
export const storageError = (message: string) => (cause: unknown) => {
  if (Schema.is(StorageError)(cause)) return cause
  return new StorageError({ message, cause })
}

/** Like storageError, but failures the guard accepts cross the storage boundary unchanged. */
export const storageErrorExcept =
  <E>(passThrough: (cause: unknown) => cause is E) =>
  (message: string) =>
  (cause: unknown): StorageError | E => {
    if (passThrough(cause)) return cause
    return storageError(message)(cause)
  }
