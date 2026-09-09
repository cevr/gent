import { SessionId } from "@gent/core/protocol/domain/ids"
export { EventStore } from "@gent/core/domain/event"
export const sessionId = SessionId
export const loadRuntime = () => import("@gent/core/runtime/session-runtime")
