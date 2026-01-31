/**
 * Auth route - manage API keys
 */

import { createSignal, createEffect, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import { LinkOpener } from "@gent/core"
import { useTheme } from "../theme/index"
import { useRouter } from "../router/index"
import { useRuntime } from "../hooks/use-runtime"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { AuthAuthorization, AuthMethod, AuthProviderInfo, GentClient } from "../client"
import { ClientError, formatError } from "../utils/format-error"
import { tuiEvent, tuiError } from "../utils/unified-tracer"

export interface AuthProps {
  client: GentClient
  enforceAuth?: boolean
  onResolved?: () => void
}

type AuthState =
  | { _tag: "list"; providerIndex: number; error?: string }
  | { _tag: "method"; providerIndex: number; methodIndex: number; error?: string }
  | { _tag: "key"; providerIndex: number; value: string; error?: string }
  | {
      _tag: "oauth"
      providerIndex: number
      methodIndex: number
      method: AuthMethod
      authorization: AuthAuthorization
      code: string
      phase: "idle" | "waiting"
      error?: string
    }

export function Auth(props: AuthProps) {
  const { theme } = useTheme()
  const router = useRouter()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime(props.client.runtime)

  const [providers, setProviders] = createSignal<AuthProviderInfo[]>([])
  const [methodsByProvider, setMethodsByProvider] = createSignal<
    Record<string, readonly AuthMethod[]>
  >({})
  const [state, setState] = createSignal<AuthState>({ _tag: "list", providerIndex: 0 })
  const [autoPrompted, setAutoPrompted] = createSignal(false)
  const authSessionId = Bun.randomUUIDv7()
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  useScrollSync(() => `auth-provider-${state().providerIndex}`, { getRef: () => scrollRef })

  // Load providers on mount
  createEffect(() => {
    loadAuth()
  })

  const loadAuth = () => {
    tuiEvent("auth:load-start")
    cast(
      Effect.all([props.client.listAuthProviders(), props.client.listAuthMethods()]).pipe(
        Effect.tap(([loadedProviders, loadedMethods]) =>
          Effect.sync(() => {
            tuiEvent("auth:load-complete", { providers: loadedProviders.length })
            setProviders([...loadedProviders])
            setMethodsByProvider(loadedMethods)
            setState((current) =>
              current.error !== undefined ? { ...current, error: undefined } : current,
            )
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            tuiError("auth:load", err)
            setState((current) => ({ ...current, error: formatError(err) }))
          }),
        ),
      ),
    )
  }

  const openAuthorization = (authorization: AuthAuthorization) =>
    Effect.gen(function* () {
      tuiEvent("auth:open-authorization", { url: authorization.url })
      const opener = yield* LinkOpener
      yield* opener.open(authorization.url)
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          setState((currentState) =>
            currentState._tag === "oauth"
              ? { ...currentState, error: formatError(ClientError(err.message)) }
              : currentState,
          )
        }),
      ),
    )

  // Reset selection when providers change
  createEffect(() => {
    const list = providers()
    if (list.length === 0) return
    const nextIndex = Math.min(state().providerIndex, list.length - 1)
    if (nextIndex !== state().providerIndex) {
      setState({ _tag: "list", providerIndex: nextIndex })
    }
  })

  const missingRequired = () =>
    providers()
      .filter((p) => p.required && !p.hasKey)
      .map((p) => p.provider)

  const activeProvider = () => providers()[state().providerIndex]
  const activeMethods = () => {
    const provider = activeProvider()
    if (provider === undefined) return []
    return methodsByProvider()[provider.provider] ?? []
  }

  const keyState = (): Extract<AuthState, { _tag: "key" }> | undefined => {
    const current = state()
    return current._tag === "key" ? current : undefined
  }
  const oauthState = (): Extract<AuthState, { _tag: "oauth" }> | undefined => {
    const current = state()
    return current._tag === "oauth" ? current : undefined
  }
  const methodState = (): Extract<AuthState, { _tag: "method" }> | undefined => {
    const current = state()
    return current._tag === "method" ? current : undefined
  }

  createEffect(() => {
    const list = providers()
    if (list.length === 0) return

    if (props.enforceAuth === true) {
      const missing = missingRequired()
      if (missing.length === 0) {
        props.onResolved?.()
        router.back()
        return
      }
    }

    if (autoPrompted()) return
    const missing = missingRequired()
    if (missing.length === 0) return

    const index = list.findIndex((p) => missing.includes(p.provider))
    if (index >= 0) {
      setState({ _tag: "method", providerIndex: index, methodIndex: 0 })
      setAutoPrompted(true)
    }
  })

  const deleteSelected = () => {
    const provider = providers()[state().providerIndex]
    if (provider === undefined || provider.source !== "stored") return

    cast(
      props.client.deleteAuthKey(provider.provider).pipe(
        Effect.tap(() => Effect.sync(loadAuth)),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            setState((current) => ({ ...current, error: formatError(err) }))
          }),
        ),
      ),
    )
  }

  const submitKey = () => {
    const current = state()
    if (current._tag !== "key") return
    const provider = providers()[current.providerIndex]
    const key = current.value.trim()
    if (provider === undefined || key.length === 0) return
    tuiEvent("auth:submit-key", { provider: provider.provider })

    cast(
      props.client.setAuthKey(provider.provider, key).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setState({ _tag: "list", providerIndex: current.providerIndex })
            loadAuth()
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            setState((currentState) => ({ ...currentState, error: formatError(err) }))
          }),
        ),
      ),
    )
  }

  const startMethod = () => {
    const current = state()
    if (current._tag !== "method") return
    const provider = providers()[current.providerIndex]
    const methods = provider !== undefined ? (methodsByProvider()[provider.provider] ?? []) : []
    const method = methods[current.methodIndex]
    if (provider === undefined || method === undefined) return
    tuiEvent("auth:start-method", { provider: provider.provider, method: method.type })

    const startAuto = (
      authorization: AuthAuthorization,
      providerIndex: number,
      methodIndex: number,
    ) => {
      cast(
        props.client
          .callbackAuth(
            authSessionId,
            provider.provider,
            methodIndex,
            authorization.authorizationId,
          )
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                setState({ _tag: "list", providerIndex })
                loadAuth()
              }),
            ),
            Effect.catchAll((err) =>
              Effect.sync(() => {
                setState((currentState) =>
                  currentState._tag === "oauth"
                    ? { ...currentState, phase: "idle", error: formatError(err) }
                    : currentState,
                )
              }),
            ),
          ),
      )
    }

    if (method.type === "api") {
      setState({ _tag: "key", providerIndex: current.providerIndex, value: "" })
      return
    }

    cast(
      props.client.authorizeAuth(authSessionId, provider.provider, current.methodIndex).pipe(
        Effect.tap((authorization) =>
          Effect.sync(() => {
            if (authorization === null) {
              setState({
                _tag: "list",
                providerIndex: current.providerIndex,
                error: "No authorization available for this method",
              })
              return
            }
            setState({
              _tag: "oauth",
              providerIndex: current.providerIndex,
              methodIndex: current.methodIndex,
              method,
              authorization,
              code: "",
              phase: authorization.method === "auto" ? "waiting" : "idle",
            })
          }),
        ),
        Effect.tap((authorization) =>
          authorization === null ? Effect.void : openAuthorization(authorization),
        ),
        Effect.tap((authorization) =>
          authorization !== null && authorization.method === "auto"
            ? Effect.sync(() =>
                startAuto(authorization, current.providerIndex, current.methodIndex),
              )
            : Effect.void,
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            setState((currentState) => ({ ...currentState, error: formatError(err) }))
          }),
        ),
      ),
    )
  }

  const submitOauth = () => {
    const current = state()
    if (current._tag !== "oauth") return
    if (current.phase === "waiting") return
    const provider = providers()[current.providerIndex]
    if (provider === undefined) return
    tuiEvent("auth:submit-oauth", {
      provider: provider.provider,
      method: current.authorization.method,
    })
    const needsCode = current.authorization.method === "code"
    const trimmed = current.code.trim()
    const code = trimmed.length > 0 ? trimmed : undefined
    if (needsCode && code === undefined) return

    cast(
      props.client
        .callbackAuth(
          authSessionId,
          provider.provider,
          current.methodIndex,
          current.authorization.authorizationId,
          code,
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              setState({ _tag: "list", providerIndex: current.providerIndex })
              loadAuth()
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              setState((currentState) => ({ ...currentState, error: formatError(err) }))
            }),
          ),
        ),
    )
  }

  useKeyboard((e) => {
    const current = state()

    if (current._tag === "key") {
      if (e.name === "escape") {
        setState({ _tag: "list", providerIndex: current.providerIndex })
        return
      }
      if (e.name === "return") {
        submitKey()
        return
      }
      if (e.name === "backspace") {
        setState({ ...current, value: current.value.slice(0, -1) })
        return
      }
      if (
        e.sequence !== undefined &&
        e.sequence.length === 1 &&
        e.ctrl !== true &&
        e.meta !== true
      ) {
        setState({ ...current, value: current.value + e.sequence })
      }
      return
    }

    if (current._tag === "oauth") {
      if (e.name === "escape") {
        setState({ _tag: "list", providerIndex: current.providerIndex })
        return
      }
      if (e.name === "return") {
        submitOauth()
        return
      }
      if (e.name === "backspace") {
        setState({ ...current, code: current.code.slice(0, -1) })
        return
      }
      if (
        e.sequence !== undefined &&
        e.sequence.length === 1 &&
        e.ctrl !== true &&
        e.meta !== true
      ) {
        setState({ ...current, code: current.code + e.sequence })
      }
      return
    }

    if (current._tag === "method") {
      if (e.name === "escape") {
        setState({ _tag: "list", providerIndex: current.providerIndex })
        return
      }
      const methods = activeMethods()
      if (methods.length === 0) return
      if (e.name === "up") {
        const next = current.methodIndex > 0 ? current.methodIndex - 1 : methods.length - 1
        setState({ ...current, methodIndex: next })
        return
      }
      if (e.name === "down") {
        const next = current.methodIndex < methods.length - 1 ? current.methodIndex + 1 : 0
        setState({ ...current, methodIndex: next })
        return
      }
      if (e.name === "return") {
        startMethod()
        return
      }
      return
    }

    // list
    if (e.name === "escape") {
      router.back()
      return
    }

    if (providers().length === 0) return

    if (e.name === "up") {
      const next = current.providerIndex > 0 ? current.providerIndex - 1 : providers().length - 1
      setState({ _tag: "list", providerIndex: next })
      return
    }

    if (e.name === "down") {
      const next = current.providerIndex < providers().length - 1 ? current.providerIndex + 1 : 0
      setState({ _tag: "list", providerIndex: next })
      return
    }

    if (e.name === "return" || e.name === "a") {
      setState({ _tag: "method", providerIndex: current.providerIndex, methodIndex: 0 })
      return
    }

    if (e.name === "d") {
      deleteSelected()
      return
    }
  })

  usePaste((event) => {
    const current = state()
    const cleaned = event.text.replace(/\r?\n/g, "").trim()
    if (cleaned.length === 0) return

    if (current._tag === "key") {
      setState({ ...current, value: current.value + cleaned })
      return
    }

    if (current._tag === "oauth") {
      setState({ ...current, code: current.code + cleaned })
    }
  })

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  const getStatusColor = (p: AuthProviderInfo) => {
    if (!p.hasKey && p.required) return theme.error
    if (!p.hasKey) return theme.textMuted
    return theme.primary
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Overlay */}
      <box
        position="absolute"
        left={0}
        top={0}
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor="transparent"
      />

      {/* Panel */}
      <box
        position="absolute"
        left={left()}
        top={top()}
        width={panelWidth()}
        height={panelHeight()}
        backgroundColor={theme.backgroundMenu}
        border
        borderColor={theme.borderSubtle}
        flexDirection="column"
      >
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.text }}>API Keys</text>
        </box>

        <box flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>{"-".repeat(panelWidth() - 2)}</text>
        </box>

        <Show when={state().error !== undefined}>
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text style={{ fg: theme.error }}>{state().error}</text>
          </box>
        </Show>

        <Show when={keyState()}>
          {(current) => (
            <box paddingLeft={1} paddingRight={1} flexShrink={0} flexDirection="column">
              <text style={{ fg: theme.text }}>
                Enter API key for {providers()[current().providerIndex]?.provider}:
              </text>
              <box>
                <text style={{ fg: theme.text }}>
                  {current().value.length > 0 ? "*".repeat(current().value.length) : "(type key)"}
                </text>
              </box>
            </box>
          )}
        </Show>

        <Show when={oauthState()}>
          {(current) => (
            <box paddingLeft={1} paddingRight={1} flexShrink={0} flexDirection="column">
              <text style={{ fg: theme.text }}>
                Authorize {providers()[current().providerIndex]?.provider} ({current().method.label}
                )
              </text>
              <text style={{ fg: theme.textMuted }}>
                {current().authorization.instructions ?? "Open the URL below:"}
              </text>
              <text style={{ fg: theme.text }}>{current().authorization.url}</text>
              <box flexDirection="column">
                <text style={{ fg: theme.text }}>
                  {current().authorization.method === "code"
                    ? "Paste code:"
                    : "Paste code (optional):"}
                </text>
                <text style={{ fg: theme.text }}>
                  {current().code.length > 0
                    ? current().code
                    : current().phase === "waiting"
                      ? "(waiting for browser...)"
                      : "(type code)"}
                </text>
              </box>
              <Show when={current().authorization.method === "auto"}>
                <text style={{ fg: theme.textMuted }}>
                  Waiting for browser callback. Paste code if it fails.
                </text>
              </Show>
            </box>
          )}
        </Show>

        <Show when={state()._tag === "list" || state()._tag === "method"}>
          <Show
            when={state()._tag === "list" && providers().length > 0}
            fallback={
              <Show
                when={state()._tag === "method"}
                fallback={
                  <box paddingLeft={1} paddingRight={1} flexGrow={1}>
                    <text style={{ fg: theme.textMuted }}>Loading providers...</text>
                  </box>
                }
              >
                <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} paddingRight={1}>
                  <For each={activeMethods()}>
                    {(method, index) => {
                      const isSelected = () => methodState()?.methodIndex === index()
                      return (
                        <box
                          id={`auth-method-${index()}`}
                          backgroundColor={isSelected() ? theme.primary : "transparent"}
                          paddingLeft={1}
                          flexDirection="row"
                        >
                          <text
                            style={{
                              fg: isSelected() ? theme.selectedListItemText : theme.text,
                            }}
                          >
                            {method.label}
                          </text>
                          <text
                            style={{
                              fg: isSelected() ? theme.selectedListItemText : theme.textMuted,
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
            <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} paddingRight={1}>
              <For each={providers()}>
                {(provider, index) => {
                  const isSelected = () => state().providerIndex === index()
                  return (
                    <box
                      id={`auth-provider-${index()}`}
                      backgroundColor={isSelected() ? theme.primary : "transparent"}
                      paddingLeft={1}
                      flexDirection="row"
                    >
                      <text
                        style={{
                          fg: isSelected() ? theme.selectedListItemText : theme.text,
                        }}
                      >
                        {provider.provider}
                      </text>
                      <text
                        style={{
                          fg: isSelected() ? theme.selectedListItemText : getStatusColor(provider),
                        }}
                      >
                        {" "}
                        {provider.hasKey ? `[${provider.authType ?? "stored"}]` : "[none]"}
                        {provider.required ? " [required]" : ""}
                      </text>
                    </box>
                  )
                }}
              </For>
            </scrollbox>
          </Show>
        </Show>

        <box flexShrink={0} paddingLeft={1}>
          <Show when={state()._tag === "list"}>
            <text style={{ fg: theme.textMuted }}>Up/Down | Enter=select | d=delete | Esc</text>
          </Show>
          <Show when={state()._tag === "method"}>
            <text style={{ fg: theme.textMuted }}>Up/Down | Enter=choose | Esc</text>
          </Show>
          <Show when={state()._tag === "key"}>
            <text style={{ fg: theme.textMuted }}>Enter=save | Esc=cancel</text>
          </Show>
          <Show when={state()._tag === "oauth"}>
            <text style={{ fg: theme.textMuted }}>Enter=continue | Esc=cancel</text>
          </Show>
        </box>
      </box>
    </box>
  )
}
