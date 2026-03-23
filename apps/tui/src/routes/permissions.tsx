/**
 * Permissions route - view/edit permission rules
 */

import { createSignal, createEffect, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import { useTheme } from "../theme/index"
import { useRouter } from "../router/index"
import { useRuntime } from "../hooks/use-runtime"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { PermissionRule, GentClient } from "../client"
import { ChromePanel } from "../components/chrome-panel"
import { formatError } from "../utils/format-error"
import { useScopedKeyboard } from "../keyboard/context"

export interface PermissionsProps {
  client: GentClient
}

type PermissionsState =
  | { _tag: "loading"; error?: string }
  | { _tag: "ready"; rules: PermissionRule[]; selectedIndex: number; error?: string }

export function Permissions(props: PermissionsProps) {
  const { theme } = useTheme()
  const router = useRouter()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime(props.client.services)

  const [state, setState] = createSignal<PermissionsState>({ _tag: "loading" })
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  useScrollSync(
    () => {
      const current = state()
      return `perm-rule-${current._tag === "ready" ? current.selectedIndex : 0}`
    },
    { getRef: () => scrollRef },
  )

  // Load rules on mount
  createEffect(() => {
    cast(
      props.client.getPermissionRules().pipe(
        Effect.tap((loaded) =>
          Effect.sync(() => {
            setState((current) => {
              const selectedIndex =
                current._tag === "ready"
                  ? Math.min(current.selectedIndex, Math.max(0, loaded.length - 1))
                  : 0
              return {
                _tag: "ready",
                rules: [...loaded],
                selectedIndex,
                error: undefined,
              }
            })
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            setState((current) => {
              const error = formatError(err)
              switch (current._tag) {
                case "loading":
                  return { _tag: "loading", error }
                case "ready":
                  return {
                    _tag: "ready",
                    rules: current.rules,
                    selectedIndex: current.selectedIndex,
                    error,
                  }
              }
            })
          }),
        ),
      ),
    )
  })

  const deleteSelected = () => {
    const current = state()
    if (current._tag !== "ready") return
    const rule = current.rules[current.selectedIndex]
    if (rule === undefined) return

    cast(
      props.client.deletePermissionRule(rule.tool, rule.pattern).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setState((prev) => {
              if (prev._tag !== "ready") return prev
              const nextRules = prev.rules.filter((_, i) => i !== prev.selectedIndex)
              const nextIndex = Math.min(prev.selectedIndex, Math.max(0, nextRules.length - 1))
              return {
                _tag: "ready",
                rules: nextRules,
                selectedIndex: nextIndex,
                error: prev.error,
              }
            })
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            setState((prev) => {
              const error = formatError(err)
              switch (prev._tag) {
                case "loading":
                  return { _tag: "loading", error }
                case "ready":
                  return {
                    _tag: "ready",
                    rules: prev.rules,
                    selectedIndex: prev.selectedIndex,
                    error,
                  }
              }
            })
          }),
        ),
      ),
    )
  }

  useScopedKeyboard((e) => {
    if (e.name === "escape") {
      router.back()
      return true
    }

    const current = state()
    if (current._tag !== "ready" || current.rules.length === 0) return false

    if (e.name === "up") {
      setState((prev) => {
        if (prev._tag !== "ready") return prev
        const next = prev.selectedIndex > 0 ? prev.selectedIndex - 1 : prev.rules.length - 1
        return { _tag: "ready", rules: prev.rules, selectedIndex: next, error: prev.error }
      })
      return true
    }

    if (e.name === "down") {
      setState((prev) => {
        if (prev._tag !== "ready") return prev
        const next = prev.selectedIndex < prev.rules.length - 1 ? prev.selectedIndex + 1 : 0
        return { _tag: "ready", rules: prev.rules, selectedIndex: next, error: prev.error }
      })
      return true
    }

    if (e.name === "d") {
      deleteSelected()
      return true
    }
    return false
  })

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)
  const readyState = () => {
    const current = state()
    return current._tag === "ready" ? current : null
  }
  const hasRules = () => {
    const current = readyState()
    return current !== null && current.rules.length > 0
  }

  const formatRule = (rule: PermissionRule): string => {
    let action = "Ask"
    if (rule.action === "allow") action = "Allow"
    else if (rule.action === "deny") action = "Deny"
    const pattern =
      rule.pattern !== undefined && rule.pattern.length > 0 ? ` (${rule.pattern})` : ""
    return `${action}: ${rule.tool}${pattern}`
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <ChromePanel.Root
        title="Permission Rules"
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
      >
        <ChromePanel.Error error={state().error} />

        <Show
          when={hasRules()}
          fallback={
            <ChromePanel.Section>
              <text style={{ fg: theme.textMuted }}>
                {state()._tag === "loading"
                  ? "Loading permission rules..."
                  : "No permission rules configured"}
              </text>
            </ChromePanel.Section>
          }
        >
          <ChromePanel.Body ref={scrollRef}>
            <For each={readyState()?.rules ?? []}>
              {(rule, index) => {
                const isSelected = () => {
                  const current = readyState()
                  return current !== null && current.selectedIndex === index()
                }
                return (
                  <box
                    id={`perm-rule-${index()}`}
                    backgroundColor={isSelected() ? theme.primary : "transparent"}
                    paddingLeft={1}
                  >
                    <text
                      style={{
                        fg: isSelected() ? theme.selectedListItemText : theme.text,
                      }}
                    >
                      {formatRule(rule)}
                    </text>
                  </box>
                )
              }}
            </For>
          </ChromePanel.Body>
        </Show>

        <ChromePanel.Footer>Up/Down | d=delete | Esc</ChromePanel.Footer>
      </ChromePanel.Root>
    </box>
  )
}
