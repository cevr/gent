import { Schema } from "effect"

/**
 * Identity of one live process. A process-local tool binding names the
 * process that recorded it and is never valid after a restart.
 */
export const ProcessGenerationId = Schema.NonEmptyString.pipe(Schema.brand("ProcessGenerationId"))
export type ProcessGenerationId = typeof ProcessGenerationId.Type
