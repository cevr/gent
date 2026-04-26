/** @jsxImportSource @opentui/solid */

import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  Suspense,
} from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import { useClient } from "../client/index"
import type { SessionInfo } from "../client"
import { useCommand } from "../command/index"
import {
  CommandPaletteEvent,
  CommandPaletteState,
  transitionCommandPalette,
  type PaletteItem,
  type PaletteLevel,
} from "./command-palette-state"
import { ChromePanel } from "./chrome-panel"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { useScopedKeyboard } from "../keyboard/context"
import { useRouter } from "../router/index"
import { useTheme } from "../theme/index"
import { formatError } from "../utils/format-error"
import { useRuntime } from "../hooks/use-runtime"

const fuzzyMatch = (text: string, query: string): boolean => {
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let j = 0
  for (let i = 0; i < lower.length && j < q.length; i++) {
    if (lower[i] === q[j]) j++
  }
  return j === q.length
}

const filterItems = (items: readonly PaletteItem[], query: string): readonly PaletteItem[] => {
  if (query.length === 0) return items
  return items.filter(
    (item) =>
      fuzzyMatch(item.title, query) ||
      fuzzyMatch(item.description ?? "", query) ||
      fuzzyMatch(item.category ?? "", query),
  )
}

type SessionNode = {
  readonly session: SessionInfo
  readonly children: SessionNode[]
}

const buildSessionTree = (list: readonly SessionInfo[]): SessionNode[] => {
  const nodes = new Map<string, SessionNode>()
  for (const session of list) {
    nodes.set(session.id, { session, children: [] })
  }

  const roots: SessionNode[] = []
  for (const session of list) {
    const node = nodes.get(session.id)
    if (node === undefined) continue
    if (session.parentSessionId !== undefined && nodes.has(session.parentSessionId)) {
      nodes.get(session.parentSessionId)?.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sortNodes = (tree: SessionNode[]) => {
    tree.sort((a, b) => b.session.updatedAt - a.session.updatedAt)
    for (const node of tree) {
      if (node.children.length > 0) sortNodes(node.children)
    }
  }

  sortNodes(roots)
  return roots
}

export function CommandPalette() {
  const command = useCommand()
  const { theme, selected, set, mode, setMode } = useTheme()
  const client = useClient()
  const { cast } = useRuntime()
  const router = useRouter()
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal(CommandPaletteState.initial())

  let scrollRef: ScrollBoxRenderable | undefined

  useScrollSync(() => `item-${state().selectedIndex}`, { getRef: () => scrollRef })

  const dispatch = (event: Parameters<typeof transitionCommandPalette>[1]) => {
    setState((current) => transitionCommandPalette(current, event))
  }

  const closePalette = () => {
    dispatch(CommandPaletteEvent.Close.make({}))
    command.closePalette()
  }

  // ── Level factories ──

  const themeLevel = (): PaletteLevel => ({
    id: "theme",
    title: "Theme",
    source: (): readonly PaletteItem[] => {
      const isSystem = selected() === "system"
      const currentMode = mode()
      return [
        {
          id: "theme.system",
          title: isSystem ? "System •" : "System",
          description: "Follow terminal theme",
          onSelect: () => {
            set("system")
            closePalette()
          },
        },
        {
          id: "theme.dark",
          title: !isSystem && currentMode === "dark" ? "Dark •" : "Dark",
          onSelect: () => {
            set("opencode")
            setMode("dark")
            closePalette()
          },
        },
        {
          id: "theme.light",
          title: !isSystem && currentMode === "light" ? "Light •" : "Light",
          onSelect: () => {
            set("opencode")
            setMode("light")
            closePalette()
          },
        },
      ]
    },
  })

  const sessionsLevel = (): PaletteLevel => {
    const [sessions] = createResource(
      () =>
        new Promise<readonly SessionInfo[]>((resolve, reject) => {
          cast(
            client.listSessions().pipe(
              Effect.tap((result) => Effect.sync(() => resolve(result))),
              Effect.catchEager((error) => Effect.sync(() => reject(formatError(error)))),
            ),
          )
        }),
    )

    const newSessionItem: PaletteItem = {
      id: "session.new",
      title: "+ New Session",
      onSelect: () => {
        client.createSession((sessionId, branchId) => router.navigateToSession(sessionId, branchId))
        closePalette()
      },
    }

    const flattenSessionTree = (nodes: readonly SessionNode[], depth = 0): PaletteItem[] => {
      const items: PaletteItem[] = []
      const prefix = depth > 0 ? `${"  ".repeat(depth)}- ` : ""
      for (const node of nodes) {
        const session = node.session
        const currentSession = client.session()
        const isActive = currentSession?.sessionId === session.id
        const title = isActive
          ? `${prefix}${session.name ?? "Unnamed"} •`
          : `${prefix}${session.name ?? "Unnamed"}`

        items.push({
          id: `session.${session.id}`,
          title,
          onSelect: () => {
            if (session.branchId === undefined) return
            client.switchSession(session.id, session.branchId, session.name ?? "Unnamed")
            router.navigateToSession(session.id, session.branchId)
            closePalette()
          },
        })

        if (node.children.length > 0) {
          items.push(...flattenSessionTree(node.children, depth + 1))
        }
      }
      return items
    }

    return {
      id: "sessions",
      title: "Sessions",
      source: () => {
        const data = sessions()
        if (data === undefined) return undefined
        return [newSessionItem, ...flattenSessionTree(buildSessionTree(data))]
      },
    }
  }

  const pushLevel = (level: PaletteLevel) => {
    dispatch(CommandPaletteEvent.PushLevel.make({ level }))
    level.onEnter?.()
  }

  const rootLevel = (): PaletteLevel => ({
    id: "root",
    title: "Commands",
    source: (): readonly PaletteItem[] => [
      {
        id: "sessions",
        title: "Sessions",
        description: "Browse and switch sessions",
        category: "nav",
        onSelect: () => pushLevel(sessionsLevel()),
      },
      {
        id: "theme",
        title: "Theme",
        description: "Switch color theme",
        category: "config",
        onSelect: () => pushLevel(themeLevel()),
      },
      {
        id: "new-session",
        title: "New Session",
        description: "Start a fresh session",
        category: "cmd",
        shortcut: "Ctrl+N",
        onSelect: () => {
          client.createSession((sessionId, branchId) =>
            router.navigateToSession(sessionId, branchId),
          )
          closePalette()
        },
      },
      ...command.commands().map((cmd) => ({
        id: `ext:${cmd.id}`,
        title: cmd.title,
        category: cmd.category ?? "ext",
        shortcut: cmd.keybind,
        onSelect: () => {
          if (cmd.paletteLevel !== undefined) {
            pushLevel(cmd.paletteLevel())
          } else {
            cmd.onSelect()
            closePalette()
          }
        },
      })),
    ],
  })

  // ── Derived state ──

  const currentLevel = () => CommandPaletteState.currentLevel(state())
  const searchQuery = () => state().searchQuery

  const levelItems = createMemo<readonly PaletteItem[]>(() => {
    const level = currentLevel()
    if (level === undefined) return []
    return level.source() ?? []
  })

  const filteredItems = createMemo(() => filterItems(levelItems(), searchQuery()))

  const maxCategoryWidth = createMemo(() => {
    let max = 0
    for (const item of filteredItems()) {
      if (item.category !== undefined && item.category.length > max) max = item.category.length
    }
    return max
  })

  const popLevel = () => {
    if (state().levelStack.length <= 1) {
      closePalette()
      return
    }
    dispatch(CommandPaletteEvent.PopLevel.make({}))
  }

  const handleSelect = () => {
    const item = filteredItems()[state().selectedIndex]
    if (item === undefined || item.disabled) return
    item.onSelect()
  }

  useScopedKeyboard(
    (event) => {
      if (event.name === "escape") {
        if (searchQuery().length > 0) {
          dispatch(CommandPaletteEvent.ClearSearch.make({}))
          return true
        }
        popLevel()
        return true
      }

      if (event.name === "left") {
        popLevel()
        return true
      }

      if (event.name === "backspace") {
        if (searchQuery().length > 0) {
          dispatch(CommandPaletteEvent.SearchBackspaced.make({}))
          return true
        }
        if (state().levelStack.length > 1) {
          popLevel()
          return true
        }
        return false
      }

      if (event.name === "return" || event.name === "right") {
        handleSelect()
        return true
      }

      if (event.name === "up" || (event.ctrl === true && event.name === "p")) {
        dispatch(CommandPaletteEvent.MoveUp.make({ itemCount: filteredItems().length }))
        return true
      }

      if (event.name === "down" || (event.ctrl === true && event.name === "n")) {
        dispatch(CommandPaletteEvent.MoveDown.make({ itemCount: filteredItems().length }))
        return true
      }

      if (event.sequence !== undefined && event.sequence.length === 1) {
        const code = event.sequence.charCodeAt(0)
        if (code >= 32 && code <= 126) {
          dispatch(CommandPaletteEvent.SearchTyped.make({ char: event.sequence }))
          return true
        }
      }

      return false
    },
    { when: () => command.paletteOpen() },
  )

  createEffect(() => {
    if (command.paletteOpen()) {
      dispatch(CommandPaletteEvent.Open.make({ rootLevel: rootLevel() }))
    }
  })

  const paletteWidth = () => Math.min(50, dimensions().width - 4)
  const paletteHeight = () => Math.min(14, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - paletteWidth()) / 2)
  const top = () => Math.floor((dimensions().height - paletteHeight()) / 2)

  const breadcrumb = () => {
    const stack = state().levelStack
    if (stack.length <= 1) return ""
    return (
      stack
        .slice(0, -1)
        .map((level) => level.title)
        .join(" › ") + " ›"
    )
  }

  const levelTitle = () => currentLevel()?.title ?? "Commands"

  const LoadingIndicator = () => (
    <box paddingLeft={1}>
      <text style={{ fg: theme.textMuted }}>Loading…</text>
    </box>
  )

  const ItemList = () => (
    <>
      <For each={filteredItems()}>
        {(item, index) => {
          const isSelected = () => state().selectedIndex === index()
          const disabled = item.disabled === true
          const catWidth = maxCategoryWidth()
          const itemTextColor = () => {
            if (disabled) return theme.textMuted
            return isSelected() ? theme.selectedListItemText : theme.text
          }
          const metaColor = () => {
            if (disabled) return theme.textMuted
            return isSelected() ? theme.selectedListItemText : theme.textMuted
          }

          return (
            <box
              id={`item-${index()}`}
              backgroundColor={isSelected() && !disabled ? theme.primary : "transparent"}
              paddingLeft={1}
            >
              <text style={{ fg: itemTextColor() }}>
                <Show when={catWidth > 0}>
                  <span style={{ fg: metaColor() }}>
                    {(item.category ?? "").padEnd(catWidth)}
                  </span>{" "}
                </Show>
                {item.title}
                <Show when={item.description !== undefined}>
                  <span style={{ fg: metaColor() }}> {item.description}</span>
                </Show>
                <Show when={item.shortcut !== undefined}>
                  <span style={{ fg: metaColor() }}> [{item.shortcut}]</span>
                </Show>
              </text>
            </box>
          )
        }}
      </For>
      <Show when={filteredItems().length === 0}>
        <box paddingLeft={1}>
          <text style={{ fg: theme.textMuted }}>No matches</text>
        </box>
      </Show>
    </>
  )

  return (
    <Show when={command.paletteOpen()}>
      <ChromePanel.Root
        title={levelTitle()}
        width={paletteWidth()}
        height={paletteHeight()}
        left={left()}
        top={top()}
      >
        <ChromePanel.Section>
          <text style={{ fg: theme.text }}>
            <Show when={breadcrumb().length > 0}>
              <span style={{ fg: theme.textMuted }}>{breadcrumb()} </span>
            </Show>
            <Show when={searchQuery().length > 0}>
              <span style={{ fg: theme.textMuted }}>› </span>
              {searchQuery()}
              <span style={{ fg: theme.primary }}>│</span>
            </Show>
          </text>
        </ChromePanel.Section>

        <ChromePanel.Body
          ref={(element) => {
            scrollRef = element
          }}
        >
          <Suspense fallback={<LoadingIndicator />}>
            <ItemList />
          </Suspense>
        </ChromePanel.Body>

        <ChromePanel.Footer>
          <Show when={state().levelStack.length > 1} fallback="↑↓ · →/Enter · Esc · type to search">
            ↑↓ · →/Enter · ←/Esc · type to search
          </Show>
        </ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}
