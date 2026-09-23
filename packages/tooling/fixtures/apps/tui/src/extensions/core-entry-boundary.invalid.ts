import { SessionId } from "@gent/core/protocol/domain/ids"
import { GentPlatform } from "@gent/core/host"
import { waitFor } from "@gent/core/test-utils"
export { EventStore } from "@gent/core/domain/event"
export const values = [SessionId, GentPlatform, waitFor]
export const loadRuntime = () => import("@gent/core/runtime/session-runtime")
