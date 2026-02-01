/**
 * Auth route - manage API keys
 *
 * Uses effect-machine for state management via useMachine hook.
 * Side effects (RPC calls) handled in component; machine handles pure transitions.
 */

import { createSignal, createEffect, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import { Machine } from "effect-machine"
import { LinkOpener } from "@gent/core"
import { useTheme } from "../theme/index"
import { useRouter } from "../router/index"
import { useRuntime } from "../hooks/use-runtime"
import { useMachine } from "../hooks/use-machine"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { GentClient } from "../client"
import { ClientError, formatError } from "../utils/format-error"
import { tuiEvent, tuiError } from "../utils/unified-tracer"
import { AuthState, AuthEvent, authMachine } from "./auth-machine"

export interface AuthProps {
  client: GentClient
  enforceAuth?: boolean
  onResolved?: () => void
}

export function Auth(props: AuthProps) {
  const { theme } = useTheme()
  const router = useRouter()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime(props.client.runtime)

  const { state, send } = useMachine(
    Machine.spawn(authMachine),
    AuthState.List({ providers: [], methods: {}, providerIndex: 0 }),
    "auth",
  )
  const [autoPrompted, setAutoPrompted] = createSignal(false)
  const authSessionId = Bun.randomUUIDv7()
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  useScrollSync(() => `auth-provider-${state().providerIndex}`, { getRef: () => scrollRef })

  // Initial load
  createEffect(() => {
    loadAuth()
  })

  // ── Side effects ──

  const loadAuth = () => {
    tuiEvent("auth:load-start")
    cast(
      Effect.all([props.client.listAuthProviders(), props.client.listAuthMethods()]).pipe(
        Effect.tap(([loadedProviders, loadedMethods]) =>
          Effect.sync(() => {
            tuiEvent("auth:load-complete", { providers: loadedProviders.length })
            send(
              AuthEvent.Loaded({
                providers: [...loadedProviders],
                methods: loadedMethods,
              }),
            )
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            tuiError("auth:load", err)
            send(AuthEvent.LoadFailed({ error: formatError(err) }))
          }),
        ),
      ),
    )
  }

  const openAuthorization = (url: string) =>
    Effect.gen(function* () {
      tuiEvent("auth:open-authorization", { url })
      const opener = yield* LinkOpener
      yield* opener.open(url)
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          send(AuthEvent.ActionFailed({ error: formatError(ClientError(err.message)) }))
        }),
      ),
    )

  // Auto-navigate to first missing required provider
  createEffect(() => {
    const current = state()
    if (current._tag !== "List") return
    if (current.providers.length === 0) return

    if (props.enforceAuth === true) {
      const missing = current.providers.filter((p) => p.required && !p.hasKey)
      if (missing.length === 0) {
        props.onResolved?.()
        router.back()
        return
      }
    }

    if (autoPrompted()) return
    const missing = current.providers.filter((p) => p.required && !p.hasKey).map((p) => p.provider)
    if (missing.length === 0) return

    const index = current.providers.findIndex((p) => missing.includes(p.provider))
    if (index >= 0) {
      send(AuthEvent.SelectProvider({ index }))
      send(AuthEvent.OpenMethod)
      setAutoPrompted(true)
    }
  })

  const deleteSelected = () => {
    const current = state()
    if (current._tag !== "List") return
    const provider = current.providers[current.providerIndex]
    if (provider === undefined || provider.source !== "stored") return

    cast(
      props.client.deleteAuthKey(provider.provider).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            send(AuthEvent.ActionSucceeded)
            loadAuth()
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => send(AuthEvent.ActionFailed({ error: formatError(err) }))),
        ),
      ),
    )
  }

  const submitKey = () => {
    const current = state()
    if (current._tag !== "Key") return
    const provider = current.providers[current.providerIndex]
    const key = current.value.trim()
    if (provider === undefined || key.length === 0) return
    tuiEvent("auth:submit-key", { provider: provider.provider })

    cast(
      props.client.setAuthKey(provider.provider, key).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            send(AuthEvent.ActionSucceeded)
            loadAuth()
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => send(AuthEvent.ActionFailed({ error: formatError(err) }))),
        ),
      ),
    )
  }

  const startMethod = () => {
    const current = state()
    if (current._tag !== "Method") return
    const provider = current.providers[current.providerIndex]
    const methods = provider !== undefined ? (current.methods[provider.provider] ?? []) : []
    const method = methods[current.methodIndex]
    if (provider === undefined || method === undefined) return
    tuiEvent("auth:start-method", { provider: provider.provider, method: method.type })

    if (method.type === "api") {
      send(AuthEvent.StartKey)
      return
    }

    cast(
      props.client.authorizeAuth(authSessionId, provider.provider, current.methodIndex).pipe(
        Effect.tap((authorization) =>
          Effect.sync(() => {
            if (authorization === null) {
              send(
                AuthEvent.ActionFailed({
                  error: "No authorization available for this method",
                }),
              )
              return
            }
            send(
              AuthEvent.StartOAuth({
                authorization,
                method,
                providerIndex: current.providerIndex,
                methodIndex: current.methodIndex,
              }),
            )
          }),
        ),
        Effect.tap((authorization) =>
          authorization === null ? Effect.void : openAuthorization(authorization.url),
        ),
        Effect.tap((authorization) => {
          if (authorization !== null && authorization.method === "auto") {
            return Effect.sync(() =>
              startAutoCallback(
                authorization.authorizationId,
                provider.provider,
                current.providerIndex,
                current.methodIndex,
              ),
            )
          }
          return Effect.void
        }),
        Effect.catchAll((err) =>
          Effect.sync(() => send(AuthEvent.ActionFailed({ error: formatError(err) }))),
        ),
      ),
    )
  }

  const startAutoCallback = (
    authorizationId: string,
    providerName: string,
    _providerIndex: number,
    methodIndex: number,
  ) => {
    cast(
      props.client.callbackAuth(authSessionId, providerName, methodIndex, authorizationId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            send(AuthEvent.ActionSucceeded)
            loadAuth()
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => send(AuthEvent.OAuthAutoFailed({ error: formatError(err) }))),
        ),
      ),
    )
  }

  const submitOauth = () => {
    const current = state()
    if (current._tag !== "OAuth") return
    if (current.phase === "waiting") return
    const provider = current.providers[current.providerIndex]
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
              send(AuthEvent.ActionSucceeded)
              loadAuth()
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => send(AuthEvent.ActionFailed({ error: formatError(err) }))),
          ),
        ),
    )
  }

  // ── Keyboard ──

  useKeyboard((e) => {
    const current = state()

    if (current._tag === "Key") {
      if (e.name === "escape") {
        send(AuthEvent.Cancel)
        return
      }
      if (e.name === "return") {
        submitKey()
        return
      }
      if (e.name === "backspace") {
        send(AuthEvent.BackspaceKey)
        return
      }
      if (
        e.sequence !== undefined &&
        e.sequence.length === 1 &&
        e.ctrl !== true &&
        e.meta !== true
      ) {
        send(AuthEvent.TypeKey({ char: e.sequence }))
      }
      return
    }

    if (current._tag === "OAuth") {
      if (e.name === "escape") {
        send(AuthEvent.Cancel)
        return
      }
      if (e.name === "return") {
        submitOauth()
        return
      }
      if (e.name === "backspace") {
        send(AuthEvent.BackspaceCode)
        return
      }
      if (
        e.sequence !== undefined &&
        e.sequence.length === 1 &&
        e.ctrl !== true &&
        e.meta !== true
      ) {
        send(AuthEvent.TypeCode({ char: e.sequence }))
      }
      return
    }

    if (current._tag === "Method") {
      if (e.name === "escape") {
        send(AuthEvent.Cancel)
        return
      }
      const provider = current.providers[current.providerIndex]
      const methods = provider !== undefined ? (current.methods[provider.provider] ?? []) : []
      if (methods.length === 0) return
      if (e.name === "up") {
        const next = current.methodIndex > 0 ? current.methodIndex - 1 : methods.length - 1
        send(AuthEvent.SelectMethod({ index: next }))
        return
      }
      if (e.name === "down") {
        const next = current.methodIndex < methods.length - 1 ? current.methodIndex + 1 : 0
        send(AuthEvent.SelectMethod({ index: next }))
        return
      }
      if (e.name === "return") {
        startMethod()
        return
      }
      return
    }

    // List state
    if (e.name === "escape") {
      router.back()
      return
    }

    if (current._tag !== "List" || current.providers.length === 0) return

    if (e.name === "up") {
      const next =
        current.providerIndex > 0 ? current.providerIndex - 1 : current.providers.length - 1
      send(AuthEvent.SelectProvider({ index: next }))
      return
    }

    if (e.name === "down") {
      const next =
        current.providerIndex < current.providers.length - 1 ? current.providerIndex + 1 : 0
      send(AuthEvent.SelectProvider({ index: next }))
      return
    }

    if (e.name === "return" || e.name === "a") {
      send(AuthEvent.OpenMethod)
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

    if (current._tag === "Key") {
      send(AuthEvent.PasteKey({ text: cleaned }))
      return
    }

    if (current._tag === "OAuth") {
      send(AuthEvent.PasteCode({ text: cleaned }))
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

  const activeProvider = () => {
    const current = state()
    return current.providers[current.providerIndex]
  }

  const activeMethods = () => {
    const current = state()
    const provider = current.providers[current.providerIndex]
    if (provider === undefined) return []
    return current.methods[provider.provider] ?? []
  }

  const keyState = () => {
    const current = state()
    return current._tag === "Key" ? current : undefined
  }

  const oauthState = () => {
    const current = state()
    return current._tag === "OAuth" ? current : undefined
  }

  const methodState = () => {
    const current = state()
    return current._tag === "Method" ? current : undefined
  }

  // ── Render ──

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
                Enter API key for {activeProvider()?.provider}:
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
                Authorize {activeProvider()?.provider} ({current().method.label})
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

        <Show when={state()._tag === "List" || state()._tag === "Method"}>
          <Show
            when={state()._tag === "List" && state().providers.length > 0}
            fallback={
              <Show
                when={state()._tag === "Method"}
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
              <For each={state().providers}>
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
          <Show when={state()._tag === "List"}>
            <text style={{ fg: theme.textMuted }}>Up/Down | Enter=select | d=delete | Esc</text>
          </Show>
          <Show when={state()._tag === "Method"}>
            <text style={{ fg: theme.textMuted }}>Up/Down | Enter=choose | Esc</text>
          </Show>
          <Show when={state()._tag === "Key"}>
            <text style={{ fg: theme.textMuted }}>Enter=save | Esc=cancel</text>
          </Show>
          <Show when={state()._tag === "OAuth"}>
            <text style={{ fg: theme.textMuted }}>Enter=continue | Esc=cancel</text>
          </Show>
        </box>
      </box>
    </box>
  )
}
