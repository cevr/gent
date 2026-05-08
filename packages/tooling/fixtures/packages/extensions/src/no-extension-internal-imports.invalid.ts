import { SessionId } from "@gent/core-internal/domain/ids"
import { AgentName } from "@gent/core/domain/agent"
import { SessionRuntime } from "@gent/core/runtime/session-runtime"
import { EventStore } from "../../../core/src/domain/event"

export const values = [SessionId, AgentName, SessionRuntime, EventStore]
