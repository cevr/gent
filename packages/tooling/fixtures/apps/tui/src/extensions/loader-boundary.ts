import { SessionId } from "@gent/core/protocol"
import { readDisabledExtensions } from "@gent/core/host"
export { EventEnvelope } from "@gent/core/protocol.js"
export const sessionId = SessionId.make("client-session")
export const readDisabled = readDisabledExtensions
