/**
 * Domain-layer storage error.
 *
 * `StorageError` is a tagged error consumed by every persistence-touching
 * service. It lives in `domain/` because domain interfaces (e.g.
 * `SessionMutationsService`) reference it in their failure channel — putting
 * the class in `storage/` would force domain to back-import infrastructure.
 *
 * The concrete SQLite-backed storage layer (`storage/sqlite-storage.ts`)
 * imports the same class via re-export. There is one definition; the brand
 * lives in domain.
 *
 * @module
 */
import { Schema } from "effect"

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("StorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}
