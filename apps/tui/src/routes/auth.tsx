/**
 * Auth route - manage API keys
 */

import { createSignal, createEffect, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import { useTheme } from "../theme/index"
import { useRouter } from "../router/index"
import { useRuntime } from "../hooks/use-runtime"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { AuthProviderInfo, GentClient } from "../client"
import { formatError } from "../utils/format-error"

export interface AuthProps {
  client: GentClient
  enforceAuth?: boolean
  onResolved?: () => void
}

type InputMode = "list" | "add"

export function Auth(props: AuthProps) {
  const { theme } = useTheme()
  const router = useRouter()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime(props.client.runtime)

  const [providers, setProviders] = createSignal<AuthProviderInfo[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [error, setError] = createSignal<string | null>(null)
  const [mode, setMode] = createSignal<InputMode>("list")
  const [keyInput, setKeyInput] = createSignal("")
  const [autoPrompted, setAutoPrompted] = createSignal(false)
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  useScrollSync(() => `auth-provider-${selectedIndex()}`, { getRef: () => scrollRef })

  // Load providers on mount
  createEffect(() => {
    loadProviders()
  })

  const loadProviders = () => {
    cast(
      props.client.listAuthProviders().pipe(
        Effect.tap((loaded) =>
          Effect.sync(() => {
            setProviders([...loaded])
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            setError(formatError(err))
          }),
        ),
      ),
    )
  }

  // Reset selection when providers change
  createEffect(() => {
    const list = providers()
    if (selectedIndex() >= list.length) {
      setSelectedIndex(Math.max(0, list.length - 1))
    }
  })

  const missingRequired = () =>
    providers()
      .filter((p) => p.required && !p.hasKey)
      .map((p) => p.provider)

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
      setSelectedIndex(index)
      setMode("add")
      setAutoPrompted(true)
    }
  })

  const deleteSelected = () => {
    const list = providers()
    const provider = list[selectedIndex()]
    if (provider === undefined || provider.source !== "stored") return

    cast(
      props.client.deleteAuthKey(provider.provider).pipe(
        Effect.tap(() => Effect.sync(loadProviders)),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            setError(formatError(err))
          }),
        ),
      ),
    )
  }

  const submitKey = () => {
    const list = providers()
    const provider = list[selectedIndex()]
    const key = keyInput().trim()
    if (provider === undefined || key.length === 0) return

    cast(
      props.client.setAuthKey(provider.provider, key).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setMode("list")
            setKeyInput("")
            loadProviders()
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            setError(formatError(err))
          }),
        ),
      ),
    )
  }

  useKeyboard((e) => {
    if (mode() === "add") {
      if (e.name === "escape") {
        setMode("list")
        setKeyInput("")
        return
      }
      if (e.name === "return") {
        submitKey()
        return
      }
      if (e.name === "backspace") {
        setKeyInput((prev) => prev.slice(0, -1))
        return
      }
      if (
        e.sequence !== undefined &&
        e.sequence.length === 1 &&
        e.ctrl !== true &&
        e.meta !== true
      ) {
        setKeyInput((prev) => prev + e.sequence)
      }
      return
    }

    // List mode
    if (e.name === "escape") {
      router.back()
      return
    }

    if (providers().length === 0) return

    if (e.name === "up") {
      setSelectedIndex((i) => (i > 0 ? i - 1 : providers().length - 1))
      return
    }

    if (e.name === "down") {
      setSelectedIndex((i) => (i < providers().length - 1 ? i + 1 : 0))
      return
    }

    if (e.name === "a") {
      setMode("add")
      return
    }

    if (e.name === "d") {
      deleteSelected()
      return
    }
  })

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  const getStatusColor = (p: AuthProviderInfo) => {
    if (!p.hasKey && p.required) return theme.error
    if (!p.hasKey) return theme.textMuted
    if (p.source === "env") return theme.success
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

        <Show when={error() !== null}>
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text style={{ fg: theme.error }}>{error()}</text>
          </box>
        </Show>

        <Show when={mode() === "add"}>
          <box paddingLeft={1} paddingRight={1} flexShrink={0} flexDirection="column">
            <text style={{ fg: theme.text }}>
              Enter API key for {providers()[selectedIndex()]?.provider}:
            </text>
            <box>
              <text style={{ fg: theme.text }}>
                {keyInput().length > 0 ? "*".repeat(keyInput().length) : "(type key)"}
              </text>
            </box>
          </box>
        </Show>

        <Show when={mode() === "list"}>
          <Show
            when={providers().length > 0}
            fallback={
              <box paddingLeft={1} paddingRight={1} flexGrow={1}>
                <text style={{ fg: theme.textMuted }}>Loading providers...</text>
              </box>
            }
          >
            <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} paddingRight={1}>
              <For each={providers()}>
                {(provider, index) => {
                  const isSelected = () => selectedIndex() === index()
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
                        {provider.hasKey
                          ? provider.source === "env"
                            ? "[env]"
                            : "[stored]"
                          : "[none]"}
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
          <Show
            when={mode() === "list"}
            fallback={<text style={{ fg: theme.textMuted }}>Enter | Esc=cancel</text>}
          >
            <text style={{ fg: theme.textMuted }}>Up/Down | a=add | d=delete | Esc</text>
          </Show>
        </box>
      </box>
    </box>
  )
}
