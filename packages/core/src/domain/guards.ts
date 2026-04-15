/** Shared type guards for narrowing unknown/JSON boundary values. */

/** Narrow an unknown value to a string-keyed record. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Narrow an unknown value to an object with a `.message` string property. */
export const hasMessage = (value: unknown): value is { message: string } =>
  isRecord(value) && typeof value["message"] === "string"

/** Type-safe JSON.parse that returns `unknown` (not `any`). */
export const parseJsonUnknown = (raw: string): unknown => JSON.parse(raw) as unknown

/** Narrow an unknown value to a readonly array of records. */
export const isRecordArray = (value: unknown): value is ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) && value.every(isRecord)
