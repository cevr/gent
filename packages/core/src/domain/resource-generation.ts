import { Schema } from "effect"

/**
 * Process-local identity for one live resource generation.
 *
 * This is not a durable resource revision. A restarted process creates new
 * generation identities while durable configuration keeps its own revision.
 */
export const ResourceGenerationId = Schema.NonEmptyString.pipe(Schema.brand("ResourceGenerationId"))
export type ResourceGenerationId = typeof ResourceGenerationId.Type
