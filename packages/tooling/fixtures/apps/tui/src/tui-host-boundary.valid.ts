// The TUI host reads core's client entries; extension views live under extensions/.
import { SessionId } from "@gent/core/protocol"
import { ref } from "@gent/core/extensions/api"

export const id = SessionId
export const makeRef = ref
