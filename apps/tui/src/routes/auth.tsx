/**
 * Auth route - manage API keys
 *
 * Uses effect-machine for state management via useMachine hook.
 * Side effects (RPC calls) handled in component; machine handles pure transitions.
 */

import { createSignal, createEffect, onMount, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { usePaste, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import { Machine } from "effect-machine"
import { LinkOpener } from "@gent/core/domain/link-opener.js"
import { useTheme } from "../theme/index"
import { useRouter } from "../router/index"
import { useRuntime } from "../hooks/use-runtime"
import { useMachine } from "../hooks/use-machine"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { GentClient } from "../client"
import { ChromePanel } from "../components/chrome-panel"
import { ClientError, formatError } from "../utils/format-error"
import { tuiEvent, tuiError } from "../utils/unified-tracer"
import { AuthState, AuthEvent, authMachine } from "./auth-machine"
import { useScopedKeyboard } from "../keyboard/context"

export interface AuthProps {
  client: GentClient
  enforceAuth?: boolean
  onResolved?: () => void
}

function isPrintableAuthSequence(sequence: string | undefined): sequence is string {
  return sequence !== undefined && sequence.length === 1
}

export function Auth(props: AuthProps) {
  const { theme } = useTheme()
  const router = useRouter()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime(props.client.services)

  const { state, send } = useMachine(
    Machine.spawn(authMachine),
    AuthState.List({ providers: [], methods: {}, providerIndex: 0 }),
    "auth",
  )
  const [autoPrompted, setAutoPrompted] = createSignal(false)
  const [successMessage, setSuccessMessage] = createSignal<string | null>(null)
  const authSessionId = Bun.randomUUIDv7()
  let successTimer: ReturnType<typeof setTimeout> | undefined

  const flashSuccess = (msg: string) => {
    if (successTimer !== undefined) clearTimeout(successTimer)
    setSuccessMessage(msg)
    successTimer = setTimeout(() => setSuccessMessage(null), 2000)
  }
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  useScrollSync(() => `auth-provider-${state().providerIndex}`, { getRef: () => scrollRef })

  // Initial load
  onMount(() => loadAuth())

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
        Effect.catchEager((err) =>
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
      Effect.catchEager((err) =>
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
        Effect.catchEager((err) =>
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
            flashSuccess(`API key saved for ${provider.provider}`)
            send(AuthEvent.ActionSucceeded)
            loadAuth()
          }),
        ),
        Effect.catchEager((err) =>
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
            if (authorization.method === "done") {
              flashSuccess(`Authenticated ${provider.provider} via keychain`)
              send(AuthEvent.ActionSucceeded)
              loadAuth()
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
        Effect.tap((authorization) => {
          if (authorization === null || authorization.method === "done") return Effect.void
          return openAuthorization(authorization.url)
        }),
        Effect.tap((authorization) => {
          if (authorization === null || authorization.method === "done") return Effect.void
          if (authorization.method === "auto") {
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
        Effect.catchEager((err) =>
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
            flashSuccess(`Authenticated ${providerName} via OAuth`)
            send(AuthEvent.ActionSucceeded)
            loadAuth()
          }),
        ),
        Effect.catchEager((err) =>
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
              flashSuccess(`Authenticated ${provider.provider} via OAuth`)
              send(AuthEvent.ActionSucceeded)
              loadAuth()
            }),
          ),
          Effect.catchEager((err) =>
            Effect.sync(() => send(AuthEvent.ActionFailed({ error: formatError(err) }))),
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
    current: ReturnType<typeof keyState>,
    e: {
      readonly name?: string
      readonly sequence?: string
      readonly ctrl?: boolean
      readonly meta?: boolean
    },
  ): boolean | undefined => {
    if (current === undefined) return undefined
    if (e.name === "escape") {
      send(AuthEvent.Cancel)
      return true
    }
    if (e.name === "return") {
      submitKey()
      return true
    }
    if (e.name === "backspace") {
      send(AuthEvent.BackspaceKey)
      return true
    }
    if (isPrintableAuthChar(e)) {
      send(AuthEvent.TypeKey({ char: e.sequence }))
      return true
    }
    return false
  }

  const handleOauthStateKeyboard = (
    current: ReturnType<typeof oauthState>,
    e: {
      readonly name?: string
      readonly sequence?: string
      readonly ctrl?: boolean
      readonly meta?: boolean
    },
  ): boolean | undefined => {
    if (current === undefined) return undefined
    if (e.name === "escape") {
      send(AuthEvent.Cancel)
      return true
    }
    if (e.name === "return") {
      submitOauth()
      return true
    }
    if (e.name === "backspace") {
      send(AuthEvent.BackspaceCode)
      return true
    }
    if (isPrintableAuthChar(e)) {
      send(AuthEvent.TypeCode({ char: e.sequence }))
      return true
    }
    return false
  }

  const handleMethodStateKeyboard = (
    current: ReturnType<typeof methodState>,
    e: {
      readonly name?: string
      readonly ctrl?: boolean
    },
  ): boolean | undefined => {
    if (current === undefined) return undefined
    if (e.name === "escape") {
      send(AuthEvent.Cancel)
      return true
    }
    const provider = current.providers[current.providerIndex]
    const methods = provider !== undefined ? (current.methods[provider.provider] ?? []) : []
    if (methods.length === 0) return false
    if (e.name === "up") {
      const next = current.methodIndex > 0 ? current.methodIndex - 1 : methods.length - 1
      send(AuthEvent.SelectMethod({ index: next }))
      return true
    }
    if (e.name === "down") {
      const next = current.methodIndex < methods.length - 1 ? current.methodIndex + 1 : 0
      send(AuthEvent.SelectMethod({ index: next }))
      return true
    }
    if (e.name === "return") {
      startMethod()
      return true
    }
    return false
  }

  const handleListStateKeyboard = (
    current: Extract<ReturnType<typeof state>, { readonly _tag: "List" }>,
    e: {
      readonly name?: string
    },
  ): boolean => {
    if (e.name === "escape") {
      router.back()
      return true
    }
    if (current.providers.length === 0) return false
    if (e.name === "up") {
      const next =
        current.providerIndex > 0 ? current.providerIndex - 1 : current.providers.length - 1
      send(AuthEvent.SelectProvider({ index: next }))
      return true
    }
    if (e.name === "down") {
      const next =
        current.providerIndex < current.providers.length - 1 ? current.providerIndex + 1 : 0
      send(AuthEvent.SelectProvider({ index: next }))
      return true
    }
    if (e.name === "return" || e.name === "a") {
      send(AuthEvent.OpenMethod)
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
    const keyResult = handleKeyStateKeyboard(keyState(), e)
    if (keyResult !== undefined) return keyResult
    const oauthResult = handleOauthStateKeyboard(oauthState(), e)
    if (oauthResult !== undefined) return oauthResult
    const methodResult = handleMethodStateKeyboard(methodState(), e)
    if (methodResult !== undefined) return methodResult
    if (current._tag !== "List") return false
    return handleListStateKeyboard(current, e)
  })

  usePaste((event) => {
    const current = state()
    const cleaned = new TextDecoder().decode(event.bytes).replace(/\r?\n/g, "").trim()
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

  const oauthPromptLabel = () => {
    const current = oauthState()
    if (current === undefined) return "(type code)"
    if (current.code.length > 0) return current.code
    if (current.phase === "waiting") return "(waiting for browser...)"
    return "(type code)"
  }

  // ── Render ──

  return (
    <box flexDirection="column" width="100%" height="100%">
      <ChromePanel.Root
        title="API Keys"
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
      >
        <ChromePanel.Error error={state().error} />
        <ChromePanel.Success message={successMessage()} />

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

        <ChromePanel.Footer>
          <Show when={state()._tag === "List"}>Up/Down | Enter=select | d=delete | Esc</Show>
          <Show when={state()._tag === "Method"}>Up/Down | Enter=choose | Esc</Show>
          <Show when={state()._tag === "Key"}>Enter=save | Esc=cancel</Show>
          <Show when={state()._tag === "OAuth"}>Enter=continue | Esc=cancel</Show>
        </ChromePanel.Footer>
      </ChromePanel.Root>
    </box>
  )
}
