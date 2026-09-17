/**
 * `auth-state` — the auth pane's screen, and nothing else.
 *
 * The pane shows one of four screens. Which screen it shows, which
 * provider it is about, and what the reader has typed into it is the
 * whole of this state; everything else the pane needs it reads from the
 * catalog it was loaded with.
 *
 * Three things this reducer used to carry are gone, because nothing read
 * them: a `Loading` screen the render treated exactly like an empty
 * `List`, and the `deleting` / `authorizing` / `submitting` in-flight
 * flags, which no render path and no key handler ever consulted. An RPC
 * that is in flight is already visible as the screen not having changed
 * yet, and the route's version counter is what actually decides whether
 * its reply still counts.
 *
 * Cursor movement is gone too: `SelectList` owns the selected row for
 * both the provider list and the method list, so a screen below the list
 * records only the provider it was opened *for*, and an OAuth flow only
 * the method index it was started with.
 *
 * @module
 */

import { Match, Option, Schema } from "effect"
import { AuthAuthorization, AuthMethod, AuthProviderInfo } from "@gent/core/protocol"

/**
 * What the server said, held between screens.
 *
 * The pane re-reads this rather than copying pieces of it into each
 * screen: a provider's `hasKey` changes under a screen that is already
 * open, and the screen should not show a stale copy.
 */
export interface AuthCatalog {
  readonly providers: ReadonlyArray<AuthProviderInfo>
  readonly methods: Readonly<Record<string, ReadonlyArray<AuthMethod>>>
}

const emptyCatalog: AuthCatalog = { providers: [], methods: {} }

/**
 * The four screens.
 *
 * `List` is the pane at rest — the provider picker, and the screen every
 * failure and every completed action returns to. `Method` names the
 * provider a reader chose. `Key` and `OAuth` are the two ways a provider
 * is authorised, and each holds the text the reader types into it.
 */
const AuthScreen = Schema.TaggedUnion({
  List: {},
  Method: { provider: Schema.String },
  Key: { provider: Schema.String, value: Schema.String },
  OAuth: {
    provider: Schema.String,
    methodIndex: Schema.Finite,
    method: AuthMethod,
    authorization: AuthAuthorization,
    code: Schema.String,
    /** `waiting` means the browser is expected to finish it without a code. */
    waiting: Schema.Boolean,
  },
})
export type AuthScreen = Schema.Schema.Type<typeof AuthScreen>

export interface AuthState {
  /**
   * Absent until the server answers.
   *
   * This is not the same as "the server answered with nothing", and the
   * pane must not confuse them: enforced auth closes itself the moment
   * no required provider is missing, and an empty catalog satisfies that
   * vacuously. An `Option` says which of the two it is; a plain empty
   * catalog would close the pane before its first load returned.
   */
  readonly catalog: Option.Option<AuthCatalog>
  readonly screen: AuthScreen
  readonly error: Option.Option<string>
}

export const AuthState = {
  initial: (): AuthState => ({
    catalog: Option.none(),
    screen: AuthScreen.cases.List.make({}),
    error: Option.none(),
  }),
}

/** What the pane draws with: the loaded catalog, or nothing yet. */
export const catalogOf = (state: AuthState): AuthCatalog =>
  Option.getOrElse(state.catalog, () => emptyCatalog)

export const AuthEvent = Schema.TaggedUnion({
  /** The server answered `listProviders` + `listMethods`. */
  Loaded: {
    providers: Schema.Array(AuthProviderInfo),
    methods: Schema.Record(Schema.String, Schema.Array(AuthMethod)),
  },
  /** A load or an action failed; the pane falls back to the list and says why. */
  Failed: { error: Schema.String },
  /** A provider was chosen from the list. */
  OpenMethod: { provider: Schema.String },
  /** An `api` method was chosen: type a key. */
  OpenKey: { provider: Schema.String },
  /** An `oauth` method returned an authorization to complete. */
  OpenOAuth: {
    provider: Schema.String,
    methodIndex: Schema.Finite,
    method: AuthMethod,
    authorization: AuthAuthorization,
  },
  /** Text typed or pasted into whichever of `Key` / `OAuth` is open. */
  Type: { text: Schema.String },
  Backspace: {},
  /** The browser leg of an `auto` flow failed; fall back to pasting a code. */
  OAuthAutoFailed: { error: Schema.String },
  /** Escape, or an action that finished: back to the list, error cleared. */
  Close: {},
})
export type AuthEvent = Schema.Schema.Type<typeof AuthEvent>

const list = (state: AuthState, error: Option.Option<string>): AuthState => ({
  catalog: state.catalog,
  screen: AuthScreen.cases.List.make({}),
  error,
})

/** Typing and backspace apply to whichever screen holds text. */
const editText = (state: AuthState, edit: (current: string) => string): AuthState =>
  Match.value(state.screen).pipe(
    Match.tagsExhaustive({
      List: () => state,
      Method: () => state,
      Key: (screen) => ({
        ...state,
        screen: AuthScreen.cases.Key.make({ ...screen, value: edit(screen.value) }),
      }),
      OAuth: (screen) => ({
        ...state,
        screen: AuthScreen.cases.OAuth.make({ ...screen, code: edit(screen.code) }),
      }),
    }),
  )

export function transitionAuth(state: AuthState, event: AuthEvent): AuthState {
  const apply: (event: AuthEvent) => AuthState = Match.type<AuthEvent>().pipe(
    Match.tagsExhaustive({
      Loaded: (event) => ({
        catalog: Option.some({ providers: event.providers, methods: event.methods }),
        screen: AuthScreen.cases.List.make({}),
        error: Option.none(),
      }),
      Failed: (event) => list(state, Option.some(event.error)),
      OpenMethod: (event) => ({
        ...state,
        screen: AuthScreen.cases.Method.make({ provider: event.provider }),
        error: Option.none(),
      }),
      OpenKey: (event) => ({
        ...state,
        screen: AuthScreen.cases.Key.make({ provider: event.provider, value: "" }),
        error: Option.none(),
      }),
      OpenOAuth: (event) => ({
        ...state,
        screen: AuthScreen.cases.OAuth.make({
          provider: event.provider,
          methodIndex: event.methodIndex,
          method: event.method,
          authorization: event.authorization,
          code: "",
          waiting: event.authorization.method === "auto",
        }),
        error: Option.none(),
      }),
      Type: (event) => editText(state, (current) => current + event.text),
      Backspace: () => editText(state, (current) => current.slice(0, -1)),
      OAuthAutoFailed: (event) => {
        if (state.screen._tag !== "OAuth") return state
        return {
          ...state,
          screen: AuthScreen.cases.OAuth.make({ ...state.screen, waiting: false }),
          error: Option.some(event.error),
        }
      },
      Close: () => list(state, Option.none()),
    }),
  )
  return apply(event)
}

/** The methods the server offers for a provider, empty when it offers none. */
export const methodsFor = (catalog: AuthCatalog, provider: string): ReadonlyArray<AuthMethod> =>
  Option.getOrElse(
    Option.fromNullishOr(catalog.methods[provider]),
    (): ReadonlyArray<AuthMethod> => [],
  )

/** The provider a screen is about, looked up in the live catalog. */
export const providerFor = (
  catalog: AuthCatalog,
  provider: string,
): Option.Option<AuthProviderInfo> =>
  Option.fromNullishOr(catalog.providers.find((entry) => entry.provider === provider))

/** The required providers that still have no credentials. */
export const missingRequired = (catalog: AuthCatalog): ReadonlyArray<AuthProviderInfo> =>
  catalog.providers.filter((entry) => entry.required && !entry.hasKey)
