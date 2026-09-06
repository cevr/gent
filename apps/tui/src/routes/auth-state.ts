import { Match, Schema } from "effect"
import {
  AuthAuthorization,
  AuthMethod,
  AuthProviderInfo as AuthProviderInfoSchema,
} from "@gent/core-internal/domain/auth"

type AuthProviderInfo = AuthProviderInfoSchema

type AuthCatalog = {
  readonly providers: readonly AuthProviderInfo[]
  readonly methods: Readonly<Record<string, ReadonlyArray<AuthMethod>>>
  readonly providerIndex: number
  readonly error?: string
}

type AuthMethodCatalog = AuthCatalog & {
  readonly methodIndex: number
}

export type AuthState =
  | ({
      readonly _tag: "Loading"
    } & AuthCatalog)
  | ({
      readonly _tag: "List"
      readonly deleting: boolean
    } & AuthCatalog)
  | ({
      readonly _tag: "Method"
      readonly authorizing: boolean
    } & AuthMethodCatalog)
  | ({
      readonly _tag: "Key"
      readonly value: string
      readonly submitting: boolean
    } & AuthCatalog)
  | ({
      readonly _tag: "OAuth"
      readonly methodIndex: number
      readonly method: AuthMethod
      readonly authorization: AuthAuthorization
      readonly code: string
      readonly phase: "waiting" | "idle"
      readonly submitting: boolean
    } & AuthCatalog)

export const AuthEvent = Schema.TaggedUnion({
  LoadStarted: {},
  Loaded: {
    providers: Schema.Array(AuthProviderInfoSchema),
    methods: Schema.Record(Schema.String, Schema.Array(AuthMethod)),
  },
  LoadFailed: { error: Schema.String },
  SelectProvider: { index: Schema.Finite },
  SelectMethod: { index: Schema.Finite },
  OpenMethod: {},
  StartKey: {},
  StartOAuthAuthorization: {},
  StartOAuth: {
    authorization: AuthAuthorization,
    method: AuthMethod,
    providerIndex: Schema.Finite,
    methodIndex: Schema.Finite,
  },
  TypeKey: { char: Schema.String },
  BackspaceKey: {},
  PasteKey: { text: Schema.String },
  SubmitKeyStarted: {},
  TypeCode: { char: Schema.String },
  BackspaceCode: {},
  PasteCode: { text: Schema.String },
  SubmitOAuthStarted: {},
  DeleteStarted: {},
  Cancel: {},
  ActionSucceeded: {},
  ActionFailed: { error: Schema.String },
  OAuthAutoFailed: { error: Schema.String },
})
export type AuthEvent = Schema.Schema.Type<typeof AuthEvent>

const catalogOf = (state: AuthState): AuthCatalog => ({
  providers: state.providers,
  methods: state.methods,
  providerIndex: state.providerIndex,
  error: state.error,
})

const clampProviderIndex = (providers: readonly AuthProviderInfo[], index: number) =>
  Math.min(index, Math.max(0, providers.length - 1))

const loading = (catalog?: Partial<AuthCatalog>): AuthState => ({
  _tag: "Loading",
  providers: catalog?.providers ?? [],
  methods: catalog?.methods ?? {},
  providerIndex: catalog?.providerIndex ?? 0,
  error: catalog?.error,
})

const list = (
  catalog?: Partial<AuthCatalog> & {
    readonly deleting?: boolean
  },
): AuthState => ({
  _tag: "List",
  providers: catalog?.providers ?? [],
  methods: catalog?.methods ?? {},
  providerIndex: catalog?.providerIndex ?? 0,
  deleting: catalog?.deleting ?? false,
  error: catalog?.error,
})

const method = (
  catalog: AuthMethodCatalog & {
    readonly authorizing?: boolean
  },
): AuthState => ({
  _tag: "Method",
  ...catalog,
  authorizing: catalog.authorizing ?? false,
})

const key = (
  catalog: AuthCatalog & {
    readonly value: string
    readonly submitting?: boolean
  },
): AuthState => ({
  _tag: "Key",
  ...catalog,
  submitting: catalog.submitting ?? false,
})

const oauth = (
  catalog: AuthCatalog & {
    readonly methodIndex: number
    readonly method: AuthMethod
    readonly authorization: AuthAuthorization
    readonly code: string
    readonly phase: "waiting" | "idle"
    readonly submitting?: boolean
  },
): AuthState => ({
  _tag: "OAuth",
  ...catalog,
  submitting: catalog.submitting ?? false,
})

export const AuthState = {
  initial: (): AuthState => loading(),
}

const onLoadStarted = (state: AuthState): AuthState => loading(catalogOf(state))

const onLoaded = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "Loaded" }>,
): AuthState =>
  list({
    providers: event.providers,
    methods: event.methods,
    providerIndex: clampProviderIndex(event.providers, state.providerIndex),
  })

const onLoadFailed = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "LoadFailed" }>,
): AuthState => list({ ...catalogOf(state), error: event.error })

const onSelectProvider = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "SelectProvider" }>,
): AuthState => {
  if (state._tag === "List") return list({ ...catalogOf(state), providerIndex: event.index })
  return state
}

const onSelectMethod = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "SelectMethod" }>,
): AuthState => {
  if (state._tag === "Method") return method({ ...state, methodIndex: event.index })
  return state
}

const onOpenMethod = (state: AuthState): AuthState => {
  if (state._tag !== "List") return state
  return method({
    ...catalogOf(state),
    providerIndex: state.providerIndex,
    methodIndex: 0,
  })
}

const onStartKey = (state: AuthState): AuthState => {
  if (state._tag === "Method") {
    return key({ ...catalogOf(state), providerIndex: state.providerIndex, value: "" })
  }
  return state
}

const onStartOAuthAuthorization = (state: AuthState): AuthState => {
  if (state._tag === "Method") return method({ ...state, authorizing: true })
  return state
}

const oauthPhase = (authorization: AuthAuthorization): "waiting" | "idle" => {
  if (authorization.method === "auto") return "waiting"
  return "idle"
}

const onStartOAuth = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "StartOAuth" }>,
): AuthState =>
  oauth({
    ...catalogOf(state),
    providerIndex: event.providerIndex,
    methodIndex: event.methodIndex,
    method: event.method,
    authorization: event.authorization,
    code: "",
    phase: oauthPhase(event.authorization),
  })

const onTypeKey = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "TypeKey" }>,
): AuthState => {
  if (state._tag !== "Key") return state
  return key({
    ...catalogOf(state),
    providerIndex: state.providerIndex,
    value: state.value + event.char,
  })
}

const onBackspaceKey = (state: AuthState): AuthState => {
  if (state._tag !== "Key") return state
  return key({
    ...catalogOf(state),
    providerIndex: state.providerIndex,
    value: state.value.slice(0, -1),
  })
}

const onPasteKey = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "PasteKey" }>,
): AuthState => {
  if (state._tag !== "Key") return state
  return key({
    ...catalogOf(state),
    providerIndex: state.providerIndex,
    value: state.value + event.text,
  })
}

const onSubmitKeyStarted = (state: AuthState): AuthState => {
  if (state._tag === "Key") return key({ ...state, submitting: true })
  return state
}

const onTypeCode = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "TypeCode" }>,
): AuthState => {
  if (state._tag === "OAuth") return oauth({ ...state, code: state.code + event.char })
  return state
}

const onBackspaceCode = (state: AuthState): AuthState => {
  if (state._tag === "OAuth") return oauth({ ...state, code: state.code.slice(0, -1) })
  return state
}

const onPasteCode = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "PasteCode" }>,
): AuthState => {
  if (state._tag === "OAuth") return oauth({ ...state, code: state.code + event.text })
  return state
}

const onSubmitOAuthStarted = (state: AuthState): AuthState => {
  if (state._tag === "OAuth") return oauth({ ...state, submitting: true })
  return state
}

const onDeleteStarted = (state: AuthState): AuthState => {
  if (state._tag === "List") return list({ ...state, deleting: true })
  return state
}

const onCancel = (state: AuthState): AuthState => list(catalogOf(state))

const onActionSucceeded = (state: AuthState): AuthState => list(catalogOf(state))

const onActionFailed = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "ActionFailed" }>,
): AuthState => {
  const transitionState: (state: AuthState) => AuthState = Match.type<AuthState>().pipe(
    Match.tagsExhaustive({
      List: (state) => list({ ...catalogOf(state), error: event.error }),
      Method: (state) => method({ ...state, authorizing: false, error: event.error }),
      Key: (state) => key({ ...state, submitting: false, error: event.error }),
      OAuth: (state) => oauth({ ...state, submitting: false, error: event.error }),
      Loading: (state) => list({ ...catalogOf(state), error: event.error }),
    }),
  )
  return transitionState(state)
}

const onOAuthAutoFailed = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "OAuthAutoFailed" }>,
): AuthState => {
  if (state._tag === "OAuth") {
    return oauth({ ...state, phase: "idle", submitting: false, error: event.error })
  }
  return state
}

export function transitionAuth(state: AuthState, event: AuthEvent): AuthState {
  const transitionEvent: (event: AuthEvent) => AuthState = Match.type<AuthEvent>().pipe(
    Match.tagsExhaustive({
      LoadStarted: () => onLoadStarted(state),
      Loaded: (event) => onLoaded(state, event),
      LoadFailed: (event) => onLoadFailed(state, event),
      SelectProvider: (event) => onSelectProvider(state, event),
      SelectMethod: (event) => onSelectMethod(state, event),
      OpenMethod: () => onOpenMethod(state),
      StartKey: () => onStartKey(state),
      StartOAuthAuthorization: () => onStartOAuthAuthorization(state),
      StartOAuth: (event) => onStartOAuth(state, event),
      TypeKey: (event) => onTypeKey(state, event),
      BackspaceKey: () => onBackspaceKey(state),
      PasteKey: (event) => onPasteKey(state, event),
      SubmitKeyStarted: () => onSubmitKeyStarted(state),
      TypeCode: (event) => onTypeCode(state, event),
      BackspaceCode: () => onBackspaceCode(state),
      PasteCode: (event) => onPasteCode(state, event),
      SubmitOAuthStarted: () => onSubmitOAuthStarted(state),
      DeleteStarted: () => onDeleteStarted(state),
      Cancel: () => onCancel(state),
      ActionSucceeded: () => onActionSucceeded(state),
      ActionFailed: (event) => onActionFailed(state, event),
      OAuthAutoFailed: (event) => onOAuthAutoFailed(state, event),
    }),
  )
  return transitionEvent(event)
}
