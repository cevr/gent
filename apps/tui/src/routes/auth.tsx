/** @jsxImportSource @opentui/solid */
/**
 * Auth pane — the ops-time screen for giving gent a provider credential.
 *
 * Four screens in one panel: the provider list, the method list for one
 * provider, an API-key field, and an OAuth wait. It opens by itself when a
 * required provider has no credential, and closes by itself the moment the
 * server says every required provider has one.
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
 * captured value is no longer current is dropped, unseen. Two counters used
 * to guard this — one for loads, one for actions — which only meant a load
 * could be dropped by a rule an action did not share.
 *
 * @module
 */

import { createEffect, createSignal, on, Show } from "solid-js"
import { usePaste } from "@opentui/solid"
import { Effect, Fiber, Option } from "effect"
import type { AuthMethod, AuthProviderInfo, SessionId } from "@gent/core/protocol"
import { omitUndefined } from "@gent/core-internal/domain/guards.js"
import { LinkOpener } from "../services/link-opener"
import { useTheme } from "../theme/index"
import { useRuntime } from "../hooks/use-runtime"
import { useClient } from "../client/index"
import { ChromePanel } from "../components/chrome-panel"
import { SelectList, selectable, type SelectListRow } from "../components/select-list"
import { ClientError, formatError, type UiError } from "../utils/format-error"
import {
  AuthEvent,
  AuthState,
  catalogOf,
  methodsFor,
  missingRequired,
  providerFor,
  transitionAuth,
} from "./auth-state"
import { useScopedKeyboard, type ScopedKeyboardEvent } from "../keyboard/context"
import { useTerminalDimensions } from "../terminal-dimensions"

interface AuthProps {
  // eslint-disable-next-line effect/noNullish -- route props omit a session outside an active session.
  sessionId?: SessionId
  // eslint-disable-next-line effect/noNullish -- route props omit this policy when it is not enforced.
  enforceAuth?: boolean
  // eslint-disable-next-line effect/noNullish -- route callbacks are optional at the UI boundary.
  onResolved?: () => void
  // eslint-disable-next-line effect/noNullish -- route callbacks are optional at the UI boundary.
  onClose?: () => void
}

/** A single character with no modifier is text; anything else is a key. */
const typedChar = (event: ScopedKeyboardEvent): Option.Option<string> => {
  if (event.ctrl === true || event.meta === true) return Option.none()
  return Option.filter(Option.fromNullishOr(event.sequence), (sequence) => sequence.length === 1)
}

export function Auth(props: AuthProps) {
  const { theme } = useTheme()
  const clientCtx = useClient()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime()

  const [state, setState] = createSignal(AuthState.initial())
  const send = (event: AuthEvent) => setState((current) => transitionAuth(current, event))
  const catalog = () => catalogOf(state())

  const [autoPrompted, setAutoPrompted] = createSignal(false)
  const [successMessage, setSuccessMessage] = createSignal(Option.none<string>())
  const sessionId = Option.fromNullishOr(props.sessionId)

  // ── Staleness ─────────────────────────────────────────────────────

  let version = 0
  let successTimer = Option.none<Fiber.Fiber<void, never>>()

  const clearSuccess = () => {
    if (Option.isSome(successTimer)) clientCtx.runtime.cast(Fiber.interrupt(successTimer.value))
    successTimer = Option.none()
    setSuccessMessage(Option.none())
  }

  /** Start an action: everything already in flight stops counting. */
  const begin = () => {
    clearSuccess()
    version += 1
    return version
  }
  const isCurrent = (captured: number) => captured === version

  const flashSuccess = (message: string) => {
    clearSuccess()
    setSuccessMessage(Option.some(message))
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

  /** Run `body` only while the action that captured `token` is still current. */
  const whileCurrent = (token: number, body: () => void) =>
    Effect.sync(() => {
      if (!isCurrent(token)) return
      body()
    })

  const failed = (token: number) => (err: UiError) =>
    whileCurrent(token, () => send(AuthEvent.cases.Failed.make({ error: formatError(err) })))

  // ── Loading ───────────────────────────────────────────────────────

  const loadAuth = (token: number) => {
    clientCtx.log.info("auth:load-start")
    const request = omitUndefined({
      agentName: Option.getOrUndefined(Option.fromNullishOr(clientCtx.agent())),
      sessionId: Option.getOrUndefined(sessionId),
    })
    cast(
      Effect.all([
        clientCtx.client.auth.listProviders(request),
        clientCtx.client.auth.listMethods(),
      ]).pipe(
        Effect.tap(([providers, methods]) =>
          whileCurrent(token, () => {
            clientCtx.log.info("auth:load-complete", { providers: providers.length })
            send(AuthEvent.cases.Loaded.make({ providers: [...providers], methods }))
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

  const deleteProvider = (provider: AuthProviderInfo) => {
    if (provider.source !== "stored") return
    const token = begin()
    cast(
      clientCtx.client.auth.deleteKey({ provider: provider.provider }).pipe(
        Effect.tap(() => whileCurrent(token, () => loadAuth(token))),
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
      clientCtx.client.auth.setKey({ provider, key }).pipe(
        Effect.tap(() =>
          whileCurrent(token, () => {
            flashSuccess(`API key saved for ${provider}`)
            loadAuth(token)
          }),
        ),
        Effect.catchEager(failed(token)),
      ),
    )
  }

  const openAuthorization = (token: number, url: string) =>
    Effect.gen(function* () {
      clientCtx.log.info("auth:open-authorization", { url })
      const opener = yield* LinkOpener
      yield* opener.open(url)
    }).pipe(
      Effect.catchEager((err) =>
        whileCurrent(token, () =>
          send(AuthEvent.cases.Failed.make({ error: formatError(ClientError(err.message)) })),
        ),
      ),
    )

  /** The browser leg of an `auto` flow; a failure leaves a code to paste. */
  const awaitBrowserCallback = (
    token: number,
    provider: string,
    methodIndex: number,
    authorizationId: string,
  ) => {
    if (Option.isNone(sessionId)) {
      send(AuthEvent.cases.OAuthAutoFailed.make({ error: "No active session for authorization" }))
      return
    }
    cast(
      clientCtx.client.auth
        .callback({
          sessionId: sessionId.value,
          provider,
          method: methodIndex,
          authorizationId,
        })
        .pipe(
          Effect.tap(() =>
            whileCurrent(token, () => {
              flashSuccess(`Authenticated ${provider} via OAuth`)
              loadAuth(token)
            }),
          ),
          Effect.catchEager((err) =>
            whileCurrent(token, () =>
              send(AuthEvent.cases.OAuthAutoFailed.make({ error: formatError(err) })),
            ),
          ),
        ),
    )
  }

  const startMethod = (provider: string, methodIndex: number, method: AuthMethod) => {
    const token = begin()
    clientCtx.log.info("auth:start-method", { provider, method: method.type })

    if (method.type === "api") {
      send(AuthEvent.cases.OpenKey.make({ provider }))
      return
    }
    if (Option.isNone(sessionId)) {
      send(AuthEvent.cases.Failed.make({ error: "No active session for authorization" }))
      return
    }

    cast(
      clientCtx.client.auth
        .authorize({ sessionId: sessionId.value, provider, method: methodIndex })
        .pipe(
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
                flashSuccess(`Authenticated ${provider}`)
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
            if (!isCurrent(token)) return Effect.void
            const result = Option.fromNullishOr(authorization)
            if (Option.isNone(result) || result.value.method === "done") return Effect.void
            return openAuthorization(token, result.value.url).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (!isCurrent(token) || result.value.method !== "auto") return
                  awaitBrowserCallback(token, provider, methodIndex, result.value.authorizationId)
                }),
              ),
            )
          }),
          Effect.catchEager(failed(token)),
        ),
    )
  }

  const submitOauth = (screen: Extract<ReturnType<typeof state>["screen"], { _tag: "OAuth" }>) => {
    if (screen.waiting) return
    const trimmed = screen.code.trim()
    // A "code" flow has nothing to send without one; "auto" may be retried bare.
    if (screen.authorization.method === "code" && trimmed.length === 0) return
    if (Option.isNone(sessionId)) {
      send(AuthEvent.cases.Failed.make({ error: "No active session for authorization" }))
      return
    }
    const token = begin()
    clientCtx.log.info("auth:submit-oauth", {
      provider: screen.provider,
      method: screen.authorization.method,
    })
    const base = {
      sessionId: sessionId.value,
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
          Effect.tap(() =>
            whileCurrent(token, () => {
              flashSuccess(`Authenticated ${screen.provider} via OAuth`)
              loadAuth(token)
            }),
          ),
          Effect.catchEager(failed(token)),
        ),
    )
  }

  const close = () => {
    begin()
    send(AuthEvent.cases.Close.make({}))
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

  const listOpen = () => screen()._tag === "List"
  const methodOpen = () => screen()._tag === "Method"

  /** The provider the open method screen is about, if the catalog still has it. */
  const methodProvider = () =>
    Option.flatMap(methodScreen(), (current) => providerFor(catalog(), current.provider))

  // ── Text entry ────────────────────────────────────────────────────
  //
  // The key field and the OAuth code field take the same keys, so one
  // handler serves both; each screen's submit is what differs.

  const submitText = () => {
    Option.map(keyScreen(), (current) => submitKey(current.provider, current.value))
    Option.map(oauthScreen(), submitOauth)
  }
  const textOpen = () => screen()._tag === "Key" || screen()._tag === "OAuth"

  useScopedKeyboard(
    (event) => {
      if (event.name === "escape") {
        close()
        return true
      }
      if (event.name === "return") {
        submitText()
        return true
      }
      if (event.name === "backspace") {
        send(AuthEvent.cases.Backspace.make({}))
        return true
      }
      return Option.match(typedChar(event), {
        onNone: () => false,
        onSome: (text) => {
          send(AuthEvent.cases.Type.make({ text }))
          return true
        },
      })
    },
    { when: textOpen },
  )

  usePaste((event) => {
    if (!textOpen()) return
    const text = new TextDecoder().decode(event.bytes).replace(/\r?\n/g, "").trim()
    if (text.length === 0) return
    send(AuthEvent.cases.Type.make({ text }))
  })

  // ── Rows ──────────────────────────────────────────────────────────

  const statusColor = (provider: AuthProviderInfo) => {
    if (provider.hasKey) return theme.primary
    if (provider.required) return theme.error
    return theme.textMuted
  }
  const authLabel = (provider: AuthProviderInfo) => {
    if (!provider.hasKey) return "[none]"
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
          <text style={{ fg: rowForeground(isSelected(), theme.text) }}>{provider.provider}</text>
          <text style={{ fg: rowForeground(isSelected(), statusColor(provider)) }}>
            {" "}
            {authLabel(provider)}
            {requiredLabel(provider)}
          </text>
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

  // ── Layout ────────────────────────────────────────────────────────

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  const keyMask = (value: string) => {
    if (value.length > 0) return "*".repeat(value.length)
    return "(type key)"
  }
  const codePrompt = (screen: { readonly code: string; readonly waiting: boolean }) => {
    if (screen.code.length > 0) return screen.code
    if (screen.waiting) return "(waiting for browser...)"
    return "(type code)"
  }
  const codeLabel = (method: string) => {
    if (method === "code") return "Paste code:"
    return "Paste code (optional):"
  }
  const listFooter = () => {
    if (Option.isSome(state().error)) return "r=retry | Esc"
    return "Up/Down | Enter=select | d=delete | Esc"
  }
  const emptyList = () => (
    <text style={{ fg: theme.textMuted }}>
      <Show when={Option.isSome(state().error)} fallback="Loading providers...">
        Press r to retry.
      </Show>
    </text>
  )

  // ── Render ────────────────────────────────────────────────────────

  return (
    <box position="absolute" top={0} left={0} flexDirection="column" width="100%" height="100%">
      <ChromePanel.Root
        title="API Keys"
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
      >
        <ChromePanel.Error error={Option.getOrUndefined(state().error)} />
        <ChromePanel.Success message={Option.getOrUndefined(successMessage())} />

        <SelectList
          id="auth-provider"
          open={listOpen()}
          rows={providerRows}
          onSelect={(provider) =>
            send(AuthEvent.cases.OpenMethod.make({ provider: provider.provider }))
          }
          onDismiss={() => Option.map(Option.fromNullishOr(props.onClose), (close) => close())}
          empty={emptyList}
          extraKeys={(event, selected) => {
            if (event.name === "r" && Option.isSome(state().error)) {
              loadAuth(begin())
              return true
            }
            if (event.name === "d") {
              Option.map(selected, deleteProvider)
              return true
            }
            return false
          }}
        />

        <SelectList
          id="auth-method"
          open={methodOpen()}
          rows={methodRows}
          onSelect={(choice) =>
            Option.map(methodProvider(), (provider) =>
              startMethod(provider.provider, choice.index, choice.method),
            )
          }
          onDismiss={close}
        />

        <Show when={Option.getOrUndefined(keyScreen())}>
          {(current) => (
            <ChromePanel.Section>
              <box flexDirection="column">
                <text style={{ fg: theme.text }}>Enter API key for {current().provider}:</text>
                <text style={{ fg: theme.text }}>{keyMask(current().value)}</text>
              </box>
            </ChromePanel.Section>
          )}
        </Show>

        <Show when={Option.getOrUndefined(oauthScreen())}>
          {(current) => (
            <ChromePanel.Section>
              <box flexDirection="column">
                <text style={{ fg: theme.text }}>
                  Authorize {current().provider} ({current().method.label})
                </text>
                <text style={{ fg: theme.textMuted }}>
                  {Option.getOrElse(
                    Option.fromNullishOr(current().authorization.instructions),
                    () => "Open the URL below:",
                  )}
                </text>
                <text style={{ fg: theme.text }}>{current().authorization.url}</text>
                <text style={{ fg: theme.text }}>{codeLabel(current().authorization.method)}</text>
                <text style={{ fg: theme.text }}>{codePrompt(current())}</text>
                <Show when={current().waiting}>
                  <text style={{ fg: theme.textMuted }}>
                    Waiting for browser callback. Paste code if it fails.
                  </text>
                </Show>
              </box>
            </ChromePanel.Section>
          )}
        </Show>

        <ChromePanel.Footer>
          <Show when={listOpen()}>{listFooter()}</Show>
          <Show when={methodOpen()}>Up/Down | Enter=choose | Esc</Show>
          <Show when={screen()._tag === "Key"}>Enter=save | Esc=cancel</Show>
          <Show when={screen()._tag === "OAuth"}>Enter=continue | Esc=cancel</Show>
        </ChromePanel.Footer>
      </ChromePanel.Root>
    </box>
  )
}
