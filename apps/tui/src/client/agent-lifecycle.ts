import type { AgentName } from "@gent/core/domain/agent"
import type { AgentEvent } from "@gent/core/domain/event"
import { AgentStatus } from "./agent-state"

export interface AgentLifecycleUpdate {
  readonly status?: AgentStatus
  readonly preferredAgent?: AgentName
}

export const reduceAgentLifecycle = (event: AgentEvent): AgentLifecycleUpdate => {
  switch (event._tag) {
    case "StreamStarted":
      return { status: AgentStatus.Streaming.make({}) }

    case "TurnCompleted":
      return { status: AgentStatus.Idle.make({}) }

    case "ErrorOccurred":
      return { status: AgentStatus.Error.make({ error: event.error }) }

    case "AgentSwitched":
      return { preferredAgent: event.toAgent }

    case "MessageReceived":
      if (event.message.role === "user") {
        return { status: AgentStatus.Streaming.make({}) }
      }
      return {}

    default:
      return {}
  }
}
