import { Schema } from "effect"
import { BranchId, ModelId, ReasoningEffort, SessionId } from "@gent/core/protocol"

export interface Session {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
  // eslint-disable-next-line effect/noNullish -- RPC session snapshots omit an unset model.
  readonly modelId: ModelId | undefined
  // eslint-disable-next-line effect/noNullish -- RPC session snapshots omit an unset reasoning level.
  readonly reasoningLevel: ReasoningEffort | undefined
}

/** The session's mutable settings, always carried whole. */
export interface SessionSettings {
  // eslint-disable-next-line effect/noNullish -- an unset model falls back to the agent's.
  readonly modelId: ModelId | undefined
  // eslint-disable-next-line effect/noNullish -- an unset level falls back to the agent's.
  readonly reasoningLevel: ReasoningEffort | undefined
}

export const sessionSettings = (session: Session): SessionSettings => ({
  modelId: session.modelId,
  reasoningLevel: session.reasoningLevel,
})

const SessionSchema: Schema.Schema<Session> = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.String,
  // eslint-disable-next-line effect/noNullish -- RPC session snapshots omit an unset model.
  modelId: Schema.UndefinedOr(ModelId),
  // eslint-disable-next-line effect/noNullish -- RPC session snapshots omit an unset reasoning level.
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
})

export type SessionState =
  | { readonly status: "none" }
  | { readonly status: "creating" }
  | { readonly status: "active"; readonly session: Session }

export const SessionStateEvent = Schema.TaggedUnion({
  CreateRequested: {},
  CreateSucceeded: { session: SessionSchema },
  CreateFailed: {},
  Activated: { session: SessionSchema },
  Clear: {},
  UpdateName: { name: Schema.String },
  UpdateBranch: { branchId: BranchId },
  UpdateSettings: {
    // eslint-disable-next-line effect/noNullish -- RPC updates preserve an unset model.
    modelId: Schema.UndefinedOr(ModelId),
    // eslint-disable-next-line effect/noNullish -- RPC updates preserve an unset reasoning level.
    reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
  },
})
export type SessionStateEvent = Schema.Schema.Type<typeof SessionStateEvent>

export const SessionState = {
  none: (): SessionState => ({ status: "none" }),
  creating: (): SessionState => ({ status: "creating" }),
  active: (session: Session): SessionState => ({ status: "active", session }),
}

const mapActive = (state: SessionState, update: (session: Session) => Session): SessionState => {
  if (state.status === "active") return SessionState.active(update(state.session))
  return state
}

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
    case "UpdateSettings":
      return mapActive(state, (session) => ({
        ...session,
        modelId: event.modelId,
        reasoningLevel: event.reasoningLevel,
      }))
  }
}
