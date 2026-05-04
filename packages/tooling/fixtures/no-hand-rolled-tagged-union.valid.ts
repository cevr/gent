// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-hand-rolled-tagged-union` does NOT fire.

import { Schema } from "effect"

// Single-variant `{ _tag: "X" }` literals are not unions; rule ignores them.
export type SingleVariant = { readonly _tag: "Solo"; readonly value: string }

// Lowercase-tag unions are schema-internal (not Pascal-case) and exempt by
// design — see the rule's PascalCase heuristic.
export type WireMode =
  | { readonly _tag: "regular"; readonly text: string }
  | { readonly _tag: "interjection"; readonly text: string }

// Mixed: only one variant has `_tag` — not a tagged union.
export type WithOneTag =
  | { readonly _tag: "Yes"; readonly value: number }
  | { readonly value: string }

// Approved alternative — Schema.TaggedStruct via `Schema.Union`.
export const Idle = Schema.TaggedStruct("Idle", {})
export const Running = Schema.TaggedStruct("Running", { pid: Schema.Number })
export const WorkerLifecycleStateSchema = Schema.Union(Idle, Running)

// Approved alternative — TaggedErrorClass for error-shape unions.
export class SpawnFailed extends Schema.TaggedErrorClass<SpawnFailed>("SpawnFailed")(
  "SpawnFailed",
  { reason: Schema.String },
) {}
export class TimedOut extends Schema.TaggedErrorClass<TimedOut>("TimedOut")("TimedOut", {
  ms: Schema.Number,
}) {}
