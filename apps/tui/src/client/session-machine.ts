/**
 * Session lifecycle state machine (effect-machine)
 *
 * States: None → Creating/Loading → Active → None
 * Handles session CRUD transitions; side effects (RPC) in component.
 */

import { Schema } from "effect"
import { Event, Machine, State } from "effect-machine"

// ============================================================================
// Schemas
// ============================================================================

const SessionSchema = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
  name: Schema.String,
  bypass: Schema.Boolean,
})

// ============================================================================
// State & Events
// ============================================================================

export const SessionMachineState = State({
  None: {},
  Creating: {},
  Loading: {},
  Active: {
    session: SessionSchema,
  },
  Switching: {
    fromSession: SessionSchema,
    toSessionId: Schema.String,
  },
})

export const SessionMachineEvent = Event({
  // Lifecycle
  CreateRequested: {},
  CreateSucceeded: { session: SessionSchema },
  CreateFailed: {},
  SwitchRequested: {
    session: SessionSchema,
  },
  SwitchFromActive: {
    fromSession: SessionSchema,
    toSessionId: Schema.String,
  },
  LoadRequested: {},
  Activated: { session: SessionSchema },
  Clear: {},

  // In-flight updates (from event stream)
  UpdateName: { name: Schema.String },
  UpdateBranch: { branchId: Schema.String },
  UpdateBypass: { bypass: Schema.Boolean },
})

// ============================================================================
// Machine
// ============================================================================

export const sessionMachine = Machine.make({
  state: SessionMachineState,
  event: SessionMachineEvent,
  initial: SessionMachineState.None,
})
  // ── None transitions ──
  .on(
    SessionMachineState.None,
    SessionMachineEvent.CreateRequested,
    () => SessionMachineState.Creating,
  )
  .on(
    SessionMachineState.None,
    SessionMachineEvent.LoadRequested,
    () => SessionMachineState.Loading,
  )
  .on(SessionMachineState.None, SessionMachineEvent.Activated, ({ event }) =>
    SessionMachineState.Active({ session: event.session }),
  )

  // ── Creating transitions ──
  .on(SessionMachineState.Creating, SessionMachineEvent.CreateSucceeded, ({ event }) =>
    SessionMachineState.Active({ session: event.session }),
  )
  .on(
    SessionMachineState.Creating,
    SessionMachineEvent.CreateFailed,
    () => SessionMachineState.None,
  )

  // ── Loading transitions ──
  .on(SessionMachineState.Loading, SessionMachineEvent.Activated, ({ event }) =>
    SessionMachineState.Active({ session: event.session }),
  )

  // ── Active transitions ──
  .on(SessionMachineState.Active, SessionMachineEvent.Clear, () => SessionMachineState.None)
  .on(SessionMachineState.Active, SessionMachineEvent.SwitchFromActive, ({ event }) =>
    SessionMachineState.Switching({
      fromSession: event.fromSession,
      toSessionId: event.toSessionId,
    }),
  )
  .on(SessionMachineState.Active, SessionMachineEvent.UpdateName, ({ state, event }) =>
    SessionMachineState.Active({
      session: { ...state.session, name: event.name },
    }),
  )
  .on(SessionMachineState.Active, SessionMachineEvent.UpdateBranch, ({ state, event }) =>
    SessionMachineState.Active({
      session: { ...state.session, branchId: event.branchId },
    }),
  )
  .on(SessionMachineState.Active, SessionMachineEvent.UpdateBypass, ({ state, event }) =>
    SessionMachineState.Active({
      session: { ...state.session, bypass: event.bypass },
    }),
  )

  // ── Switching transitions ──
  .on(SessionMachineState.Switching, SessionMachineEvent.Activated, ({ event }) =>
    SessionMachineState.Active({ session: event.session }),
  )
  .build()
