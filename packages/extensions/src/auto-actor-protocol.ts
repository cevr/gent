import { Schema } from "effect"
import { ServiceKey, TaggedEnumClass } from "@gent/core/extensions/api"
import type { AutoSnapshotReply } from "./auto-protocol.js"

export const AutoMsg = TaggedEnumClass("AutoMsg", {
  StartAuto: { goal: Schema.String, maxIterations: Schema.optional(Schema.Number) },
  CancelAuto: {},
  ToggleAuto: {
    goal: Schema.optional(Schema.String),
    maxIterations: Schema.optional(Schema.Number),
  },
  AutoSignal: {
    status: Schema.Literals(["continue", "complete", "abandon"]),
    summary: Schema.String,
    learnings: Schema.optional(Schema.String),
    metrics: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
    nextIdea: Schema.optional(Schema.String),
  },
  RequestHandoff: { content: Schema.String },
  ReviewSignal: {},
  TurnCompleted: {},
  IsActive: TaggedEnumClass.askVariant<boolean>()({}),
  GetSnapshot: TaggedEnumClass.askVariant<AutoSnapshotReply>()({}),
  DrainFollowUp: TaggedEnumClass.askVariant<string | undefined>()({}),
})
export type AutoMsg = Schema.Schema.Type<typeof AutoMsg>

export const AutoService = ServiceKey<AutoMsg>("@gent/auto/workflow")
