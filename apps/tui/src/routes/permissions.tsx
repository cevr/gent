/**
 * Permissions route - view/edit permission rules
 */

import { createSignal, createEffect, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "../terminal-dimensions"
import { Effect, Match, Option } from "effect"
import { useTheme } from "../theme/index"
import { useRuntime } from "../hooks/use-runtime"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { useClient } from "../client/index"
import type { PermissionRule } from "../client"
import { ChromePanel } from "../components/chrome-panel"
import { formatError } from "../utils/format-error"
import { useScopedKeyboard } from "../keyboard/context"

type PermissionsState =
  | { _tag: "loading"; error: Option.Option<string> }
  | { _tag: "ready"; rules: PermissionRule[]; selectedIndex: number; error: Option.Option<string> }

export interface PermissionsProps {
  onClose?: () => void
}

export function Permissions(props: PermissionsProps) {
  const { theme } = useTheme()
  const clientCtx = useClient()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime()

  const [state, setState] = createSignal<PermissionsState>({
    _tag: "loading",
    error: Option.none(),
  })
  let scrollRef = Option.none<ScrollBoxRenderable>()

  useScrollSync(
    () => {
      const current = state()
      let selectedIndex = 0
      if (current._tag === "ready") selectedIndex = current.selectedIndex
      return `perm-rule-${selectedIndex}`
    },
    { getRef: () => Option.getOrUndefined(scrollRef) },
  )

  // Load rules on mount
  createEffect(() => {
    cast(
      clientCtx.client.permission.listRules().pipe(
        Effect.tap((loaded) =>
          Effect.sync(() => {
            setState((current) => {
              let selectedIndex = 0
              if (current._tag === "ready") {
                selectedIndex = Math.min(current.selectedIndex, Math.max(0, loaded.length - 1))
              }
              return {
                _tag: "ready",
                rules: [...loaded],
                selectedIndex,
                error: Option.none(),
              }
            })
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            setState((current) => {
              const error = formatError(err)
              return Match.value(current).pipe(
                Match.tagsExhaustive({
                  loading: (): PermissionsState => ({
                    _tag: "loading",
                    error: Option.some(error),
                  }),
                  ready: (current): PermissionsState => ({
                    _tag: "ready",
                    rules: current.rules,
                    selectedIndex: current.selectedIndex,
                    error: Option.some(error),
                  }),
                }),
              )
            })
          }),
        ),
      ),
    )
  })

  const deleteSelected = () => {
    const current = state()
    if (current._tag !== "ready") return
    const rule = Option.fromNullishOr(current.rules[current.selectedIndex])
    if (Option.isNone(rule)) return

    cast(
      clientCtx.client.permission
        .deleteRule({ tool: rule.value.tool, pattern: rule.value.pattern })
        .pipe(
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
                return Match.value(prev).pipe(
                  Match.tagsExhaustive({
                    loading: (): PermissionsState => ({
                      _tag: "loading",
                      error: Option.some(error),
                    }),
                    ready: (prev): PermissionsState => ({
                      _tag: "ready",
                      rules: prev.rules,
                      selectedIndex: prev.selectedIndex,
                      error: Option.some(error),
                    }),
                  }),
                )
              })
            }),
          ),
        ),
    )
  }

  useScopedKeyboard((e) => {
    if (e.name === "escape") {
      props.onClose?.()
      return true
    }

    const current = state()
    if (current._tag !== "ready" || current.rules.length === 0) return false

    if (e.name === "up") {
      setState((prev) => {
        if (prev._tag !== "ready") return prev
        let next = prev.rules.length - 1
        if (prev.selectedIndex > 0) next = prev.selectedIndex - 1
        return { _tag: "ready", rules: prev.rules, selectedIndex: next, error: prev.error }
      })
      return true
    }

    if (e.name === "down") {
      setState((prev) => {
        if (prev._tag !== "ready") return prev
        let next = 0
        if (prev.selectedIndex < prev.rules.length - 1) next = prev.selectedIndex + 1
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
  const readyState = (): Option.Option<Extract<PermissionsState, { _tag: "ready" }>> => {
    const current = state()
    if (current._tag !== "ready") return Option.none()
    return Option.some(current)
  }
  const hasRules = () => Option.exists(readyState(), (current) => current.rules.length > 0)

  const formatRule = (rule: PermissionRule): string => {
    let action = "Ask"
    if (rule.action === "allow") action = "Allow"
    else if (rule.action === "deny") action = "Deny"
    const patternValue = Option.fromNullishOr(rule.pattern)
    let pattern = ""
    if (Option.isSome(patternValue) && patternValue.value.length > 0) {
      pattern = ` (${patternValue.value})`
    }
    return `${action}: ${rule.tool}${pattern}`
  }

  const emptyMessage = () => {
    if (state()._tag === "loading") return "Loading permission rules..."
    return "No permission rules configured"
  }
  const rules = () =>
    Option.getOrElse(
      Option.map(readyState(), (current) => current.rules),
      () => [],
    )

  return (
    <box flexDirection="column" width="100%" height="100%">
      <ChromePanel.Root
        title="Permission Rules"
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
      >
        <ChromePanel.Error error={Option.getOrUndefined(state().error)} />

        <Show
          when={hasRules()}
          fallback={
            <ChromePanel.Section>
              <text style={{ fg: theme.textMuted }}>{emptyMessage()}</text>
            </ChromePanel.Section>
          }
        >
          <ChromePanel.Body ref={(value) => (scrollRef = Option.some(value))}>
            <For each={rules()}>
              {(rule, index) => {
                const isSelected = () =>
                  Option.exists(readyState(), (current) => current.selectedIndex === index())
                const backgroundColor = () => {
                  if (isSelected()) return theme.primary
                  return "transparent"
                }
                const foregroundColor = () => {
                  if (isSelected()) return theme.selectedListItemText
                  return theme.text
                }
                return (
                  <box
                    id={`perm-rule-${index()}`}
                    backgroundColor={backgroundColor()}
                    paddingLeft={1}
                  >
                    <text
                      style={{
                        fg: foregroundColor(),
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
