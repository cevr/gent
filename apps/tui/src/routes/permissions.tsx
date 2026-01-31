/**
 * Permissions route - view/edit permission rules
 */

import { createSignal, createEffect, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import { useTheme } from "../theme/index"
import { useRouter } from "../router/index"
import { useRuntime } from "../hooks/use-runtime"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { PermissionRule, GentClient } from "../client"
import { formatError } from "../utils/format-error"

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
  const { cast } = useRuntime(props.client.runtime)

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
        Effect.catchAll((err) =>
          Effect.sync(() => {
            setState((current) => ({ ...current, error: formatError(err) }))
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
              return { ...prev, rules: nextRules, selectedIndex: nextIndex }
            })
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
    if (e.name === "escape") {
      router.back()
      return
    }

    const current = state()
    if (current._tag !== "ready" || current.rules.length === 0) return

    if (e.name === "up") {
      setState((prev) => {
        if (prev._tag !== "ready") return prev
        const next = prev.selectedIndex > 0 ? prev.selectedIndex - 1 : prev.rules.length - 1
        return { ...prev, selectedIndex: next }
      })
      return
    }

    if (e.name === "down") {
      setState((prev) => {
        if (prev._tag !== "ready") return prev
        const next = prev.selectedIndex < prev.rules.length - 1 ? prev.selectedIndex + 1 : 0
        return { ...prev, selectedIndex: next }
      })
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
  const readyState = () => {
    const current = state()
    return current._tag === "ready" ? current : null
  }
  const hasRules = () => {
    const current = readyState()
    return current !== null && current.rules.length > 0
  }

  const formatRule = (rule: PermissionRule): string => {
    const action = rule.action === "allow" ? "Allow" : rule.action === "deny" ? "Deny" : "Ask"
    const pattern =
      rule.pattern !== undefined && rule.pattern.length > 0 ? ` (${rule.pattern})` : ""
    return `${action}: ${rule.tool}${pattern}`
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
          <text style={{ fg: theme.text }}>Permission Rules</text>
        </box>

        <box flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>{"-".repeat(panelWidth() - 2)}</text>
        </box>

        <Show when={state().error !== undefined}>
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text style={{ fg: theme.error }}>{state().error}</text>
          </box>
        </Show>

        <Show
          when={hasRules()}
          fallback={
            <box paddingLeft={1} paddingRight={1} flexGrow={1}>
              <text style={{ fg: theme.textMuted }}>
                {state()._tag === "loading"
                  ? "Loading permission rules..."
                  : "No permission rules configured"}
              </text>
            </box>
          }
        >
          <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} paddingRight={1}>
            <For each={readyState()?.rules ?? []}>
              {(rule, index) => {
                const current = readyState()
                const isSelected = () => current !== null && current.selectedIndex === index()
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
          </scrollbox>
        </Show>

        <box flexShrink={0} paddingLeft={1}>
          <text style={{ fg: theme.textMuted }}>Up/Down | d=delete | Esc</text>
        </box>
      </box>
    </box>
  )
}
