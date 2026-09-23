import { Option } from "effect"
import type { Session } from "../src/client"
import type { BranchId, SessionId } from "@gent/core/protocol"

export const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "")

export const makeSessionState = (created: {
  sessionId: SessionId
  branchId: BranchId
  name: string
}): Session => ({
  sessionId: created.sessionId,
  branchId: created.branchId,
  name: created.name,
  modelId: Option.getOrUndefined(Option.none()),
  reasoningLevel: Option.getOrUndefined(Option.none()),
})
