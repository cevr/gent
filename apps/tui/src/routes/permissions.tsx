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

export function Permissions(props: PermissionsProps) {
  const { theme } = useTheme()
  const router = useRouter()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime(props.client.runtime)

  const [rules, setRules] = createSignal<PermissionRule[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [error, setError] = createSignal<string | null>(null)
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  useScrollSync(() => `perm-rule-${selectedIndex()}`, { getRef: () => scrollRef })

  // Load rules on mount
  createEffect(() => {
    cast(
      props.client.getPermissionRules().pipe(
        Effect.tap((loaded) =>
          Effect.sync(() => {
            setRules([...loaded])
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            setError(formatError(err))
          }),
        ),
      ),
    )
  })

  // Reset selection when rules change
  createEffect(() => {
    const list = rules()
    if (selectedIndex() >= list.length) {
      setSelectedIndex(Math.max(0, list.length - 1))
    }
  })

  const deleteSelected = () => {
    const list = rules()
    const rule = list[selectedIndex()]
    if (rule === undefined) return

    cast(
      props.client.deletePermissionRule(rule.tool, rule.pattern).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setRules((prev) => prev.filter((_, i) => i !== selectedIndex()))
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
    if (e.name === "escape") {
      router.back()
      return
    }

    if (rules().length === 0) return

    if (e.name === "up") {
      setSelectedIndex((i) => (i > 0 ? i - 1 : rules().length - 1))
      return
    }

    if (e.name === "down") {
      setSelectedIndex((i) => (i < rules().length - 1 ? i + 1 : 0))
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

        <Show when={error() !== null}>
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text style={{ fg: theme.error }}>{error()}</text>
          </box>
        </Show>

        <Show
          when={rules().length > 0}
          fallback={
            <box paddingLeft={1} paddingRight={1} flexGrow={1}>
              <text style={{ fg: theme.textMuted }}>No permission rules configured</text>
            </box>
          }
        >
          <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} paddingRight={1}>
            <For each={rules()}>
              {(rule, index) => {
                const isSelected = () => selectedIndex() === index()
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
