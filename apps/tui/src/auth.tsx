/** @jsxImportSource @opentui/solid */
import { Effect, Fiber, Match, Option, Schema } from "effect"
import {
  AuthAuthorization,
  AuthMethod,
  AuthProviderInfo,
  type SessionId,
} from "@gent/core/protocol"
import {
  createEffect,
  createSignal,
  For,
  Match as SolidMatch,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import { omitUndefined } from "@gent/core/extensions/api"
import { LinkOpener } from "./os"
import { useTheme } from "./theme"
import { useClient, useRuntime } from "./client"
import {
  ChromePanel,
  keyHint,
  KeyHints,
  PickerFrame,
  pickerHeight,
  selectable,
  SelectList,
  type SelectListRow,
  usePickerBody,
  usePickerGeometry,
} from "./ui"
import { formatError, plural, repliesInView, type ReplyWriter, type UiError } from "./utils"
import {
  pastedLine,
  type ScopedKeyboardEvent,
  typedText,
  useClipboard,
  useScopedKeyboard,
  useTerminalDimensions,
} from "./terminal"

// ── auth state ──────────────────────────────────────────────────────────────

/**
 * `auth-state` — the auth pane's screen, and nothing else.
 *
 * The pane shows one of four screens. Which screen it shows, which
 * provider it is about, and what the reader has typed into it is the
 * whole of this state; everything else the pane needs it reads from the
 * catalog it was loaded with.
 *
 * The state has no loading screen and no in-flight flags: an RPC that is
 * in flight shows as the screen not having changed yet, and the route's
 * reply writer (`repliesInView`) decides whether its reply still counts.
 *
 * The state holds no cursor: `SelectList` owns the selected row for
 * both the provider list and the method list, so a screen below the list
 * records only the provider it was opened *for*, and an OAuth flow only
 * the method index it was started with.
 *
 * @module
 */

/**
 * What the server said, held between screens.
 *
 * The pane re-reads this rather than copying pieces of it into each
 * screen: a provider's `hasKey` changes under a screen that is already
 * open, and the screen should not show a stale copy.
 */
interface AuthCatalog {
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
    /** `waiting` means sign-in (a browser callback or a device poll) finishes it without a code. */
    waiting: Schema.Boolean,
    /** No browser opened the URL; the reader opens it. The flow goes on. */
    browserUnavailable: Schema.Boolean,
  },
})
type AuthScreen = Schema.Schema.Type<typeof AuthScreen>
/** The OAuth screen: an authorization the reader completes. */
type OAuthScreen = Extract<AuthScreen, { readonly _tag: "OAuth" }>

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
const catalogOf = (state: AuthState): AuthCatalog =>
  Option.getOrElse(state.catalog, () => emptyCatalog)

export const AuthEvent = Schema.TaggedUnion({
  /** The server answered `listProviders` + `listMethods`. */
  Loaded: {
    providers: Schema.Array(AuthProviderInfo),
    methods: Schema.Record(Schema.String, Schema.Array(AuthMethod)),
  },
  /**
   * The server answered a reload after a stored key changed under a screen
   * the reader has left: the catalog is new, and the screen stays.
   */
  Refreshed: {
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
  /**
   * No browser opened the authorization URL. Opening one is a convenience,
   * so the flow keeps its screen and keeps waiting; the reader opens the URL.
   */
  BrowserUnavailable: {},
  /** An action that finished: back to the list, error cleared. */
  Close: {},
  /**
   * Escape, one step: a sign-in screen goes to its provider's methods, the
   * methods go to the list. The error clears.
   */
  Back: {},
})
export type AuthEvent = Schema.Schema.Type<typeof AuthEvent>

const list = (state: AuthState, error: Option.Option<string>): AuthState => ({
  catalog: state.catalog,
  screen: AuthScreen.cases.List.make({}),
  error,
})

const methods = (state: AuthState, provider: string): AuthState => ({
  ...state,
  screen: AuthScreen.cases.Method.make({ provider }),
  error: Option.none(),
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
      Refreshed: (event) => ({
        ...state,
        catalog: Option.some({ providers: event.providers, methods: event.methods }),
      }),
      Failed: (event) => list(state, Option.some(event.error)),
      OpenMethod: (event) => methods(state, event.provider),
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
          browserUnavailable: false,
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
      BrowserUnavailable: () => {
        if (state.screen._tag !== "OAuth") return state
        return {
          ...state,
          screen: AuthScreen.cases.OAuth.make({ ...state.screen, browserUnavailable: true }),
        }
      },
      Close: () => list(state, Option.none()),
      Back: () =>
        Match.value(state.screen).pipe(
          Match.tags({
            Key: (screen) => methods(state, screen.provider),
            OAuth: (screen) => methods(state, screen.provider),
          }),
          Match.orElse(() => list(state, Option.none())),
        ),
    }),
  )
  return apply(event)
}

/** The methods the server offers for a provider, empty when it offers none. */
const methodsFor = (catalog: AuthCatalog, provider: string): ReadonlyArray<AuthMethod> =>
  Option.getOrElse(
    Option.fromNullishOr(catalog.methods[provider]),
    (): ReadonlyArray<AuthMethod> => [],
  )

/** The provider a screen is about, looked up in the live catalog. */
const providerFor = (catalog: AuthCatalog, provider: string): Option.Option<AuthProviderInfo> =>
  Option.fromNullishOr(catalog.providers.find((entry) => entry.provider === provider))

/**
 * What gent calls a provider, in the pane and in headless errors alike: its
 * driver's name ("OpenCode"), or its id when the server sends no name. A
 * name two of `providers` share carries the id beside it: "Mirror (mirror-a)".
 */
export const providerLabel = (
  providers: ReadonlyArray<AuthProviderInfo>,
  provider: string,
): string =>
  Option.match(
    Option.flatMap(
      Option.fromNullishOr(providers.find((entry) => entry.provider === provider)),
      (entry) => Option.fromUndefinedOr(entry.name),
    ),
    {
      onNone: () => provider,
      onSome: (name) => {
        if (providers.filter((entry) => entry.name === name).length > 1)
          return `${name} (${provider})`
        return name
      },
    },
  )

/** The required providers that still have no credentials. */
const missingRequired = (catalog: AuthCatalog): ReadonlyArray<AuthProviderInfo> =>
  catalog.providers.filter((entry) => entry.required && !entry.hasKey)

// ── auth view ───────────────────────────────────────────────────────────────

/**
 * Auth pane — the ops-time screen for giving gent a provider credential.
 *
 * Four screens, each a pane docked under the composer: the provider list, the
 * method list for one provider, an API-key field, and an OAuth wait. It opens
 * by itself when a required provider has no credential, and closes by itself
 * the moment the server says every required provider has one.
 *
 * What this file does *not* do is decide anything about a credential. The
 * server owns the whole of that: which providers exist, which are required,
 * which methods each offers, what an authorization looks like, and whether a
 * key is good. Every branch here is about what the reader sees — a masked
 * field, a pasted code, a picker — and the picker is `SelectList`, which is
 * where selection, wrap-around and scroll-sync already live.
 *
 * ── Staleness ──
 *
 * A reply can outlive the screen that asked for it: the reader switches
 * agent, or presses escape, while an RPC is in flight. One counter decides
 * that. Every action bumps it and captures the new value; a reply whose
 * captured value is no longer current is dropped, unseen. Loads and actions
 * share the counter, so one rule drops both.
 *
 * @module
 */

interface AuthProps {
  sessionId: SessionId
  enforceAuth?: boolean
  onResolved?: () => void
  onClose?: () => void
}

export function Auth(props: AuthProps) {
  const { theme } = useTheme()
  const clientCtx = useClient()
  const dimensions = useTerminalDimensions()
  const { sectionWidth } = usePickerGeometry()
  const { cast } = useRuntime()
  const copyToClipboard = useClipboard()

  const [state, setState] = createSignal(AuthState.initial())
  const send = (event: AuthEvent) => setState((current) => transitionAuth(current, event))
  const catalog = () => catalogOf(state())
  /** What the pane calls `provider` ({@link providerLabel}). */
  const label = (provider: string) => providerLabel(catalog().providers, provider)

  const [autoPrompted, setAutoPrompted] = createSignal(false)
  const [flashNote, setFlashNote] = createSignal(Option.none<string>())
  const sessionId = props.sessionId

  // ── Staleness ─────────────────────────────────────────────────────

  // Each action is the newest read: its replies count until the next action.
  const actions = repliesInView(() => sessionId)
  let successTimer = Option.none<Fiber.Fiber<void, never>>()
  /**
   * The browser leg of an `auto` flow. The server holds the login, and its
   * loopback port, while this call is in flight, so the screen that started
   * it ends it: the wait stops when its OAuth screen goes (Esc, a failure,
   * a finished sign-in) and when the pane closes. A pasted code does not
   * stop it: the wait may be trading the redirect's one-use grant, and the
   * server holds the paste behind that trade.
   */
  let browserWait = Option.none<{
    readonly authorizationId: string
    readonly fiber: Fiber.Fiber<void, never>
  }>()

  const stopSuccessTimer = () => {
    if (Option.isSome(successTimer)) cast(Fiber.interrupt(successTimer.value))
    successTimer = Option.none()
  }
  const stopBrowserWait = () => {
    if (Option.isSome(browserWait)) cast(Fiber.interrupt(browserWait.value.fiber))
    browserWait = Option.none()
  }
  const clearSuccess = () => {
    stopSuccessTimer()
    setFlashNote(Option.none())
  }
  // A pane that closes stops the flash's clock and the browser wait with it.
  onCleanup(stopSuccessTimer)
  onCleanup(stopBrowserWait)

  /** Start an action: everything already in flight stops counting. */
  const begin = () => {
    clearSuccess()
    return actions.take()
  }

  /** Shows `note` in the note row for two seconds. */
  const flash = (note: string) => {
    clearSuccess()
    setFlashNote(Option.some(note))
    successTimer = Option.some(
      clientCtx.runtime.fork(
        Effect.sleep("2 seconds").pipe(
          Effect.andThen(
            Effect.sync(() => {
              setFlashNote(Option.none())
              successTimer = Option.none()
            }),
          ),
        ),
      ),
    )
  }
  const flashSuccess = (message: string) => flash(`✓ ${message}`)

  /** Run `body` only while the action that took `token` is still current. */
  const whileCurrent = (token: ReplyWriter, body: () => void) =>
    Effect.sync(() => token.write(body))

  const failed = (token: ReplyWriter) => (err: UiError) =>
    whileCurrent(token, () => send(AuthEvent.cases.Failed.make({ error: formatError(err) })))

  /**
   * A finished sign-in leaves its screen before the reload: a code typed
   * while the catalog reloads has no OAuth screen to go to, so it never
   * asks the server for the login it already finished.
   */
  const signedIn = (token: ReplyWriter, message: string) =>
    whileCurrent(token, () => {
      send(AuthEvent.cases.Close.make({}))
      flashSuccess(message)
      loadAuth(token)
    })

  // ── Loading ───────────────────────────────────────────────────────

  /** `keepScreen`: the answer refreshes the catalog only (`Refreshed`). */
  const loadAuth = (token: ReplyWriter, keepScreen = false) => {
    clientCtx.log.info("auth:load-start")
    const request = {
      ...omitUndefined({ agentName: Option.getOrUndefined(clientCtx.agent()) }),
      sessionId,
    }
    cast(
      Effect.all([
        clientCtx.client.auth.listProviders(request),
        clientCtx.client.auth.listMethods({ sessionId }),
      ]).pipe(
        Effect.tap(([providers, methods]) =>
          whileCurrent(token, () => {
            clientCtx.log.info("auth:load-complete", { providers: providers.length })
            const catalog = { providers: [...providers], methods }
            if (keepScreen) send(AuthEvent.cases.Refreshed.make(catalog))
            else send(AuthEvent.cases.Loaded.make(catalog))
          }),
        ),
        Effect.catchEager((err) =>
          whileCurrent(token, () => {
            clientCtx.log.error("auth:load", { error: String(err) })
            send(AuthEvent.cases.Failed.make({ error: formatError(err) }))
          }),
        ),
      ),
    )
  }

  // A new agent needs a fresh answer: it may require a different provider.
  createEffect(
    on(
      () => clientCtx.agent(),
      () => {
        setAutoPrompted(false)
        loadAuth(begin())
      },
      { defer: false },
    ),
  )

  // Enforced auth closes the pane the moment nothing is missing, and
  // otherwise drops the reader straight into the first provider that is.
  //
  // Both halves wait for a catalog. An unloaded pane has no missing
  // providers only because it has no providers, and closing on that would
  // dismiss the gate before its first answer arrived.
  createEffect(() => {
    const current = state()
    if (current.screen._tag !== "List") return
    if (Option.isSome(current.error)) return
    if (Option.isNone(current.catalog)) return

    const missing = missingRequired(current.catalog.value)
    if (props.enforceAuth === true && missing.length === 0) {
      Option.fromNullishOr(props.onResolved).pipe(Option.map((resolved) => resolved()))
      Option.fromNullishOr(props.onClose).pipe(Option.map((close) => close()))
      return
    }
    if (autoPrompted()) return
    const first = Option.fromNullishOr(missing[0])
    if (Option.isNone(first)) return
    setAutoPrompted(true)
    send(AuthEvent.cases.OpenMethod.make({ provider: first.value.provider }))
  })

  // ── Actions ───────────────────────────────────────────────────────

  // Signing out is destructive: the first ctrl+x arms the row, the second
  // removes the stored key, as the agents pane deletes a session.
  const [armed, setArmed] = createSignal(Option.none<string>())
  const armOrDelete = (selected: Option.Option<AuthProviderInfo>): boolean => {
    if (Option.isNone(selected) || selected.value.source !== "stored") return true
    if (Option.contains(armed(), selected.value.provider)) {
      setArmed(Option.none())
      deleteProvider(selected.value)
      return true
    }
    setArmed(Option.some(selected.value.provider))
    return true
  }

  /**
   * A key was stored or removed. While its action is current the pane says
   * so and goes back to the list. A reader who stepped back meanwhile
   * (`back`) stays where they are, but the catalog still changed: it is read
   * again under the newest action and only its rows change.
   */
  const keyChanged = (token: ReplyWriter, note: Option.Option<string>) =>
    Effect.sync(() => {
      if (!token.live()) {
        loadAuth(actions.newest(), true)
        return
      }
      Option.map(note, flashSuccess)
      loadAuth(token)
    })

  const deleteProvider = (provider: AuthProviderInfo) => {
    if (provider.source !== "stored") return
    const token = begin()
    cast(
      clientCtx.client.auth.deleteKey({ provider: provider.provider, sessionId }).pipe(
        Effect.tap(() => keyChanged(token, Option.none())),
        Effect.catchEager(failed(token)),
      ),
    )
  }

  const submitKey = (provider: string, value: string) => {
    const key = value.trim()
    if (key.length === 0) return
    const token = begin()
    clientCtx.log.info("auth:submit-key", { provider })
    cast(
      clientCtx.client.auth.setKey({ provider, key, sessionId }).pipe(
        Effect.tap(() => keyChanged(token, Option.some(`API key saved for ${label(provider)}`))),
        Effect.catchEager(failed(token)),
      ),
    )
  }

  /**
   * Open the authorization URL in a browser. A failed open never fails the
   * flow: a headless machine has no browser, and the device-code flow exists
   * for exactly that machine. The screen keeps the URL and says to open it.
   */
  const openAuthorization = (token: ReplyWriter, url: string) =>
    Effect.gen(function* () {
      clientCtx.log.info("auth:open-authorization", { url })
      const opener = yield* LinkOpener
      yield* opener.open(url)
    }).pipe(
      Effect.catchEager((err) =>
        whileCurrent(token, () => {
          clientCtx.log.warn("auth:browser-unavailable", { error: err.message })
          send(AuthEvent.cases.BrowserUnavailable.make({}))
        }),
      ),
    )

  /** The browser leg of an `auto` flow; a failure leaves a code to paste. */
  const awaitBrowserCallback = (
    token: ReplyWriter,
    provider: string,
    methodIndex: number,
    authorizationId: string,
  ) => {
    stopBrowserWait()
    browserWait = Option.some({
      authorizationId,
      fiber: clientCtx.runtime.fork(
        clientCtx.client.auth
          .callback({
            sessionId,
            provider,
            method: methodIndex,
            authorizationId,
          })
          .pipe(
            Effect.tap(() => signedIn(token, `Authenticated ${label(provider)} via OAuth`)),
            Effect.catchEager((err) =>
              whileCurrent(token, () =>
                send(AuthEvent.cases.OAuthAutoFailed.make({ error: formatError(err) })),
              ),
            ),
          ),
      ),
    })
  }

  const startMethod = (provider: string, methodIndex: number, method: AuthMethod) => {
    const token = begin()
    clientCtx.log.info("auth:start-method", { provider, method: method.type })

    if (method.type === "api") {
      send(AuthEvent.cases.OpenKey.make({ provider }))
      return
    }

    cast(
      clientCtx.client.auth.authorize({ sessionId, provider, method: methodIndex }).pipe(
        Effect.tap((authorization) =>
          whileCurrent(token, () => {
            const result = Option.fromNullishOr(authorization)
            if (Option.isNone(result)) {
              send(
                AuthEvent.cases.Failed.make({
                  error: "No authorization available for this method",
                }),
              )
              return
            }
            // "done" means the server finished it during `authorize`.
            if (result.value.method === "done") {
              flashSuccess(`Authenticated ${label(provider)}`)
              loadAuth(token)
              return
            }
            send(
              AuthEvent.cases.OpenOAuth.make({
                provider,
                methodIndex,
                method,
                authorization: result.value,
              }),
            )
          }),
        ),
        Effect.tap((authorization) => {
          if (!token.live()) return Effect.void
          const result = Option.fromNullishOr(authorization)
          if (Option.isNone(result) || result.value.method === "done") return Effect.void
          return openAuthorization(token, result.value.url).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (!token.live() || result.value.method !== "auto") return
                awaitBrowserCallback(token, provider, methodIndex, result.value.authorizationId)
              }),
            ),
          )
        }),
        Effect.catchEager(failed(token)),
      ),
    )
  }

  const submitOauth = (screen: OAuthScreen) => {
    const trimmed = screen.code.trim()
    // A "code" flow has nothing to send without one. An "auto" flow takes a
    // pasted code while its browser wait runs (the server races the two), and
    // a bare retry only once that wait has failed.
    if (trimmed.length === 0 && (screen.authorization.method === "code" || screen.waiting)) return
    const token = begin()
    clientCtx.log.info("auth:submit-oauth", {
      provider: screen.provider,
      method: screen.authorization.method,
    })
    const base = {
      sessionId,
      provider: screen.provider,
      method: screen.methodIndex,
      authorizationId: screen.authorization.authorizationId,
    }
    let code = Option.none<string>()
    if (trimmed.length > 0) code = Option.some(trimmed)
    cast(
      clientCtx.client.auth
        .callback(
          Option.match(code, {
            onNone: () => base,
            onSome: (value) => ({ ...base, code: value }),
          }),
        )
        .pipe(
          Effect.tap(() => signedIn(token, `Authenticated ${label(screen.provider)} via OAuth`)),
          Effect.catchEager(failed(token)),
        ),
    )
  }

  // Esc: one step back. A reply in flight for the screen left behind is dropped.
  const back = () => {
    begin()
    send(AuthEvent.cases.Back.make({}))
  }

  // ── Screens ───────────────────────────────────────────────────────

  const screen = () => state().screen

  // One accessor per screen. A generic `isScreen(tag)` would need a cast to
  // narrow, and narrowing is exactly what the union already does for free.
  const keyScreen = () => {
    const current = screen()
    if (current._tag === "Key") return Option.some(current)
    return Option.none()
  }
  const oauthScreen = () => {
    const current = screen()
    if (current._tag === "OAuth") return Option.some(current)
    return Option.none()
  }
  const methodScreen = () => {
    const current = screen()
    if (current._tag === "Method") return Option.some(current)
    return Option.none()
  }

  // A browser wait lives while its OAuth screen does.
  createEffect(() => {
    const current = oauthScreen()
    if (Option.isNone(browserWait)) return
    const waitedFor = browserWait.value.authorizationId
    if (Option.exists(current, (open) => open.authorization.authorizationId === waitedFor)) return
    stopBrowserWait()
  })

  /** The provider the open method screen is about, if the catalog still has it. */
  const methodProvider = () =>
    Option.flatMap(methodScreen(), (current) => providerFor(catalog(), current.provider))

  // ── Rows ──────────────────────────────────────────────────────────

  const statusColor = (provider: AuthProviderInfo) => {
    if (provider.hasKey) return theme.primary
    if (provider.required) return theme.error
    return theme.textMuted
  }
  const authLabel = (provider: AuthProviderInfo) => {
    if (!provider.hasKey) return "[none]"
    if (provider.source === "env") return "[env]"
    return `[${Option.getOrElse(Option.fromNullishOr(provider.authType), () => "stored")}]`
  }
  const requiredLabel = (provider: AuthProviderInfo) => {
    if (provider.required) return " [required]"
    return ""
  }
  const rowBackground = (selected: boolean) => {
    if (selected) return theme.primary
    return "transparent"
  }
  const rowForeground = (selected: boolean, fallback: typeof theme.text) => {
    if (selected) return theme.selectedListItemText
    return fallback
  }

  const providerRows = (): ReadonlyArray<SelectListRow<AuthProviderInfo>> =>
    catalog().providers.map((provider) =>
      selectable(provider, (isSelected, id) => (
        <box
          id={id}
          backgroundColor={rowBackground(isSelected())}
          paddingLeft={1}
          flexDirection="row"
        >
          <Show
            when={!Option.contains(armed(), provider.provider)}
            fallback={
              <text style={{ fg: theme.error }}>
                ctrl+x again to delete {label(provider.provider)} login
              </text>
            }
          >
            <text style={{ fg: rowForeground(isSelected(), theme.text) }}>
              {label(provider.provider)}
            </text>
            <text style={{ fg: rowForeground(isSelected(), statusColor(provider)) }}>
              {" "}
              {authLabel(provider)}
              {requiredLabel(provider)}
            </text>
          </Show>
        </box>
      )),
    )

  /** A method row carries its own index: the server addresses methods by position. */
  interface MethodChoice {
    readonly index: number
    readonly method: AuthMethod
  }

  const methodRows = (): ReadonlyArray<SelectListRow<MethodChoice>> =>
    Option.match(methodScreen(), {
      onNone: (): ReadonlyArray<SelectListRow<MethodChoice>> => [],
      onSome: (current) =>
        methodsFor(catalog(), current.provider).map((method, index) =>
          selectable({ index, method }, (isSelected, id) => (
            <box
              id={id}
              backgroundColor={rowBackground(isSelected())}
              paddingLeft={1}
              flexDirection="row"
            >
              <text style={{ fg: rowForeground(isSelected(), theme.text) }}>{method.label}</text>
              <text style={{ fg: rowForeground(isSelected(), theme.textMuted) }}>
                {" "}
                [{method.type}]
              </text>
            </box>
          )),
        ),
    })

  // ── Frames ────────────────────────────────────────────────────────
  //
  // Each screen is its own docked pane: a `PickerFrame` under the composer,
  // mounted while its screen shows, so a screen never draws another's rows.
  // The list screens size themselves from their `SelectList`; the key and
  // OAuth screens ask for the rows they draw.

  // An enforced sign-in holds the slot: Esc on its list does nothing (closing
  // it would only open it again), and the way out is ctrl+c.
  const enforced = () => props.enforceAuth === true
  const listLeave = () => {
    if (enforced()) return KeyHints.exit
    return KeyHints.close
  }
  // The row under the cursor: ctrl+x is offered only where a stored key can go.
  const [cursor, setCursor] = createSignal(Option.none<AuthProviderInfo>())
  const listKeys = () => {
    if (Option.isSome(state().error)) return [keyHint("r", "retry"), listLeave()]
    if (Option.exists(cursor(), (provider) => provider.source === "stored"))
      return [KeyHints.move, KeyHints.select, KeyHints.delete, listLeave()]
    return [KeyHints.move, KeyHints.select, listLeave()]
  }
  const dismissList = () => {
    if (enforced()) return
    Option.map(Option.fromNullishOr(props.onClose), (onClose) => onClose())
  }
  // An empty list is still loading, unless its load failed: then it says how to retry.
  const listLoading = () => Option.isNone(state().error)
  const retryRow = () =>
    Option.map(state().error, () => <text style={{ fg: theme.textMuted }}> Press r to retry.</text>)
  const keyMask = (value: string) => "*".repeat(value.length)
  const codeLabel = (method: string) => {
    if (method === "code") return "Paste code:"
    return "Paste code (optional):"
  }
  const waitingNote = (current: { readonly waiting: boolean }) =>
    Option.liftPredicate("Waiting for sign-in to finish, or paste a code.", () => current.waiting)
  const instructionLines = (current: { readonly authorization: AuthAuthorization }) =>
    Option.getOrElse(
      Option.fromNullishOr(current.authorization.instructions),
      () => "Open the URL below:",
    ).split("\n")
  /**
   * The OAuth body's rows: the no-browser line, one per instruction line
   * (each cut to one row), and the URL wrapped at the body's width. The key
   * line and the note row sit under it; the frame adds its chrome.
   */
  const oauthBodyRows = (current: {
    readonly authorization: AuthAuthorization
    readonly browserUnavailable: boolean
  }) => {
    const width = Math.max(1, sectionWidth())
    let unavailable = 0
    if (current.browserUnavailable) unavailable = 1
    const urlRows = Math.max(1, Math.ceil(current.authorization.url.length / width))
    return unavailable + instructionLines(current).length + urlRows
  }
  /** Two rules, the title and the key hint, then the text line and the note row. */
  const OAUTH_CHROME_ROWS = 6

  // A wrapped URL runs over several rows, and a mouse drag must start and
  // end on its exact first and last cells; one key copies it whole, as in
  // Codex, Claude Code and OpenCode. The code line takes every printing key,
  // so the copy key is `ctrl+y` (OpenCode's copy binding): it can never be a
  // letter of a code typed by hand.
  const isUrlCopyKey = (event: ScopedKeyboardEvent) =>
    event.name === "y" && event.ctrl === true && event.meta !== true
  // The note says copied for a copy some route took, and otherwise how to
  // copy instead. A note for a screen the reader has since left is dropped.
  const copyUrl = (current: OAuthScreen) => {
    const token = actions.newest()
    copyToClipboard(current.authorization.url, (taken) => {
      if (!token.live()) return
      if (taken) return flashSuccess("URL copied to the clipboard")
      flash("Could not reach the clipboard — select the URL instead")
    })
  }
  const OAUTH_KEYS = [keyHint("ctrl+y", "copy URL"), KeyHints.submit, KeyHints.back]
  /** The note row: a copy's note while it shows, else the waiting note. */
  const oauthNote = (current: OAuthScreen) => Option.orElse(flashNote(), () => waitingNote(current))

  /**
   * The OAuth screen inside its frame: the instructions and the URL, then the
   * code line. The rows go in order of need. The note row gives way first,
   * then the title (the body requires its rows before the title keeps one),
   * then, while the flow waits, the optional code line. Last, a squeezed body
   * drops its top lines and keeps the URL and the user code above it. A flow
   * that does not wait needs its code line, which keeps its row. The code
   * line hides without leaving the keyboard scope, so Esc and a paste still
   * reach it.
   */
  const OAuthBody = (bodyProps: { readonly current: () => OAuthScreen }) => {
    const bodyRows = () => oauthBodyRows(bodyProps.current())
    const codeLineNeeded = () => !bodyProps.current().waiting
    const rows = usePickerBody(() => {
      let required = bodyRows()
      if (codeLineNeeded()) required += 1
      return { rows: bodyRows() + 1, query: 0, dressed: bodyRows() + 1, required }
    })
    const codeLineShown = () =>
      codeLineNeeded() || !Option.exists(rows(), (available) => available < bodyRows() + 1)
    return (
      <>
        <ChromePanel.Body stickToBottom>
          <Show when={bodyProps.current().browserUnavailable}>
            <text wrapMode="none" truncate style={{ fg: theme.textMuted }}>
              Could not open a browser; open the URL yourself.
            </text>
          </Show>
          <For each={instructionLines(bodyProps.current())}>
            {(line) => (
              <text wrapMode="none" truncate style={{ fg: theme.textMuted }}>
                {line}
              </text>
            )}
          </For>
          <text wrapMode="char" style={{ fg: theme.text }}>
            {bodyProps.current().authorization.url}
          </text>
        </ChromePanel.Body>
        <AuthTextLine
          label={codeLabel(bodyProps.current().authorization.method)}
          text={bodyProps.current().code}
          shown={codeLineShown()}
          onEvent={send}
          onSubmit={() => submitOauth(bodyProps.current())}
          onCancel={back}
          onKey={(event) => {
            if (!isUrlCopyKey(event)) return false
            copyUrl(bodyProps.current())
            return true
          }}
        />
      </>
    )
  }

  return (
    <Switch>
      <SolidMatch when={screen()._tag === "List"}>
        <PickerFrame
          title={`Sign in · ${plural(catalog().providers.length, "provider")}`}
          keys={listKeys()}
          error={state().error}
          detail={flashNote()}
        >
          <SelectList
            id="auth-provider"
            open={true}
            rows={providerRows}
            rowKey={(provider) => provider.provider}
            onSelect={(provider) =>
              send(AuthEvent.cases.OpenMethod.make({ provider: provider.provider }))
            }
            onDismiss={dismissList}
            loading={listLoading}
            empty={retryRow}
            onCursor={setCursor}
            extraKeys={(event, selected) => {
              if (event.ctrl === true && event.name === "x") return armOrDelete(selected)
              // Any other key steps back from an armed row; Esc does only that.
              const wasArmed = Option.isSome(armed())
              setArmed(Option.none())
              if (event.name === "escape" && wasArmed) return true
              if (event.name === "r" && Option.isSome(state().error)) {
                loadAuth(begin())
                return true
              }
              return false
            }}
          />
        </PickerFrame>
      </SolidMatch>
      <SolidMatch when={Option.getOrUndefined(methodScreen())}>
        {(current) => (
          <PickerFrame
            error={Option.none()}
            title={`Sign in · ${label(current().provider)} · method`}
            keys={[KeyHints.move, KeyHints.select, KeyHints.back]}
          >
            <SelectList
              id="auth-method"
              open={true}
              rows={methodRows}
              rowKey={(choice) => String(choice.index)}
              onSelect={(choice) =>
                Option.map(methodProvider(), (provider) =>
                  startMethod(provider.provider, choice.index, choice.method),
                )
              }
              onDismiss={back}
            />
          </PickerFrame>
        )}
      </SolidMatch>
      <SolidMatch when={Option.getOrUndefined(keyScreen())}>
        {(current) => (
          <PickerFrame
            error={Option.none()}
            height={pickerHeight(1, dimensions().height)}
            title={`Sign in · ${label(current().provider)} · API key`}
            keys={[KeyHints.submit, KeyHints.back]}
          >
            <AuthTextLine
              label="API key ›"
              text={keyMask(current().value)}
              onEvent={send}
              onSubmit={() => submitKey(current().provider, current().value)}
              onCancel={back}
            />
          </PickerFrame>
        )}
      </SolidMatch>
      <SolidMatch when={Option.getOrUndefined(oauthScreen())}>
        {(current) => (
          <PickerFrame
            height={oauthBodyRows(current()) + OAUTH_CHROME_ROWS}
            title={`Sign in · ${label(current().provider)} · ${current().method.label}`}
            keys={OAUTH_KEYS}
            error={state().error}
            detail={oauthNote(current())}
          >
            <OAuthBody current={current} />
          </PickerFrame>
        )}
      </SolidMatch>
    </Switch>
  )
}

/**
 * The key line and the code line: one row that takes typed and pasted text.
 * The composer keeps the terminal's focus, so the line reads its keys through
 * the keyboard scope, as btw's ask line does. It sits inside its frame, so a
 * frame with no row takes none of them (`KeyboardGate`). A line the pane
 * hides (`shown` false, an optional code line on a short terminal) keeps its
 * scope. Text longer than the row shows its tail, so the caret stays on
 * screen.
 */
function AuthTextLine(props: {
  readonly label: string
  readonly text: string
  readonly shown?: boolean
  readonly onEvent: (event: AuthEvent) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
  /** Sees each key before the line does; `true` means the pane took it (the OAuth `ctrl+y` copy). */
  readonly onKey?: (event: ScopedKeyboardEvent) => boolean
}) {
  const { theme } = useTheme()
  const { sectionWidth } = usePickerGeometry()
  /** The text that fits after the label and before the caret: its tail, cut with an ellipsis. */
  const visibleText = () => {
    // The label, its space and the caret take their columns first.
    const room = Math.max(1, sectionWidth() - props.label.length - 2)
    const chars = [...props.text]
    if (chars.length <= room) return props.text
    return "…" + chars.slice(chars.length - (room - 1)).join("")
  }
  useScopedKeyboard(
    (event) => {
      if (Option.exists(Option.fromUndefinedOr(props.onKey), (onKey) => onKey(event))) return true
      if (event.name === "escape") {
        props.onCancel()
        return true
      }
      if (event.name === "return") {
        props.onSubmit()
        return true
      }
      if (event.name === "backspace") {
        props.onEvent(AuthEvent.cases.Backspace.make({}))
        return true
      }
      if (event.ctrl === true || event.meta === true) return false
      return Option.match(typedText(Option.fromNullishOr(event.sequence)), {
        onNone: () => false,
        onSome: (text) => {
          props.onEvent(AuthEvent.cases.Type.make({ text }))
          return true
        },
      })
    },
    {
      paste: (text) => {
        // A key or a code is one line: a pasted line break drops, and so
        // does the edge whitespace.
        const line = pastedLine(text, "").trim()
        if (line.length > 0) props.onEvent(AuthEvent.cases.Type.make({ text: line }))
        return true
      },
    },
  )
  return (
    <Show when={props.shown !== false}>
      <ChromePanel.Section>
        <text wrapMode="none" style={{ fg: theme.text }}>
          <span style={{ fg: theme.textMuted }}>{props.label} </span>
          {visibleText()}
          <span style={{ fg: theme.primary }}>│</span>
        </text>
      </ChromePanel.Section>
    </Show>
  )
}
