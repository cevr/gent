import { Effect, Schema } from "effect"
import { CapabilityError, ExtensionId, request } from "@gent/core/extensions/api"
import { AutoRead, AutoWrite } from "./auto-controller.js"

export const AUTO_EXTENSION_ID = ExtensionId.make("@gent/auto")

const capabilityError = (capabilityId: string, cause: unknown) =>
  new CapabilityError({
    extensionId: AUTO_EXTENSION_ID,
    capabilityId,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

const AutoSnapshotLearning = Schema.Struct({
  iteration: Schema.Number,
  content: Schema.String,
})

/** Snapshot reply schema. Carries enough state for both:
 *   - interceptors (active + iteration + maxIterations + goal)
 *   - the prompt projection (learnings, lastSummary, nextIdea) — replaces the
 *     workflow's previous `derive().promptSections` path that was lost when
 *     `WorkflowContribution.turn` was deleted in C2.
 *  The TUI widget consumes only the interceptor-shaped fields. */
export const AutoSnapshotReply = Schema.Struct({
  active: Schema.Boolean,
  phase: Schema.optional(Schema.Literals(["working", "awaiting-review"])),
  iteration: Schema.optional(Schema.Number),
  maxIterations: Schema.optional(Schema.Number),
  goal: Schema.optional(Schema.String),
  learnings: Schema.optional(Schema.Array(AutoSnapshotLearning)),
  lastSummary: Schema.optional(Schema.String),
  nextIdea: Schema.optional(Schema.String),
})
export type AutoSnapshotReply = typeof AutoSnapshotReply.Type

export const AutoRpc = {
  StartAuto: request({
    id: "auto.start",
    extensionId: AUTO_EXTENSION_ID,
    intent: "write",
    input: Schema.Struct({
      goal: Schema.String,
      maxIterations: Schema.optional(Schema.Number),
    }),
    output: Schema.Void,
    execute: (input) =>
      Effect.gen(function* () {
        const auto = yield* AutoWrite
        yield* auto.start(input)
      }).pipe(Effect.mapError((cause) => capabilityError("auto.start", cause))),
  }),
  RequestHandoff: request({
    id: "auto.request-handoff",
    extensionId: AUTO_EXTENSION_ID,
    intent: "write",
    input: Schema.Struct({ content: Schema.String }),
    output: Schema.Void,
    execute: (input) =>
      Effect.gen(function* () {
        const auto = yield* AutoWrite
        yield* auto.requestHandoff(input.content)
      }).pipe(Effect.mapError((cause) => capabilityError("auto.request-handoff", cause))),
  }),
  CancelAuto: request({
    id: "auto.cancel",
    extensionId: AUTO_EXTENSION_ID,
    intent: "write",
    input: Schema.Struct({}),
    output: Schema.Void,
    execute: () =>
      Effect.gen(function* () {
        const auto = yield* AutoWrite
        yield* auto.cancel()
      }).pipe(Effect.mapError((cause) => capabilityError("auto.cancel", cause))),
  }),
  ToggleAuto: request({
    id: "auto.toggle",
    extensionId: AUTO_EXTENSION_ID,
    intent: "write",
    input: Schema.Struct({
      goal: Schema.optional(Schema.String),
      maxIterations: Schema.optional(Schema.Number),
    }),
    output: Schema.Void,
    execute: (input) =>
      Effect.gen(function* () {
        const auto = yield* AutoWrite
        yield* auto.toggle(input)
      }).pipe(Effect.mapError((cause) => capabilityError("auto.toggle", cause))),
  }),
  IsActive: request({
    id: "auto.is-active",
    extensionId: AUTO_EXTENSION_ID,
    intent: "read",
    input: Schema.Struct({}),
    output: Schema.Boolean,
    execute: () =>
      Effect.gen(function* () {
        const auto = yield* AutoRead
        return yield* auto.isActive()
      }).pipe(Effect.mapError((cause) => capabilityError("auto.is-active", cause))),
  }),
  /** Read the current workflow snapshot. Replaces `getUiSnapshot(@gent/auto)`
   *  self-reads from the auto-handoff and journal interceptors — workflows
   *  expose state through typed protocols, not the UI snapshot pipe. */
  GetSnapshot: request({
    id: "auto.snapshot",
    extensionId: AUTO_EXTENSION_ID,
    intent: "read",
    input: Schema.Struct({}),
    output: AutoSnapshotReply,
    execute: () =>
      Effect.gen(function* () {
        const auto = yield* AutoRead
        return yield* auto.snapshot()
      }).pipe(Effect.mapError((cause) => capabilityError("auto.snapshot", cause))),
  }),
}
