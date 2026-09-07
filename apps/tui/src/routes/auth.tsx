import { createSignal, createEffect, on, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { usePaste } from "@opentui/solid"
import { Effect, Fiber, Option } from "effect"
import type { SessionId } from "@gent/core-internal/domain/ids.js"
import { LinkOpener } from "../services/link-opener"
import { useTheme } from "../theme/index"
import { useRuntime } from "../hooks/use-runtime"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { useClient } from "../client/index"
import { ChromePanel } from "../components/chrome-panel"
import { ClientError, formatError } from "../utils/format-error"
import {
  AuthEvent,
  AuthState,
  transitionAuth,
  type AuthState as AuthRouteState,
} from "./auth-state"
import { useScopedKeyboard } from "../keyboard/context"
import { useTerminalDimensions } from "../terminal-dimensions"

export interface AuthProps {
  // eslint-disable-next-line effect/noNullish -- route props omit a session outside an active session.
  sessionId?: SessionId
  // eslint-disable-next-line effect/noNullish -- route props omit this policy when it is not enforced.
  enforceAuth?: boolean
  // eslint-disable-next-line effect/noNullish -- route callbacks are optional at the UI boundary.
  onResolved?: () => void
  // eslint-disable-next-line effect/noNullish -- route callbacks are optional at the UI boundary.
  onClose?: () => void
}

// eslint-disable-next-line effect/noNullish -- OpenTUI omits a sequence for control keys.
function isPrintableAuthSequence(sequence: string | undefined): sequence is string {
  const value = Option.fromNullishOr(sequence)
  return Option.isSome(value) && value.value.length === 1
}

export function Auth(props: AuthProps) {
  const { theme } = useTheme()
  const clientCtx = useClient()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime()

  const [state, setState] = createSignal<AuthRouteState>(AuthState.initial())
  const send = (event: Parameters<typeof transitionAuth>[1]) => {
    setState((current) => transitionAuth(current, event))
  }
  const [autoPrompted, setAutoPrompted] = createSignal(false)
  const [successMessage, setSuccessMessage] = createSignal<Option.Option<string>>(Option.none())
  let routeVersion = 0
  let loadVersion = 0
  let successTimer = Option.none<Fiber.Fiber<void, never>>()
  const sessionId = Option.fromNullishOr(props.sessionId)

  const flashSuccess = (msg: string) => {
    if (Option.isSome(successTimer)) clientCtx.runtime.cast(Fiber.interrupt(successTimer.value))
    setSuccessMessage(Option.some(msg))
    successTimer = Option.some(
      clientCtx.runtime.fork(
        Effect.sleep("2 seconds").pipe(
          Effect.andThen(
            Effect.sync(() => {
              setSuccessMessage(Option.none())
              successTimer = Option.none()
            }),
          ),
        ),
      ),
    )
  }
  const invalidateRouteVersion = () => {
    routeVersion += 1
    if (Option.isSome(successTimer)) {
      clientCtx.runtime.cast(Fiber.interrupt(successTimer.value))
      successTimer = Option.none()
    }
    setSuccessMessage(Option.none())
    return routeVersion
  }
  const nextRouteVersion = () => {
    loadVersion = 0
    return invalidateRouteVersion()
  }
  const isCurrentRouteVersion = (version: number) => version === routeVersion
  let scrollRef = Option.none<ScrollBoxRenderable>()

  useScrollSync(() => `auth-provider-${state().providerIndex}`, {
    getRef: () => Option.getOrUndefined(scrollRef),
  })

  createEffect(
    on(
      () => clientCtx.agent(),
      () => {
        setAutoPrompted(false)
        loadAuth(nextRouteVersion())
      },
      { defer: false },
    ),
  )

  // ── Side effects ──

  const loadAuth = (currentRouteVersion = routeVersion) => {
    const requestVersion = ++loadVersion
    const agentName = Option.fromNullishOr(clientCtx.agent())
    clientCtx.log.info("auth:load-start")
    send(AuthEvent.cases.LoadStarted.make({}))
    const providerRequest = Option.match(agentName, {
      onNone: () =>
        Option.match(sessionId, {
          onNone: () => ({}),
          onSome: (value) => ({ sessionId: value }),
        }),
      onSome: (value) =>
        Option.match(sessionId, {
          onNone: () => ({ agentName: value }),
          onSome: (id) => ({ agentName: value, sessionId: id }),
        }),
    })
    cast(
      Effect.all([
        clientCtx.client.auth.listProviders(providerRequest),
        clientCtx.client.auth.listMethods(),
      ]).pipe(
        Effect.tap(([loadedProviders, loadedMethods]) =>
          Effect.sync(() => {
            if (!isCurrentRouteVersion(currentRouteVersion) || requestVersion !== loadVersion)
              return
            clientCtx.log.info("auth:load-complete", { providers: loadedProviders.length })
            send(
              AuthEvent.cases.Loaded.make({
                providers: [...loadedProviders],
                methods: loadedMethods,
              }),
            )
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            if (!isCurrentRouteVersion(currentRouteVersion) || requestVersion !== loadVersion)
              return
            clientCtx.log.error("auth:load", { error: String(err) })
            send(AuthEvent.cases.LoadFailed.make({ error: formatError(err) }))
          }),
        ),
      ),
    )
  }

  const openAuthorization = (currentRouteVersion: number, url: string) =>
    Effect.gen(function* () {
      clientCtx.log.info("auth:open-authorization", { url })
      const opener = yield* LinkOpener
      yield* opener.open(url)
    }).pipe(
      Effect.catchEager((err) =>
        Effect.sync(() => {
          if (!isCurrentRouteVersion(currentRouteVersion)) return
          send(AuthEvent.cases.ActionFailed.make({ error: formatError(ClientError(err.message)) }))
        }),
      ),
    )

  // Auto-navigate to first missing required provider
  createEffect(() => {
    const current = state()
    if (current._tag !== "List") return

    const currentError = Option.fromNullishOr(current.error)
    if (props.enforceAuth === true && Option.isNone(currentError)) {
      const missing = current.providers.filter((p) => p.required && !p.hasKey)
      if (missing.length === 0) {
        const onResolved = Option.fromNullishOr(props.onResolved)
        if (Option.isSome(onResolved)) onResolved.value()
        const onClose = Option.fromNullishOr(props.onClose)
        if (Option.isSome(onClose)) onClose.value()
        return
      }
    }

    if (current.providers.length === 0) return

    if (autoPrompted()) return
    const missing = current.providers.filter((p) => p.required && !p.hasKey).map((p) => p.provider)
    if (missing.length === 0) return

    const index = current.providers.findIndex((p) => missing.includes(p.provider))
    if (index >= 0) {
      send(AuthEvent.cases.SelectProvider.make({ index }))
      send(AuthEvent.cases.OpenMethod.make({}))
      setAutoPrompted(true)
    }
  })

  const deleteSelected = () => {
    const current = state()
    if (current._tag !== "List") return
    const provider = Option.fromNullishOr(current.providers[current.providerIndex])
    if (Option.isNone(provider) || provider.value.source !== "stored") return
    const currentRouteVersion = invalidateRouteVersion()
    send(AuthEvent.cases.DeleteStarted.make({}))

    cast(
      clientCtx.client.auth.deleteKey({ provider: provider.value.provider }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (!isCurrentRouteVersion(currentRouteVersion)) return
            send(AuthEvent.cases.ActionSucceeded.make({}))
            loadAuth(currentRouteVersion)
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            if (!isCurrentRouteVersion(currentRouteVersion)) return
            send(AuthEvent.cases.ActionFailed.make({ error: formatError(err) }))
          }),
        ),
      ),
    )
  }

  const submitKey = () => {
    const current = state()
    if (current._tag !== "Key") return
    const provider = Option.fromNullishOr(current.providers[current.providerIndex])
    const key = current.value.trim()
    if (Option.isNone(provider) || key.length === 0) return
    const currentRouteVersion = invalidateRouteVersion()
    clientCtx.log.info("auth:submit-key", { provider: provider.value.provider })
    send(AuthEvent.cases.SubmitKeyStarted.make({}))

    cast(
      clientCtx.client.auth.setKey({ provider: provider.value.provider, key }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (!isCurrentRouteVersion(currentRouteVersion)) return
            flashSuccess(`API key saved for ${provider.value.provider}`)
            send(AuthEvent.cases.ActionSucceeded.make({}))
            loadAuth(currentRouteVersion)
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            if (!isCurrentRouteVersion(currentRouteVersion)) return
            send(AuthEvent.cases.ActionFailed.make({ error: formatError(err) }))
          }),
        ),
      ),
    )
  }

  const startMethod = () => {
    const current = state()
    if (current._tag !== "Method") return
    const provider = Option.fromNullishOr(current.providers[current.providerIndex])
    if (Option.isNone(provider)) return
    const methods = Option.getOrElse(
      Option.fromNullishOr(current.methods[provider.value.provider]),
      () => [],
    )
    const method = Option.fromNullishOr(methods[current.methodIndex])
    if (Option.isNone(method)) return
    const currentRouteVersion = invalidateRouteVersion()
    clientCtx.log.info("auth:start-method", {
      provider: provider.value.provider,
      method: method.value.type,
    })

    if (method.value.type === "api") {
      send(AuthEvent.cases.StartKey.make({}))
      return
    }

    if (Option.isNone(sessionId)) {
      send(AuthEvent.cases.ActionFailed.make({ error: "No active session for authorization" }))
      return
    }

    send(AuthEvent.cases.StartOAuthAuthorization.make({}))
    cast(
      clientCtx.client.auth
        .authorize({
          sessionId: sessionId.value,
          provider: provider.value.provider,
          method: current.methodIndex,
        })
        .pipe(
          Effect.tap((authorization) =>
            Effect.sync(() => {
              if (!isCurrentRouteVersion(currentRouteVersion)) return
              const authorizationOption = Option.fromNullishOr(authorization)
              if (Option.isNone(authorizationOption)) {
                send(
                  AuthEvent.cases.ActionFailed.make({
                    error: "No authorization available for this method",
                  }),
                )
                return
              }
              if (authorizationOption.value.method === "done") {
                flashSuccess(`Authenticated ${provider.value.provider}`)
                send(AuthEvent.cases.ActionSucceeded.make({}))
                loadAuth(currentRouteVersion)
                return
              }
              send(
                AuthEvent.cases.StartOAuth.make({
                  authorization: authorizationOption.value,
                  method: method.value,
                  providerIndex: current.providerIndex,
                  methodIndex: current.methodIndex,
                }),
              )
            }),
          ),
          Effect.tap((authorization) => {
            if (!isCurrentRouteVersion(currentRouteVersion)) return Effect.void
            const authorizationOption = Option.fromNullishOr(authorization)
            if (Option.isNone(authorizationOption) || authorizationOption.value.method === "done") {
              return Effect.void
            }
            return openAuthorization(currentRouteVersion, authorizationOption.value.url)
          }),
          Effect.tap((authorization) => {
            if (!isCurrentRouteVersion(currentRouteVersion)) return Effect.void
            const authorizationOption = Option.fromNullishOr(authorization)
            if (Option.isNone(authorizationOption) || authorizationOption.value.method === "done") {
              return Effect.void
            }
            if (authorizationOption.value.method === "auto") {
              return Effect.sync(() =>
                startAutoCallback(
                  currentRouteVersion,
                  authorizationOption.value.authorizationId,
                  provider.value.provider,
                  current.providerIndex,
                  current.methodIndex,
                ),
              )
            }
            return Effect.void
          }),
          Effect.catchEager((err) =>
            Effect.sync(() => {
              if (!isCurrentRouteVersion(currentRouteVersion)) return
              send(AuthEvent.cases.ActionFailed.make({ error: formatError(err) }))
            }),
          ),
        ),
    )
  }

  const startAutoCallback = (
    currentRouteVersion: number,
    authorizationId: string,
    providerName: string,
    _providerIndex: number,
    methodIndex: number,
  ) => {
    if (Option.isNone(sessionId)) {
      send(AuthEvent.cases.OAuthAutoFailed.make({ error: "No active session for authorization" }))
      return
    }

    cast(
      clientCtx.client.auth
        .callback({
          sessionId: sessionId.value,
          provider: providerName,
          method: methodIndex,
          authorizationId,
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (!isCurrentRouteVersion(currentRouteVersion)) return
              flashSuccess(`Authenticated ${providerName} via OAuth`)
              send(AuthEvent.cases.ActionSucceeded.make({}))
              loadAuth(currentRouteVersion)
            }),
          ),
          Effect.catchEager((err) =>
            Effect.sync(() => {
              if (!isCurrentRouteVersion(currentRouteVersion)) return
              send(AuthEvent.cases.OAuthAutoFailed.make({ error: formatError(err) }))
            }),
          ),
        ),
    )
  }

  const submitOauth = () => {
    const current = state()
    if (current._tag !== "OAuth") return
    if (current.phase === "waiting") return
    const provider = Option.fromNullishOr(current.providers[current.providerIndex])
    if (Option.isNone(provider)) return
    clientCtx.log.info("auth:submit-oauth", {
      provider: provider.value.provider,
      method: current.authorization.method,
    })
    const needsCode = current.authorization.method === "code"
    const trimmed = current.code.trim()
    let code = Option.none<string>()
    if (trimmed.length > 0) code = Option.some(trimmed)
    if (needsCode && Option.isNone(code)) return
    if (Option.isNone(sessionId)) {
      send(AuthEvent.cases.ActionFailed.make({ error: "No active session for authorization" }))
      return
    }
    const currentRouteVersion = invalidateRouteVersion()
    send(AuthEvent.cases.SubmitOAuthStarted.make({}))

    cast(
      clientCtx.client.auth
        .callback(
          Option.match(code, {
            onNone: () => ({
              sessionId: sessionId.value,
              provider: provider.value.provider,
              method: current.methodIndex,
              authorizationId: current.authorization.authorizationId,
            }),
            onSome: (value) => ({
              sessionId: sessionId.value,
              provider: provider.value.provider,
              method: current.methodIndex,
              authorizationId: current.authorization.authorizationId,
              code: value,
            }),
          }),
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (!isCurrentRouteVersion(currentRouteVersion)) return
              flashSuccess(`Authenticated ${provider.value.provider} via OAuth`)
              send(AuthEvent.cases.ActionSucceeded.make({}))
              loadAuth(currentRouteVersion)
            }),
          ),
          Effect.catchEager((err) =>
            Effect.sync(() => {
              if (!isCurrentRouteVersion(currentRouteVersion)) return
              send(AuthEvent.cases.ActionFailed.make({ error: formatError(err) }))
            }),
          ),
        ),
    )
  }

  const isPrintableAuthChar = (e: {
    readonly sequence?: string
    readonly ctrl?: boolean
    readonly meta?: boolean
  }): e is { readonly sequence: string } =>
    isPrintableAuthSequence(e.sequence) && e.ctrl !== true && e.meta !== true

  const handleKeyStateKeyboard = (
    current: ReturnType<typeof keyStateOption>,
    e: {
      readonly name?: string
      readonly sequence?: string
      readonly ctrl?: boolean
      readonly meta?: boolean
    },
  ): Option.Option<boolean> => {
    if (Option.isNone(current)) return Option.none()
    if (e.name === "escape") {
      invalidateRouteVersion()
      send(AuthEvent.cases.Cancel.make({}))
      return Option.some(true)
    }
    if (e.name === "return") {
      submitKey()
      return Option.some(true)
    }
    if (e.name === "backspace") {
      send(AuthEvent.cases.BackspaceKey.make({}))
      return Option.some(true)
    }
    if (isPrintableAuthChar(e)) {
      send(AuthEvent.cases.TypeKey.make({ char: e.sequence }))
      return Option.some(true)
    }
    return Option.some(false)
  }

  const handleOauthStateKeyboard = (
    current: ReturnType<typeof oauthStateOption>,
    e: {
      readonly name?: string
      readonly sequence?: string
      readonly ctrl?: boolean
      readonly meta?: boolean
    },
  ): Option.Option<boolean> => {
    if (Option.isNone(current)) return Option.none()
    if (e.name === "escape") {
      invalidateRouteVersion()
      send(AuthEvent.cases.Cancel.make({}))
      return Option.some(true)
    }
    if (e.name === "return") {
      submitOauth()
      return Option.some(true)
    }
    if (e.name === "backspace") {
      send(AuthEvent.cases.BackspaceCode.make({}))
      return Option.some(true)
    }
    if (isPrintableAuthChar(e)) {
      send(AuthEvent.cases.TypeCode.make({ char: e.sequence }))
      return Option.some(true)
    }
    return Option.some(false)
  }

  const handleMethodStateKeyboard = (
    current: ReturnType<typeof methodStateOption>,
    e: {
      readonly name?: string
      readonly ctrl?: boolean
    },
  ): Option.Option<boolean> => {
    if (Option.isNone(current)) return Option.none()
    const currentState = current.value
    if (e.name === "escape") {
      invalidateRouteVersion()
      send(AuthEvent.cases.Cancel.make({}))
      return Option.some(true)
    }
    const provider = Option.fromNullishOr(currentState.providers[currentState.providerIndex])
    if (Option.isNone(provider)) return Option.some(false)
    const methods = Option.getOrElse(
      Option.fromNullishOr(currentState.methods[provider.value.provider]),
      () => [],
    )
    if (methods.length === 0) return Option.some(false)
    if (e.name === "up") {
      let next = methods.length - 1
      if (currentState.methodIndex > 0) next = currentState.methodIndex - 1
      send(AuthEvent.cases.SelectMethod.make({ index: next }))
      return Option.some(true)
    }
    if (e.name === "down") {
      let next = 0
      if (currentState.methodIndex < methods.length - 1) next = currentState.methodIndex + 1
      send(AuthEvent.cases.SelectMethod.make({ index: next }))
      return Option.some(true)
    }
    if (e.name === "return") {
      startMethod()
      return Option.some(true)
    }
    return Option.some(false)
  }

  const handleListStateKeyboard = (
    current: Extract<ReturnType<typeof state>, { readonly _tag: "List" }>,
    e: {
      readonly name?: string
    },
  ): boolean => {
    if (e.name === "escape") {
      const onClose = Option.fromNullishOr(props.onClose)
      if (Option.isSome(onClose)) onClose.value()
      return true
    }
    if (e.name === "r" && Option.isSome(Option.fromNullishOr(current.error))) {
      loadAuth(nextRouteVersion())
      return true
    }
    if (current.providers.length === 0) return false
    if (e.name === "up") {
      let next = current.providers.length - 1
      if (current.providerIndex > 0) next = current.providerIndex - 1
      send(AuthEvent.cases.SelectProvider.make({ index: next }))
      return true
    }
    if (e.name === "down") {
      let next = 0
      if (current.providerIndex < current.providers.length - 1) next = current.providerIndex + 1
      send(AuthEvent.cases.SelectProvider.make({ index: next }))
      return true
    }
    if (e.name === "return" || e.name === "a") {
      send(AuthEvent.cases.OpenMethod.make({}))
      return true
    }
    if (e.name === "d") {
      deleteSelected()
      return true
    }
    return false
  }

  // ── Keyboard ──

  useScopedKeyboard((e) => {
    const current = state()
    const keyResult = handleKeyStateKeyboard(keyStateOption(), e)
    if (Option.isSome(keyResult)) return keyResult.value
    const oauthResult = handleOauthStateKeyboard(oauthStateOption(), e)
    if (Option.isSome(oauthResult)) return oauthResult.value
    const methodResult = handleMethodStateKeyboard(methodStateOption(), e)
    if (Option.isSome(methodResult)) return methodResult.value
    if (current._tag !== "List") return false
    return handleListStateKeyboard(current, e)
  })

  usePaste((event) => {
    const current = state()
    const cleaned = new TextDecoder().decode(event.bytes).replace(/\r?\n/g, "").trim()
    if (cleaned.length === 0) return

    if (current._tag === "Key") {
      send(AuthEvent.cases.PasteKey.make({ text: cleaned }))
      return
    }

    if (current._tag === "OAuth") {
      send(AuthEvent.cases.PasteCode.make({ text: cleaned }))
    }
  })

  // ── Layout ──

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  const getStatusColor = (p: { hasKey: boolean; required: boolean }) => {
    if (!p.hasKey && p.required) return theme.error
    if (!p.hasKey) return theme.textMuted
    return theme.primary
  }

  // ── Derived accessors ──

  const activeProviderOption = () => {
    const current = state()
    return Option.fromNullishOr(current.providers[current.providerIndex])
  }
  const activeMethods = () => {
    const current = state()
    const provider = Option.fromNullishOr(current.providers[current.providerIndex])
    if (Option.isNone(provider)) return []
    return Option.getOrElse(
      Option.fromNullishOr(current.methods[provider.value.provider]),
      () => [],
    )
  }

  const keyStateOption = () => {
    const current = state()
    if (current._tag === "Key") return Option.some(current)
    return Option.none()
  }
  const keyState = () => Option.getOrUndefined(keyStateOption())

  const oauthStateOption = () => {
    const current = state()
    if (current._tag === "OAuth") return Option.some(current)
    return Option.none()
  }
  const oauthState = () => Option.getOrUndefined(oauthStateOption())

  const methodStateOption = () => {
    const current = state()
    if (current._tag === "Method") return Option.some(current)
    return Option.none()
  }
  const oauthPromptLabel = () => {
    const current = oauthStateOption()
    if (Option.isNone(current)) return "(type code)"
    if (current.value.code.length > 0) return current.value.code
    if (current.value.phase === "waiting") return "(waiting for browser...)"
    return "(type code)"
  }

  const activeProviderName = () =>
    Option.getOrElse(
      Option.map(activeProviderOption(), (provider) => provider.provider),
      () => "",
    )
  const selectedBackground = (selected: boolean) => {
    if (selected) return theme.primary
    return "transparent"
  }
  const selectedColor = (selected: boolean, fallback: typeof theme.text) => {
    if (selected) return theme.selectedListItemText
    return fallback
  }
  const keyPromptLabel = (value: string) => {
    if (value.length > 0) return "*".repeat(value.length)
    return "(type key)"
  }
  const oauthMethodPrompt = (method: string) => {
    if (method === "code") return "Paste code:"
    return "Paste code (optional):"
  }
  const providerAuthLabel = (hasKey: boolean, authType: Option.Option<string>) => {
    if (!hasKey) return "[none]"
    return `[${Option.getOrElse(authType, () => "stored")}]`
  }
  const providerRequiredLabel = (required: boolean) => {
    if (required) return " [required]"
    return ""
  }
  const isMethodSelected = (index: number) => {
    const current = methodStateOption()
    return Option.isSome(current) && current.value.methodIndex === index
  }
  const isProviderSelected = (index: number) => {
    const current = state()
    return current._tag === "List" && current.providerIndex === index
  }
  const hasStateError = () => Option.isSome(Option.fromNullishOr(state().error))
  const listFooter = () => {
    const current = state()
    if (current._tag !== "List") return ""
    if (Option.isSome(Option.fromNullishOr(current.error))) return "r=retry | Esc"
    return "Up/Down | Enter=select | d=delete | Esc"
  }
  const providerLoadingLabel = () => {
    if (hasStateError()) return "Press r to retry."
    return "Loading providers..."
  }

  // ── Render ──

  return (
    <box position="absolute" top={0} left={0} flexDirection="column" width="100%" height="100%">
      <ChromePanel.Root
        title="API Keys"
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
      >
        <ChromePanel.Error error={state().error} />
        <ChromePanel.Success message={Option.getOrUndefined(successMessage())} />

        <Show when={keyState()}>
          {(current) => (
            <box paddingLeft={1} paddingRight={1} flexShrink={0} flexDirection="column">
              <text style={{ fg: theme.text }}>Enter API key for {activeProviderName()}:</text>
              <box>
                <text style={{ fg: theme.text }}>{keyPromptLabel(current().value)}</text>
              </box>
            </box>
          )}
        </Show>

        <Show when={oauthState()}>
          {(current) => (
            <box paddingLeft={1} paddingRight={1} flexShrink={0} flexDirection="column">
              <text style={{ fg: theme.text }}>
                Authorize {activeProviderName()} ({current().method.label})
              </text>
              <text style={{ fg: theme.textMuted }}>
                {Option.getOrElse(
                  Option.fromNullishOr(current().authorization.instructions),
                  () => "Open the URL below:",
                )}
              </text>
              <text style={{ fg: theme.text }}>{current().authorization.url}</text>
              <box flexDirection="column">
                <text style={{ fg: theme.text }}>
                  {oauthMethodPrompt(current().authorization.method)}
                </text>
                <text style={{ fg: theme.text }}>{oauthPromptLabel()}</text>
              </box>
              <Show when={current().authorization.method === "auto"}>
                <text style={{ fg: theme.textMuted }}>
                  Waiting for browser callback. Paste code if it fails.
                </text>
              </Show>
            </box>
          )}
        </Show>

        <Show when={state()._tag === "List" || state()._tag === "Method"}>
          <Show
            when={state()._tag === "List" && state().providers.length > 0}
            fallback={
              <Show
                when={state()._tag === "Method"}
                fallback={
                  <box paddingLeft={1} paddingRight={1} flexGrow={1}>
                    <text style={{ fg: theme.textMuted }}>{providerLoadingLabel()}</text>
                  </box>
                }
              >
                <scrollbox
                  ref={(value) => (scrollRef = Option.some(value))}
                  flexGrow={1}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <For each={activeMethods()}>
                    {(method, index) => {
                      const isSelected = () => isMethodSelected(index())
                      return (
                        <box
                          id={`auth-method-${index()}`}
                          backgroundColor={selectedBackground(isSelected())}
                          paddingLeft={1}
                          flexDirection="row"
                        >
                          <text
                            style={{
                              fg: selectedColor(isSelected(), theme.text),
                            }}
                          >
                            {method.label}
                          </text>
                          <text
                            style={{
                              fg: selectedColor(isSelected(), theme.textMuted),
                            }}
                          >
                            {" "}
                            [{method.type}]
                          </text>
                        </box>
                      )
                    }}
                  </For>
                </scrollbox>
              </Show>
            }
          >
            <scrollbox
              ref={(value) => (scrollRef = Option.some(value))}
              flexGrow={1}
              paddingLeft={1}
              paddingRight={1}
            >
              <For each={state().providers}>
                {(provider, index) => {
                  const isSelected = () => isProviderSelected(index())
                  return (
                    <box
                      id={`auth-provider-${index()}`}
                      backgroundColor={selectedBackground(isSelected())}
                      paddingLeft={1}
                      flexDirection="row"
                    >
                      <text
                        style={{
                          fg: selectedColor(isSelected(), theme.text),
                        }}
                      >
                        {provider.provider}
                      </text>
                      <text
                        style={{
                          fg: selectedColor(isSelected(), getStatusColor(provider)),
                        }}
                      >
                        {" "}
                        {providerAuthLabel(
                          provider.hasKey,
                          Option.fromNullishOr(provider.authType),
                        )}
                        {providerRequiredLabel(provider.required)}
                      </text>
                    </box>
                  )
                }}
              </For>
            </scrollbox>
          </Show>
        </Show>

        <ChromePanel.Footer>
          <Show when={state()._tag === "List"}>{listFooter()}</Show>
          <Show when={state()._tag === "Method"}>Up/Down | Enter=choose | Esc</Show>
          <Show when={state()._tag === "Key"}>Enter=save | Esc=cancel</Show>
          <Show when={state()._tag === "OAuth"}>Enter=continue | Esc=cancel</Show>
        </ChromePanel.Footer>
      </ChromePanel.Root>
    </box>
  )
}
