import { createSignal, createEffect, createMemo, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import { Agents } from "@gent/core/domain/agent.js"
import { useCommand } from "../command/index"
import { useTheme } from "../theme/index"
import { useClient } from "../client/index"
import { useRouter } from "../router/index"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { useRuntime } from "../hooks/use-runtime"
import type { SessionInfo } from "../client"
import { formatError } from "../utils/format-error"

interface MenuItem {
  id: string
  title: string
  description?: string
  category?: string
  shortcut?: string
  onSelect: () => void
}

interface MenuLevel {
  title: string
  items: MenuItem[] | (() => MenuItem[])
  searchable?: boolean
}

// Simple substring fuzzy filter — matches if all chars of query appear in order
const fuzzyMatch = (text: string, query: string): boolean => {
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let j = 0
  for (let i = 0; i < lower.length && j < q.length; i++) {
    if (lower[i] === q[j]) j++
  }
  return j === q.length
}

const filterItems = (items: MenuItem[], query: string): MenuItem[] => {
  if (query.length === 0) return items
  return items.filter(
    (item) =>
      fuzzyMatch(item.title, query) ||
      fuzzyMatch(item.description ?? "", query) ||
      fuzzyMatch(item.category ?? "", query),
  )
}

export function CommandPalette() {
  const command = useCommand()
  const { theme, selected, set, mode, setMode } = useTheme()
  const client = useClient()
  const { cast } = useRuntime(client.client.services)
  const router = useRouter()
  const dimensions = useTerminalDimensions()

  type SearchState = { _tag: "idle" } | { _tag: "active"; query: string }
  type PaletteState = {
    _tag: "open"
    levelStack: MenuLevel[]
    selectedIndex: number
    sessions: SessionInfo[]
    search: SearchState
  }

  const [state, setState] = createSignal<PaletteState>({
    _tag: "open",
    levelStack: [],
    selectedIndex: 0,
    sessions: [],
    search: { _tag: "idle" },
  })

  let scrollRef: ScrollBoxRenderable | undefined = undefined

  useScrollSync(() => `item-${state().selectedIndex}`, { getRef: () => scrollRef })

  // Build root menu
  const rootMenu = (): MenuLevel => ({
    title: "Commands",
    searchable: true,
    items: [
      {
        id: "sessions",
        title: "Sessions",
        description: "Browse and switch sessions",
        category: "nav",
        onSelect: () => {
          cast(
            client.listSessions().pipe(
              Effect.tap((list) =>
                Effect.sync(() => {
                  setState((current) => ({
                    ...current,
                    sessions: [...list],
                    levelStack: [...current.levelStack, sessionsMenu()],
                    selectedIndex: 0,
                    search: { _tag: "idle" },
                  }))
                }),
              ),
              Effect.catchEager((error) =>
                Effect.sync(() => {
                  client.setError(formatError(error))
                }),
              ),
            ),
          )
        },
      },
      {
        id: "theme",
        title: "Theme",
        description: "Switch color theme",
        category: "config",
        onSelect: () => pushLevel(themeMenu()),
      },
      {
        id: "agent",
        title: "Agent",
        description: "Switch agent mode",
        category: "config",
        onSelect: () => pushLevel(agentMenu()),
      },
      {
        id: "bypass",
        title: bypassLabel(),
        description: "Toggle permission bypass for this session",
        category: "config",
        onSelect: () => {
          const session = client.session()
          if (session === null) return
          cast(
            client.updateSessionBypass(!session.bypass).pipe(
              Effect.catchEager((error) =>
                Effect.sync(() => {
                  client.setError(formatError(error))
                }),
              ),
            ),
          )
          command.closePalette()
        },
      },
      {
        id: "new-session",
        title: "New Session",
        description: "Start a fresh session",
        category: "cmd",
        shortcut: "Ctrl+N",
        onSelect: () => {
          client.clearSession()
          router.navigateToHome()
          command.closePalette()
        },
      },
    ],
  })

  const bypassLabel = () => {
    const session = client.session()
    return session?.bypass === true ? "Bypass ✓" : "Bypass"
  }

  // Sessions submenu
  const sessionsMenu = (): MenuLevel => {
    type SessionNode = {
      session: SessionInfo
      children: SessionNode[]
    }

    const buildSessionTree = (list: SessionInfo[]): SessionNode[] => {
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

      const sortNodes = (list: SessionNode[]) => {
        list.sort((a, b) => b.session.updatedAt - a.session.updatedAt)
        for (const node of list) {
          if (node.children.length > 0) sortNodes(node.children)
        }
      }
      sortNodes(roots)

      return roots
    }

    const flattenSessionTree = (nodes: SessionNode[], depth = 0): MenuItem[] => {
      const items: MenuItem[] = []
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
            if (session.branchId !== undefined) {
              client.switchSession(session.id, session.branchId, session.name ?? "Unnamed")
              router.navigateToSession(session.id, session.branchId)
            }
            command.closePalette()
          },
        })

        if (node.children.length > 0) {
          items.push(...flattenSessionTree(node.children, depth + 1))
        }
      }

      return items
    }

    return {
      title: "Sessions",
      items: () => [
        {
          id: "session.new",
          title: "+ New Session",
          onSelect: () => {
            client.clearSession()
            router.navigateToHome()
            command.closePalette()
          },
        },
        ...flattenSessionTree(buildSessionTree(state().sessions)),
      ],
      searchable: true,
    }
  }

  // Theme submenu
  const themeMenu = (): MenuLevel => {
    const isSystem = selected() === "system"
    const currentMode = mode()
    return {
      title: "Theme",
      items: [
        {
          id: "theme.system",
          title: isSystem ? "System •" : "System",
          description: "Follow terminal theme",
          onSelect: () => {
            set("system")
            command.closePalette()
          },
        },
        {
          id: "theme.dark",
          title: !isSystem && currentMode === "dark" ? "Dark •" : "Dark",
          onSelect: () => {
            set("opencode")
            setMode("dark")
            command.closePalette()
          },
        },
        {
          id: "theme.light",
          title: !isSystem && currentMode === "light" ? "Light •" : "Light",
          onSelect: () => {
            set("opencode")
            setMode("light")
            command.closePalette()
          },
        },
      ],
    }
  }

  // Agent submenu - primary agents only
  const agentMenu = (): MenuLevel => {
    const current = client.agent()
    const agents = Object.values(Agents).filter((a) => a.kind === "primary" && a.hidden !== true)

    return {
      title: "Agent",
      items: agents.map((agent) => ({
        id: `agent.${agent.name}`,
        title: agent.name === current ? `${agent.name} •` : agent.name,
        description: agent.description ?? undefined,
        onSelect: () => {
          client.steer({ _tag: "SwitchAgent", agent: agent.name })
          command.closePalette()
        },
      })),
    }
  }

  const currentLevel = () => {
    const stack = state().levelStack
    return stack.length > 0 ? (stack[stack.length - 1] ?? rootMenu()) : rootMenu()
  }

  const levelItems = (level: MenuLevel) =>
    typeof level.items === "function" ? level.items() : level.items

  const searchQuery = () => {
    const current = state().search
    return current._tag === "active" ? current.query : ""
  }

  // Filtered items based on search query
  const filteredItems = createMemo(() => {
    const level = currentLevel()
    const items = levelItems(level)
    const query = searchQuery()
    if (level.searchable === false || query.length === 0) return items
    return filterItems(items, query)
  })

  // Compute max category width for alignment
  const maxCategoryWidth = createMemo(() => {
    let max = 0
    for (const item of filteredItems()) {
      if (item.category !== undefined && item.category.length > max) {
        max = item.category.length
      }
    }
    return max
  })

  const pushLevel = (level: MenuLevel) => {
    setState((current) => ({
      ...current,
      levelStack: [...current.levelStack, level],
      selectedIndex: 0,
      search: { _tag: "idle" },
    }))
  }

  const popLevel = () => {
    const stack = state().levelStack
    if (stack.length > 0) {
      setState((current) => ({
        ...current,
        levelStack: current.levelStack.slice(0, -1),
        selectedIndex: 0,
        search: { _tag: "idle" },
      }))
    } else {
      command.closePalette()
    }
  }

  const handleSelect = () => {
    const items = filteredItems()
    const item = items[state().selectedIndex]
    if (item !== undefined) {
      item.onSelect()
    }
  }

  // Reset when palette opens
  const resetPalette = () => {
    setState((current) => ({
      ...current,
      levelStack: [],
      selectedIndex: 0,
      search: { _tag: "idle" },
    }))
  }

  useKeyboard((e) => {
    if (!command.paletteOpen()) return

    if (e.name === "escape") {
      if (state().search._tag === "active") {
        setState((current) => ({
          ...current,
          search: { _tag: "idle" },
          selectedIndex: 0,
        }))
        return
      }
      popLevel()
      return
    }

    if (e.name === "left") {
      popLevel()
      return
    }

    if (e.name === "backspace") {
      const currentSearch = state().search
      if (currentSearch._tag === "active") {
        const next = currentSearch.query.slice(0, -1)
        setState((current) => ({
          ...current,
          search: next.length > 0 ? { _tag: "active", query: next } : { _tag: "idle" },
          selectedIndex: 0,
        }))
        return
      }
      if (state().levelStack.length > 0) {
        popLevel()
        return
      }
      return
    }

    if (e.name === "return" || e.name === "right") {
      handleSelect()
      return
    }

    const items = filteredItems()
    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      setState((current) => ({
        ...current,
        selectedIndex: current.selectedIndex > 0 ? current.selectedIndex - 1 : items.length - 1,
      }))
      return
    }

    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      setState((current) => ({
        ...current,
        selectedIndex: current.selectedIndex < items.length - 1 ? current.selectedIndex + 1 : 0,
      }))
      return
    }

    // Handle search input — all levels searchable unless explicitly disabled
    const level = currentLevel()
    if (level.searchable !== false && e.sequence !== undefined && e.sequence.length === 1) {
      const char = e.sequence
      if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
        setState((current) => {
          const query = current.search._tag === "active" ? current.search.query : ""
          return {
            ...current,
            search: { _tag: "active", query: query + char },
            selectedIndex: 0,
          }
        })
        return
      }
    }
  })

  // Reset palette state when it opens
  createEffect(() => {
    if (command.paletteOpen()) {
      resetPalette()
    }
  })

  // Calculate palette dimensions
  const paletteWidth = () => Math.min(50, dimensions().width - 4)
  const paletteHeight = () => Math.min(14, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - paletteWidth()) / 2)
  const top = () => Math.floor((dimensions().height - paletteHeight()) / 2)

  const breadcrumb = () => {
    const stack = state().levelStack
    if (stack.length === 0) return ""
    return stack.map((l) => l.title).join(" › ") + " ›"
  }

  return (
    <Show when={command.paletteOpen()}>
      {/* Overlay */}
      <box
        position="absolute"
        left={0}
        top={0}
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor="transparent"
      />

      {/* Palette */}
      <box
        position="absolute"
        left={left()}
        top={top()}
        width={paletteWidth()}
        height={paletteHeight()}
        backgroundColor={theme.backgroundMenu}
        border
        borderColor={theme.borderSubtle}
        flexDirection="column"
      >
        {/* Header with search */}
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.text }}>
            <Show when={breadcrumb().length > 0}>
              <span style={{ fg: theme.textMuted }}>{breadcrumb()} </span>
            </Show>
            <Show
              when={currentLevel().searchable !== false && searchQuery().length > 0}
              fallback={currentLevel().title}
            >
              <span style={{ fg: theme.textMuted }}>Search: </span>
              {searchQuery()}
              <span style={{ fg: theme.primary }}>│</span>
            </Show>
          </text>
        </box>

        {/* Separator */}
        <box flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>{"─".repeat(paletteWidth() - 2)}</text>
        </box>

        {/* Items */}
        <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} paddingRight={1}>
          <For each={filteredItems()}>
            {(item, index) => {
              const isSelected = () => state().selectedIndex === index()
              const catW = maxCategoryWidth()
              return (
                <box
                  id={`item-${index()}`}
                  backgroundColor={isSelected() ? theme.primary : "transparent"}
                  paddingLeft={1}
                >
                  <text
                    style={{
                      fg: isSelected() ? theme.selectedListItemText : theme.text,
                    }}
                  >
                    {/* Category badge */}
                    <Show when={catW > 0}>
                      <span
                        style={{
                          fg: isSelected() ? theme.selectedListItemText : theme.textMuted,
                        }}
                      >
                        {(item.category ?? "").padEnd(catW)}
                      </span>{" "}
                    </Show>
                    {item.title}
                    {/* Description */}
                    <Show when={item.description !== undefined}>
                      <span
                        style={{
                          fg: isSelected() ? theme.selectedListItemText : theme.textMuted,
                        }}
                      >
                        {" "}
                        {item.description}
                      </span>
                    </Show>
                    {/* Shortcut hint */}
                    <Show when={item.shortcut !== undefined}>
                      <span
                        style={{
                          fg: isSelected() ? theme.selectedListItemText : theme.textMuted,
                        }}
                      >
                        {" "}
                        [{item.shortcut}]
                      </span>
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
        </scrollbox>

        {/* Footer hint */}
        <box flexShrink={0} paddingLeft={1}>
          <text style={{ fg: theme.textMuted }}>
            <Show
              when={state().levelStack.length > 0}
              fallback="↑↓ · →/Enter · Esc · type to search"
            >
              ↑↓ · →/Enter · ←/Esc · type to search
            </Show>
          </text>
        </box>
      </box>
    </Show>
  )
}
