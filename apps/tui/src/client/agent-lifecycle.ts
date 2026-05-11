import type { AgentName } from "@gent/core-internal/domain/agent"
import type { AgentEvent } from "@gent/core-internal/domain/event"
import { AgentStatus } from "./agent-state"

export interface AgentLifecycleUpdate {
  readonly status?: AgentStatus
  readonly preferredAgent?: AgentName
}

export const reduceAgentLifecycle = (event: AgentEvent): AgentLifecycleUpdate => {
  switch (event._tag) {
    case "StreamStarted":
      return { status: AgentStatus.cases["streaming"].make({}) }

    case "TurnCompleted":
      return { status: AgentStatus.cases["idle"].make({}) }

    case "ErrorOccurred":
      return { status: AgentStatus.cases["error"].make({ error: event.error }) }

    case "AgentSwitched":
      return { preferredAgent: event.toAgent }

    case "MessageReceived":
      if (event.message.role === "user") {
        return { status: AgentStatus.cases["streaming"].make({}) }
      }
      return {}

    default:
      return {}
  }
}
