import { createSignal, createEffect, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import type { ModelId } from "@gent/core"
import { Agents } from "@gent/core"
import { useCommand } from "../command/index"
import { useTheme } from "../theme/index"
import { useClient } from "../client/index"
import { useRouter } from "../router/index"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { useRuntime } from "../hooks/use-runtime"
import type { SessionInfo } from "../client"
import * as State from "../state"
import { formatError } from "../utils/format-error"

interface MenuItem {
  id: string
  title: string
  onSelect: () => void
}

interface MenuLevel {
  title: string
  items: MenuItem[] | (() => MenuItem[])
  searchable?: boolean
}

export function CommandPalette() {
  const command = useCommand()
  const { theme, selected, set, mode, setMode } = useTheme()
  const client = useClient()
  const { cast } = useRuntime(client.client.runtime)
  const router = useRouter()
  const dimensions = useTerminalDimensions()

  const [levelStack, setLevelStack] = createSignal<MenuLevel[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [sessions, setSessions] = createSignal<SessionInfo[]>([])
  const [searchQuery, setSearchQuery] = createSignal("")
  const [showAllModels, setShowAllModels] = createSignal(false)

  let scrollRef: ScrollBoxRenderable | undefined = undefined

  useScrollSync(() => `item-${selectedIndex()}`, { getRef: () => scrollRef })

  // Build root menu
  const rootMenu = (): MenuLevel => ({
    title: "Commands",
    items: [
      {
        id: "sessions",
        title: "Sessions",
        onSelect: () => {
          cast(
            client.listSessions().pipe(
              Effect.tap((list) =>
                Effect.sync(() => {
                  setSessions([...list])
                  pushLevel(sessionsMenu())
                }),
              ),
              Effect.catchAll((error) =>
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
        onSelect: () => pushLevel(themeMenu()),
      },
      {
        id: "agent",
        title: "Agent",
        onSelect: () => pushLevel(agentMenu()),
      },
      {
        id: "model",
        title: "Model",
        onSelect: () => pushLevel(providerMenu()),
      },
    ],
  })

  // Sessions submenu
  const sessionsMenu = (): MenuLevel => {
    const currentSession = client.session()
    const sessionList = sessions()

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

    const items: MenuItem[] = [
      {
        id: "session.new",
        title: "+ New Session",
        onSelect: () => {
          client.clearSession()
          router.navigateToHome()
          command.closePalette()
        },
      },
      ...flattenSessionTree(buildSessionTree(sessionList)),
    ]

    return {
      title: "Sessions",
      items,
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
        onSelect: () => {
          client.steer({ _tag: "SwitchAgent", agent: agent.name })
          command.closePalette()
        },
      })),
    }
  }

  // Provider submenu - lists providers with models, or direct model list when searching
  const providerMenu = (): MenuLevel => ({
    title: "Model",
    items: () => {
      const query = searchQuery().toLowerCase().trim()

      // If searching, show flat model list filtered by query
      if (query.length > 0) {
        const allModels = showAllModels() ? State.models() : State.currentGenModels()
        const filtered = allModels.filter(
          (m) =>
            m.name.toLowerCase().includes(query) ||
            m.id.toLowerCase().includes(query) ||
            m.provider.toLowerCase().includes(query),
        )
        const currentModelId = State.currentModel()

        const items: MenuItem[] = filtered.map((m) => {
          const isActive = m.id === currentModelId
          const providerInfo = State.providers().find((p) => p.id === m.provider)
          return {
            id: `model.${m.id}`,
            title: isActive
              ? `${providerInfo?.name ?? m.provider}/${m.name} •`
              : `${providerInfo?.name ?? m.provider}/${m.name}`,
            onSelect: () => {
              State.setModel(m.id as ModelId)
              command.closePalette()
            },
          }
        })

        // Add "Show all models" toggle if not already showing all
        if (!showAllModels() && items.length < 10) {
          items.push({
            id: "model.show-all",
            title: "Show all models...",
            onSelect: () => {
              setShowAllModels(true)
              setSelectedIndex(0)
            },
          })
        }

        return items
      }

      // No search - show provider list
      return State.providers()
        .filter((provider) => State.currentGenByProvider(provider.id).length > 0)
        .map((provider) => ({
          id: `provider.${provider.id}`,
          title: provider.name,
          onSelect: () => pushLevel(modelMenu(provider.id)),
        }))
    },
    searchable: true,
  })

  // Model submenu for a specific provider (current gen only, unless showAll)
  const modelMenu = (providerId: string): MenuLevel => {
    const currentModelId = State.currentModel()
    const providerInfo = State.providers().find((p) => p.id === providerId)
    return {
      title: providerInfo?.name ?? providerId,
      items: () => {
        const providerModels = showAllModels()
          ? State.modelsByProvider(providerId)
          : State.currentGenByProvider(providerId)

        const items: MenuItem[] = providerModels.map((m) => {
          const isActive = m.id === currentModelId
          return {
            id: `model.${m.id}`,
            title: isActive ? `${m.name} •` : m.name,
            onSelect: () => {
              State.setModel(m.id as ModelId)
              command.closePalette()
            },
          }
        })

        // Add "Show all models" toggle if not already showing all
        if (!showAllModels()) {
          items.push({
            id: "model.show-all",
            title: "Show all models...",
            onSelect: () => {
              setShowAllModels(true)
              setSelectedIndex(0)
            },
          })
        }

        return items
      },
      searchable: true,
    }
  }

  const currentLevel = () => {
    const stack = levelStack()
    return stack.length > 0 ? (stack[stack.length - 1] ?? rootMenu()) : rootMenu()
  }

  const levelItems = (level: MenuLevel) =>
    typeof level.items === "function" ? level.items() : level.items

  const currentItems = () => levelItems(currentLevel())

  const pushLevel = (level: MenuLevel) => {
    setLevelStack((stack) => [...stack, level])
    setSelectedIndex(0)
    setSearchQuery("")
  }

  const popLevel = () => {
    setSearchQuery("")
    setShowAllModels(false)
    if (levelStack().length > 0) {
      setLevelStack((stack) => stack.slice(0, -1))
      setSelectedIndex(0)
    } else {
      command.closePalette()
    }
  }

  const handleSelect = () => {
    const items = currentItems()
    const item = items[selectedIndex()]
    if (item !== undefined) {
      item.onSelect()
    }
  }

  // Reset when palette opens
  const resetPalette = () => {
    setLevelStack([])
    setSelectedIndex(0)
    setSearchQuery("")
    setShowAllModels(false)
  }

  useKeyboard((e) => {
    if (!command.paletteOpen()) return

    const level = currentLevel()

    if (e.name === "escape") {
      // Clear search first, then pop level
      if (searchQuery().length > 0) {
        setSearchQuery("")
        setSelectedIndex(0)
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
      // Handle search query backspace
      if (level.searchable === true && searchQuery().length > 0) {
        setSearchQuery((q) => q.slice(0, -1))
        setSelectedIndex(0)
        return
      }
      if (levelStack().length > 0) {
        popLevel()
        return
      }
      return
    }

    if (e.name === "return" || e.name === "right") {
      handleSelect()
      return
    }

    const items = levelItems(level)
    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : items.length - 1))
      return
    }

    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      setSelectedIndex((i) => (i < items.length - 1 ? i + 1 : 0))
      return
    }

    // Handle search input for searchable levels
    if (level.searchable === true && e.sequence !== undefined && e.sequence.length === 1) {
      const char = e.sequence
      // Only accept printable characters
      if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
        setSearchQuery((q) => q + char)
        setSelectedIndex(0)
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
  const paletteWidth = () => Math.min(40, dimensions().width - 4)
  const paletteHeight = () => Math.min(12, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - paletteWidth()) / 2)
  const top = () => Math.floor((dimensions().height - paletteHeight()) / 2)

  const breadcrumb = () => {
    const stack = levelStack()
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
              when={currentLevel().searchable === true && searchQuery().length > 0}
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
          <For each={currentItems()}>
            {(item, index) => {
              const isSelected = () => selectedIndex() === index()
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
                    {item.title}
                  </text>
                </box>
              )
            }}
          </For>
        </scrollbox>

        {/* Footer hint */}
        <box flexShrink={0} paddingLeft={1}>
          <text style={{ fg: theme.textMuted }}>
            <Show when={levelStack().length > 0} fallback="↑↓ · →/Enter · Esc">
              ↑↓ · →/Enter · ←/Esc
            </Show>
          </text>
        </box>
      </box>
    </Show>
  )
}
