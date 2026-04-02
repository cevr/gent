import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import type { ReasoningEffort } from "@gent/core/domain/agent.js"

export interface Session {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
  readonly reasoningLevel: ReasoningEffort | undefined
}

export type SessionState =
  | { readonly status: "none" }
  | { readonly status: "creating" }
  | { readonly status: "active"; readonly session: Session }

export type SessionStateEvent =
  | { readonly _tag: "CreateRequested" }
  | { readonly _tag: "CreateSucceeded"; readonly session: Session }
  | { readonly _tag: "CreateFailed" }
  | { readonly _tag: "Activated"; readonly session: Session }
  | { readonly _tag: "Clear" }
  | { readonly _tag: "UpdateName"; readonly name: string }
  | { readonly _tag: "UpdateBranch"; readonly branchId: BranchId }
  | { readonly _tag: "UpdateReasoningLevel"; readonly reasoningLevel: ReasoningEffort | undefined }

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
