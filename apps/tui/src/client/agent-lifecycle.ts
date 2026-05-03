import { Schema } from "effect"
import type { AgentName } from "@gent/core/domain/agent"
import type { AgentEvent } from "@gent/core/domain/event"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"

export const AgentLifecycleStatus = TaggedEnumClass("AgentLifecycleStatus", {
  Idle: TaggedEnumClass.variant("idle", {}),
  Streaming: TaggedEnumClass.variant("streaming", {}),
  Error: TaggedEnumClass.variant("error", { error: Schema.String }),
})

export type AgentLifecycleStatus = Schema.Schema.Type<typeof AgentLifecycleStatus>

export interface AgentLifecycleUpdate {
  readonly status?: AgentLifecycleStatus
  readonly preferredAgent?: AgentName
}

export const reduceAgentLifecycle = (event: AgentEvent): AgentLifecycleUpdate => {
  switch (event._tag) {
    case "StreamStarted":
      return { status: AgentLifecycleStatus.Streaming.make({}) }

    case "TurnCompleted":
      return { status: AgentLifecycleStatus.Idle.make({}) }

    case "ErrorOccurred":
      return { status: AgentLifecycleStatus.Error.make({ error: event.error }) }

    case "AgentSwitched":
      return { preferredAgent: event.toAgent }

    case "MessageReceived":
      if (event.message.role === "user") {
        return { status: AgentLifecycleStatus.Streaming.make({}) }
      }
      return {}

    default:
      return {}
  }
}
