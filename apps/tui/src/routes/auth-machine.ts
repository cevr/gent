/**
 * Auth flow state machine (effect-machine)
 *
 * States: List → Method → Key/OAuth → (Success/Error) → List
 * Effects: authorize, submitApi, submitOAuth, reload
 */

import { Schema } from "effect"
import { Event, Machine, State } from "effect-machine"

// ============================================================================
// Schemas for state data
// ============================================================================

const ProviderInfoSchema = Schema.Struct({
  provider: Schema.String,
  hasKey: Schema.Boolean,
  required: Schema.Boolean,
  source: Schema.optional(Schema.String),
  authType: Schema.optional(Schema.String),
})

const AuthMethodSchema = Schema.Struct({
  type: Schema.String,
  label: Schema.String,
})

const AuthorizationSchema = Schema.Struct({
  url: Schema.String,
  method: Schema.Literal("auto", "code"),
  authorizationId: Schema.String,
  instructions: Schema.optional(Schema.String),
})

// ============================================================================
// State & Events
// ============================================================================

export const AuthState = State({
  List: {
    providers: Schema.Array(ProviderInfoSchema),
    methods: Schema.Record({ key: Schema.String, value: Schema.Array(AuthMethodSchema) }),
    providerIndex: Schema.Number,
    error: Schema.optional(Schema.String),
  },
  Method: {
    providers: Schema.Array(ProviderInfoSchema),
    methods: Schema.Record({ key: Schema.String, value: Schema.Array(AuthMethodSchema) }),
    providerIndex: Schema.Number,
    methodIndex: Schema.Number,
    error: Schema.optional(Schema.String),
  },
  Key: {
    providers: Schema.Array(ProviderInfoSchema),
    methods: Schema.Record({ key: Schema.String, value: Schema.Array(AuthMethodSchema) }),
    providerIndex: Schema.Number,
    value: Schema.String,
    error: Schema.optional(Schema.String),
  },
  OAuth: {
    providers: Schema.Array(ProviderInfoSchema),
    methods: Schema.Record({ key: Schema.String, value: Schema.Array(AuthMethodSchema) }),
    providerIndex: Schema.Number,
    methodIndex: Schema.Number,
    method: AuthMethodSchema,
    authorization: AuthorizationSchema,
    code: Schema.String,
    phase: Schema.Literal("idle", "waiting"),
    error: Schema.optional(Schema.String),
  },
})

export const AuthEvent = Event({
  // Data
  Loaded: {
    providers: Schema.Array(ProviderInfoSchema),
    methods: Schema.Record({ key: Schema.String, value: Schema.Array(AuthMethodSchema) }),
  },
  LoadFailed: { error: Schema.String },

  // Navigation
  SelectProvider: { index: Schema.Number },
  SelectMethod: { index: Schema.Number },
  OpenMethod: {},
  StartKey: {},
  StartOAuth: {
    authorization: AuthorizationSchema,
    method: AuthMethodSchema,
    providerIndex: Schema.Number,
    methodIndex: Schema.Number,
  },
  StartOAuthAuto: {},

  // Input
  TypeKey: { char: Schema.String },
  BackspaceKey: {},
  TypeCode: { char: Schema.String },
  BackspaceCode: {},
  PasteKey: { text: Schema.String },
  PasteCode: { text: Schema.String },

  // Actions
  SubmitKey: {},
  SubmitOAuth: {},
  Delete: {},
  Cancel: {},

  // Results
  ActionSucceeded: {},
  ActionFailed: { error: Schema.String },
  OAuthAutoFailed: { error: Schema.String },
})

// ============================================================================
// Machine
// ============================================================================

const listData = (state: typeof AuthState.Type) => ({
  providers: state.providers,
  methods: state.methods,
})

export const authMachine = Machine.make({
  state: AuthState,
  event: AuthEvent,
  initial: AuthState.List({
    providers: [],
    methods: {},
    providerIndex: 0,
  }),
})
  // ── List transitions ──
  .on(AuthState.List, AuthEvent.Loaded, ({ state, event }) =>
    AuthState.List({
      ...listData(state),
      providers: event.providers,
      methods: event.methods,
      providerIndex: Math.min(state.providerIndex, Math.max(0, event.providers.length - 1)),
    }),
  )
  .on(AuthState.List, AuthEvent.LoadFailed, ({ state, event }) =>
    AuthState.List({ ...listData(state), providerIndex: state.providerIndex, error: event.error }),
  )
  .on(AuthState.List, AuthEvent.SelectProvider, ({ state, event }) =>
    AuthState.List({ ...listData(state), providerIndex: event.index }),
  )
  .on(AuthState.List, AuthEvent.OpenMethod, ({ state }) =>
    AuthState.Method({ ...listData(state), providerIndex: state.providerIndex, methodIndex: 0 }),
  )
  .on(AuthState.List, AuthEvent.ActionSucceeded, ({ state }) =>
    AuthState.List({ ...listData(state), providerIndex: state.providerIndex }),
  )
  .on(AuthState.List, AuthEvent.ActionFailed, ({ state, event }) =>
    AuthState.List({
      ...listData(state),
      providerIndex: state.providerIndex,
      error: event.error,
    }),
  )

  // ── Method transitions ──
  .on(AuthState.Method, AuthEvent.SelectMethod, ({ state, event }) =>
    AuthState.Method({
      ...listData(state),
      providerIndex: state.providerIndex,
      methodIndex: event.index,
    }),
  )
  .on(AuthState.Method, AuthEvent.Cancel, ({ state }) =>
    AuthState.List({ ...listData(state), providerIndex: state.providerIndex }),
  )
  .on(AuthState.Method, AuthEvent.StartKey, ({ state }) =>
    AuthState.Key({ ...listData(state), providerIndex: state.providerIndex, value: "" }),
  )
  .on(AuthState.Method, AuthEvent.StartOAuth, ({ event, state }) =>
    AuthState.OAuth({
      ...listData(state),
      providerIndex: event.providerIndex,
      methodIndex: event.methodIndex,
      method: event.method,
      authorization: event.authorization,
      code: "",
      phase: event.authorization.method === "auto" ? "waiting" : "idle",
    }),
  )
  .on(AuthState.Method, AuthEvent.ActionFailed, ({ state, event }) =>
    AuthState.List({
      ...listData(state),
      providerIndex: state.providerIndex,
      error: event.error,
    }),
  )

  // ── Key transitions ──
  .on(AuthState.Key, AuthEvent.Cancel, ({ state }) =>
    AuthState.List({ ...listData(state), providerIndex: state.providerIndex }),
  )
  .on(AuthState.Key, AuthEvent.TypeKey, ({ state, event }) =>
    AuthState.Key({
      ...listData(state),
      providerIndex: state.providerIndex,
      value: state.value + event.char,
    }),
  )
  .on(AuthState.Key, AuthEvent.BackspaceKey, ({ state }) =>
    AuthState.Key({
      ...listData(state),
      providerIndex: state.providerIndex,
      value: state.value.slice(0, -1),
    }),
  )
  .on(AuthState.Key, AuthEvent.PasteKey, ({ state, event }) =>
    AuthState.Key({
      ...listData(state),
      providerIndex: state.providerIndex,
      value: state.value + event.text,
    }),
  )
  .on(AuthState.Key, AuthEvent.ActionSucceeded, ({ state }) =>
    AuthState.List({ ...listData(state), providerIndex: state.providerIndex }),
  )
  .on(AuthState.Key, AuthEvent.ActionFailed, ({ state, event }) =>
    AuthState.Key({
      ...listData(state),
      providerIndex: state.providerIndex,
      value: state.value,
      error: event.error,
    }),
  )

  // ── OAuth transitions ──
  .on(AuthState.OAuth, AuthEvent.Cancel, ({ state }) =>
    AuthState.List({ ...listData(state), providerIndex: state.providerIndex }),
  )
  .on(AuthState.OAuth, AuthEvent.TypeCode, ({ state, event }) =>
    AuthState.OAuth({ ...state, code: state.code + event.char }),
  )
  .on(AuthState.OAuth, AuthEvent.BackspaceCode, ({ state }) =>
    AuthState.OAuth({ ...state, code: state.code.slice(0, -1) }),
  )
  .on(AuthState.OAuth, AuthEvent.PasteCode, ({ state, event }) =>
    AuthState.OAuth({ ...state, code: state.code + event.text }),
  )
  .on(AuthState.OAuth, AuthEvent.ActionSucceeded, ({ state }) =>
    AuthState.List({ ...listData(state), providerIndex: state.providerIndex }),
  )
  .on(AuthState.OAuth, AuthEvent.ActionFailed, ({ state, event }) =>
    AuthState.OAuth({ ...state, error: event.error }),
  )
  .on(AuthState.OAuth, AuthEvent.OAuthAutoFailed, ({ state, event }) =>
    AuthState.OAuth({ ...state, phase: "idle", error: event.error }),
  )
