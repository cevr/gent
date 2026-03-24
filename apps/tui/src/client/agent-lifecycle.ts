import type { AgentEvent } from "@gent/core/domain/event"
import type { AgentName } from "@gent/core/domain/agent"

export type AgentLifecycleStatus =
  | { readonly _tag: "idle" }
  | { readonly _tag: "streaming" }
  | { readonly _tag: "error"; readonly error: string }

export interface AgentLifecycleUpdate {
  readonly status?: AgentLifecycleStatus
  readonly preferredAgent?: AgentName
}

export const reduceAgentLifecycle = (event: AgentEvent): AgentLifecycleUpdate => {
  switch (event._tag) {
    case "StreamStarted":
      return { status: { _tag: "streaming" } }

    case "TurnCompleted":
      return { status: { _tag: "idle" } }

    case "ErrorOccurred":
      return { status: { _tag: "error", error: event.error } }

    case "AgentSwitched":
      return { preferredAgent: event.toAgent }

    case "MessageReceived":
      if (event.role === "user") return { status: { _tag: "streaming" } }
      return {}

    default:
      return {}
  }
}
