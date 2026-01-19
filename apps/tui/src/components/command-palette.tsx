import { createSignal, createEffect, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { ModelId } from "@gent/core"
import { useCommand } from "../command/index.js"
import { useTheme } from "../theme/index.js"
import { useModel } from "../model/index.js"
import { useClient, type SessionInfo } from "../client/index.js"
import { useRouter } from "../router/index.js"
import { useScrollSync } from "../hooks/use-scroll-sync.js"

interface MenuItem {
  id: string
  title: string
  onSelect: () => void
}

interface MenuLevel {
  title: string
  items: MenuItem[]
}

export function CommandPalette() {
  const command = useCommand()
  const { theme, selected, set, mode, setMode } = useTheme()
  const model = useModel()
  const client = useClient()
  const router = useRouter()
  const dimensions = useTerminalDimensions()

  const [levelStack, setLevelStack] = createSignal<MenuLevel[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [sessions, setSessions] = createSignal<SessionInfo[]>([])

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
          void client.listSessions().then((list) => {
            setSessions([...list])
            pushLevel(sessionsMenu())
          })
        },
      },
      {
        id: "theme",
        title: "Theme",
        onSelect: () => pushLevel(themeMenu()),
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
      ...sessionList.map((s) => {
        const isActive = currentSession?.sessionId === s.id
        return {
          id: `session.${s.id}`,
          title: isActive ? `${s.name ?? "Unnamed"} •` : (s.name ?? "Unnamed"),
          onSelect: () => {
            if (s.branchId) {
              void client.switchSession(s.id, s.branchId, s.name ?? "Unnamed")
              router.navigateToSession(s.id, s.branchId)
            }
            command.closePalette()
          },
        }
      }),
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

  // Provider submenu - lists providers with current gen models
  const providerMenu = (): MenuLevel => ({
    title: "Model",
    items: model.providers()
      .filter((provider) => model.currentGenByProvider(provider.id).length > 0)
      .map((provider) => ({
        id: `provider.${provider.id}`,
        title: provider.name,
        onSelect: () => pushLevel(modelMenu(provider.id)),
      })),
  })

  // Model submenu for a specific provider (current gen only)
  const modelMenu = (providerId: string): MenuLevel => {
    const currentModelId = model.currentModel()
    const providerModels = model.currentGenByProvider(providerId as Parameters<typeof model.currentGenByProvider>[0])
    const providerInfo = model.providers().find((p) => p.id === providerId)

    return {
      title: providerInfo?.name ?? providerId,
      items: providerModels.map((m) => {
        const isActive = m.id === currentModelId
        return {
          id: `model.${m.id}`,
          title: isActive ? `${m.name} •` : m.name,
          onSelect: () => {
            model.setModel(m.id as ModelId)
            command.closePalette()
          },
        }
      }),
    }
  }

  const currentLevel = () => {
    const stack = levelStack()
    return stack.length > 0 ? stack[stack.length - 1] ?? rootMenu() : rootMenu()
  }

  const pushLevel = (level: MenuLevel) => {
    setLevelStack((stack) => [...stack, level])
    setSelectedIndex(0)
  }

  const popLevel = () => {
    if (levelStack().length > 0) {
      setLevelStack((stack) => stack.slice(0, -1))
      setSelectedIndex(0)
    } else {
      command.closePalette()
    }
  }

  const handleSelect = () => {
    const items = currentLevel().items
    const item = items[selectedIndex()]
    if (item) {
      item.onSelect()
    }
  }

  // Reset when palette opens
  const resetPalette = () => {
    setLevelStack([])
    setSelectedIndex(0)
  }

  useKeyboard((e) => {
    if (!command.paletteOpen()) return

    if (e.name === "escape" || e.name === "left") {
      popLevel()
      return
    }

    if (e.name === "backspace" && levelStack().length > 0) {
      popLevel()
      return
    }

    if (e.name === "return" || e.name === "right") {
      handleSelect()
      return
    }

    const items = currentLevel().items
    if (e.name === "up" || (e.ctrl && e.name === "p")) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : items.length - 1))
      return
    }

    if (e.name === "down" || (e.ctrl && e.name === "n")) {
      setSelectedIndex((i) => (i < items.length - 1 ? i + 1 : 0))
      return
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
        {/* Header */}
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.text }}>
            <Show when={breadcrumb()}>
              <span style={{ fg: theme.textMuted }}>{breadcrumb()} </span>
            </Show>
            {currentLevel().title}
          </text>
        </box>

        {/* Separator */}
        <box flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>{"─".repeat(paletteWidth() - 2)}</text>
        </box>

        {/* Items */}
        <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} paddingRight={1}>
          <For each={currentLevel().items}>
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
