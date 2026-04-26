import { Schema } from "effect"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import { BranchId, SessionId } from "@gent/core/domain/ids.js"
import { ReasoningEffort } from "@gent/core/domain/agent.js"

export interface Session {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
  readonly reasoningLevel: ReasoningEffort | undefined
}

const SessionSchema: Schema.Schema<Session> = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.String,
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
})

export type SessionState =
  | { readonly status: "none" }
  | { readonly status: "creating" }
  | { readonly status: "active"; readonly session: Session }

export const SessionStateEvent = TaggedEnumClass("SessionStateEvent", {
  CreateRequested: {},
  CreateSucceeded: { session: SessionSchema },
  CreateFailed: {},
  Activated: { session: SessionSchema },
  Clear: {},
  UpdateName: { name: Schema.String },
  UpdateBranch: { branchId: BranchId },
  UpdateReasoningLevel: { reasoningLevel: Schema.UndefinedOr(ReasoningEffort) },
})
export type SessionStateEvent = Schema.Schema.Type<typeof SessionStateEvent>

export const SessionState = {
  none: (): SessionState => ({ status: "none" }),
  creating: (): SessionState => ({ status: "creating" }),
  active: (session: Session): SessionState => ({ status: "active", session }),
}

const mapActive = (state: SessionState, update: (session: Session) => Session): SessionState =>
  state.status === "active" ? SessionState.active(update(state.session)) : state

export function transitionSessionState(
  state: SessionState,
  event: SessionStateEvent,
): SessionState {
  switch (event._tag) {
    case "CreateRequested":
      return SessionState.creating()
    case "CreateSucceeded":
    case "Activated":
      return SessionState.active(event.session)
    case "CreateFailed":
    case "Clear":
      return SessionState.none()
    case "UpdateName":
      return mapActive(state, (session) => ({ ...session, name: event.name }))
    case "UpdateBranch":
      return mapActive(state, (session) => ({ ...session, branchId: event.branchId }))
    case "UpdateReasoningLevel":
      return mapActive(state, (session) => ({ ...session, reasoningLevel: event.reasoningLevel }))
  }
}
