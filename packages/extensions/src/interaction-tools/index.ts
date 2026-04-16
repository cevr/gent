import { Schema } from "effect"
import { Event as MEvent, Machine, State as MState } from "effect-machine"
import { extension, type ExtensionActorDefinition } from "@gent/core/extensions/api"
import { AskUserTool } from "./ask-user.js"
import { PromptTool } from "./prompt.js"

// ── Interaction actor — tracks pending approval state for snapshot-driven UI ──

export const INTERACTION_TOOLS_EXTENSION_ID = "@gent/interaction-tools"

const InteractionState = MState({
  Idle: {},
  Pending: {
    requestId: Schema.String,
    text: Schema.String,
    metadata: Schema.optional(Schema.Unknown),
  },
})

const InteractionEvent = MEvent({
  Presented: {
    requestId: Schema.String,
    text: Schema.String,
    metadata: Schema.optional(Schema.Unknown),
  },
  Resolved: {
    requestId: Schema.String,
  },
})

const interactionMachine = Machine.make({
  state: InteractionState,
  event: InteractionEvent,
  initial: InteractionState.Idle,
})
  .onAny(InteractionEvent.Presented, ({ event }) =>
    InteractionState.Pending({
      requestId: event.requestId,
      text: event.text,
      metadata: event.metadata,
    }),
  )
  .on(InteractionState.Pending, InteractionEvent.Resolved, ({ state, event }) =>
    state.requestId === event.requestId ? InteractionState.Idle : state,
  )

const InteractionSnapshotSchema = Schema.Struct({
  requestId: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
})

/** Exported for test harness access */
export const interactionActor: ExtensionActorDefinition<
  typeof InteractionState.Type,
  typeof InteractionEvent.Type
> = {
  machine: interactionMachine,
  mapEvent: (event) => {
    switch (event._tag) {
      case "InteractionPresented":
        return InteractionEvent.Presented({
          requestId: event.requestId,
          text: event.text,
          metadata: (event as { metadata?: unknown }).metadata,
        })
      case "InteractionResolved":
        return InteractionEvent.Resolved({
          requestId: event.requestId,
        })
      default:
        return undefined
    }
  },
  snapshot: {
    schema: InteractionSnapshotSchema,
    project: (state) =>
      state._tag === "Pending"
        ? { requestId: state.requestId, text: state.text, metadata: state.metadata }
        : {},
  },
}

// ── Extension ──

export const InteractionToolsExtension = extension(INTERACTION_TOOLS_EXTENSION_ID, ({ ext }) =>
  ext.tools(AskUserTool, PromptTool).actor(interactionActor),
)
