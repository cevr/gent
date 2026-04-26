import { Schema } from "effect"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import type { AuthAuthorization, AuthMethod } from "@gent/core/domain/auth-method"
import type { AuthProviderInfo } from "@gent/core/domain/auth-guard"

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
const AuthProviderInfoSchema = Schema.Any as unknown as Schema.Schema<AuthProviderInfo>
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
const AuthMethodSchema = Schema.Any as unknown as Schema.Schema<AuthMethod>
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
const AuthAuthorizationSchema = Schema.Any as unknown as Schema.Schema<AuthAuthorization>

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

export const AuthEvent = TaggedEnumClass("AuthEvent", {
  LoadStarted: {},
  Loaded: {
    providers: Schema.Array(AuthProviderInfoSchema),
    methods: Schema.Record(Schema.String, Schema.Array(AuthMethodSchema)),
  },
  LoadFailed: { error: Schema.String },
  SelectProvider: { index: Schema.Number },
  SelectMethod: { index: Schema.Number },
  OpenMethod: {},
  StartKey: {},
  StartOAuthAuthorization: {},
  StartOAuth: {
    authorization: AuthAuthorizationSchema,
    method: AuthMethodSchema,
    providerIndex: Schema.Number,
    methodIndex: Schema.Number,
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
): AuthState =>
  state._tag === "List" ? list({ ...catalogOf(state), providerIndex: event.index }) : state

const onSelectMethod = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "SelectMethod" }>,
): AuthState => (state._tag === "Method" ? method({ ...state, methodIndex: event.index }) : state)

const onOpenMethod = (state: AuthState): AuthState =>
  state._tag === "List"
    ? method({
        ...catalogOf(state),
        providerIndex: state.providerIndex,
        methodIndex: 0,
      })
    : state

const onStartKey = (state: AuthState): AuthState =>
  state._tag === "Method"
    ? key({ ...catalogOf(state), providerIndex: state.providerIndex, value: "" })
    : state

const onStartOAuthAuthorization = (state: AuthState): AuthState =>
  state._tag === "Method" ? method({ ...state, authorizing: true }) : state

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
    phase: event.authorization.method === "auto" ? "waiting" : "idle",
  })

const onTypeKey = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "TypeKey" }>,
): AuthState =>
  state._tag === "Key"
    ? key({
        ...catalogOf(state),
        providerIndex: state.providerIndex,
        value: state.value + event.char,
      })
    : state

const onBackspaceKey = (state: AuthState): AuthState =>
  state._tag === "Key"
    ? key({
        ...catalogOf(state),
        providerIndex: state.providerIndex,
        value: state.value.slice(0, -1),
      })
    : state

const onPasteKey = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "PasteKey" }>,
): AuthState =>
  state._tag === "Key"
    ? key({
        ...catalogOf(state),
        providerIndex: state.providerIndex,
        value: state.value + event.text,
      })
    : state

const onSubmitKeyStarted = (state: AuthState): AuthState =>
  state._tag === "Key" ? key({ ...state, submitting: true }) : state

const onTypeCode = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "TypeCode" }>,
): AuthState =>
  state._tag === "OAuth" ? oauth({ ...state, code: state.code + event.char }) : state

const onBackspaceCode = (state: AuthState): AuthState =>
  state._tag === "OAuth" ? oauth({ ...state, code: state.code.slice(0, -1) }) : state

const onPasteCode = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "PasteCode" }>,
): AuthState =>
  state._tag === "OAuth" ? oauth({ ...state, code: state.code + event.text }) : state

const onSubmitOAuthStarted = (state: AuthState): AuthState =>
  state._tag === "OAuth" ? oauth({ ...state, submitting: true }) : state

const onDeleteStarted = (state: AuthState): AuthState =>
  state._tag === "List" ? list({ ...state, deleting: true }) : state

const onCancel = (state: AuthState): AuthState => list(catalogOf(state))

const onActionSucceeded = (state: AuthState): AuthState => list(catalogOf(state))

const onActionFailed = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "ActionFailed" }>,
): AuthState => {
  switch (state._tag) {
    case "List":
      return list({ ...catalogOf(state), error: event.error })
    case "Method":
      return method({ ...state, authorizing: false, error: event.error })
    case "Key":
      return key({ ...state, submitting: false, error: event.error })
    case "OAuth":
      return oauth({ ...state, submitting: false, error: event.error })
    case "Loading":
      return list({ ...catalogOf(state), error: event.error })
  }
}

const onOAuthAutoFailed = (
  state: AuthState,
  event: Extract<AuthEvent, { readonly _tag: "OAuthAutoFailed" }>,
): AuthState =>
  state._tag === "OAuth"
    ? oauth({ ...state, phase: "idle", submitting: false, error: event.error })
    : state

const transitionByTag = {
  LoadStarted: onLoadStarted,
  Loaded: onLoaded,
  LoadFailed: onLoadFailed,
  SelectProvider: onSelectProvider,
  SelectMethod: onSelectMethod,
  OpenMethod: onOpenMethod,
  StartKey: onStartKey,
  StartOAuthAuthorization: onStartOAuthAuthorization,
  StartOAuth: onStartOAuth,
  TypeKey: onTypeKey,
  BackspaceKey: onBackspaceKey,
  PasteKey: onPasteKey,
  SubmitKeyStarted: onSubmitKeyStarted,
  TypeCode: onTypeCode,
  BackspaceCode: onBackspaceCode,
  PasteCode: onPasteCode,
  SubmitOAuthStarted: onSubmitOAuthStarted,
  DeleteStarted: onDeleteStarted,
  Cancel: onCancel,
  ActionSucceeded: onActionSucceeded,
  ActionFailed: onActionFailed,
  OAuthAutoFailed: onOAuthAutoFailed,
} satisfies {
  [K in AuthEvent["_tag"]]: (
    state: AuthState,
    event: Extract<AuthEvent, { readonly _tag: K }>,
  ) => AuthState
}

export function transitionAuth(state: AuthState, event: AuthEvent): AuthState {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TUI adapter narrows heterogeneous framework value shape
  const handler = transitionByTag[event._tag] as (state: AuthState, event: AuthEvent) => AuthState
  return handler(state, event)
}
