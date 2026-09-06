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
import { useTerminalDimensions } from "../terminal-dimensions"
import { matchSorter } from "match-sorter"
import { Option } from "effect"
import { useClient } from "../client/index"
import type { DomainSession } from "../client"
import { useCommand } from "../command/context"
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
import { useRouter } from "../router"
import { useTheme } from "../theme/index"

const filterItems = (items: readonly PaletteItem[], query: string): readonly PaletteItem[] => {
  if (query.length === 0) return items
  return matchSorter(items, query, {
    keys: ["title", "description", "category"],
  })
}

const selectedTitle = (title: string, selected: boolean): string => {
  if (selected) return `${title} •`
  return title
}

type SessionNode = {
  readonly session: DomainSession
  readonly children: SessionNode[]
}

const buildSessionTree = (list: readonly DomainSession[]): SessionNode[] => {
  const nodes = new Map<string, SessionNode>()
  for (const session of list) {
    nodes.set(session.id, { session, children: [] })
  }

  const roots: SessionNode[] = []
  for (const session of list) {
    const node = Option.fromNullishOr(nodes.get(session.id))
    if (Option.isNone(node)) continue
    const parent = Option.fromNullishOr(session.parentSessionId).pipe(
      Option.flatMap((id) => Option.fromNullishOr(nodes.get(id))),
    )
    if (Option.isSome(parent)) {
      parent.value.children.push(node.value)
    } else {
      roots.push(node.value)
    }
  }

  const sortNodes = (tree: SessionNode[]) => {
    tree.sort((a, b) => b.session.updatedAt.getTime() - a.session.updatedAt.getTime())
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
  const router = useRouter()
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal(CommandPaletteState.initial())

  let scrollRef = Option.none<ScrollBoxRenderable>()

  useScrollSync(() => `item-${state().selectedIndex}`, {
    getRef: () => Option.getOrUndefined(scrollRef),
  })

  const dispatch = (event: Parameters<typeof transitionCommandPalette>[1]) => {
    setState((current) => transitionCommandPalette(current, event))
  }

  const closePalette = () => {
    dispatch(CommandPaletteEvent.cases.Close.make({}))
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
          title: selectedTitle("System", isSystem),
          description: "Follow terminal theme",
          onSelect: () => {
            set("system")
            closePalette()
          },
        },
        {
          id: "theme.dark",
          title: selectedTitle("Dark", !isSystem && currentMode === "dark"),
          onSelect: () => {
            set("opencode")
            setMode("dark")
            closePalette()
          },
        },
        {
          id: "theme.light",
          title: selectedTitle("Light", !isSystem && currentMode === "light"),
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
    const [sessions] = createResource(() => client.runtime.run(client.listSessions))

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
      let prefix = ""
      if (depth > 0) prefix = `${"  ".repeat(depth)}- `
      for (const node of nodes) {
        const session = node.session
        const currentSession = client.session()
        const isActive = currentSession?.sessionId === session.id
        const title = selectedTitle(`${prefix}${session.name ?? "Unnamed"}`, isActive)

        items.push({
          id: `session.${session.id}`,
          title,
          onSelect: () => {
            const branchId = Option.fromNullishOr(session.activeBranchId)
            if (Option.isNone(branchId)) return
            client.switchSession(session.id, branchId.value, session.name ?? "Unnamed")
            router.navigateToSession(session.id, branchId.value)
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
      source: () =>
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(sessions()), (data) => [
            newSessionItem,
            ...flattenSessionTree(buildSessionTree(data)),
          ]),
        ),
    }
  }

  const pushLevel = (level: PaletteLevel) => {
    dispatch(CommandPaletteEvent.cases.PushLevel.make({ level }))
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
          const nextLevel = Option.fromNullishOr(cmd.paletteLevel)
          if (Option.isSome(nextLevel)) {
            pushLevel(nextLevel.value())
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
    if (Option.isNone(level)) return []
    return level.value.source() ?? []
  })

  const filteredItems = createMemo(() => filterItems(levelItems(), searchQuery()))

  const maxCategoryWidth = createMemo(() => {
    let max = 0
    for (const item of filteredItems()) {
      max = Math.max(max, item.category?.length ?? 0)
    }
    return max
  })

  const popLevel = () => {
    if (state().levelStack.length <= 1) {
      closePalette()
      return
    }
    dispatch(CommandPaletteEvent.cases.PopLevel.make({}))
  }

  const handleSelect = () => {
    const item = Option.fromNullishOr(filteredItems()[state().selectedIndex])
    if (Option.isNone(item) || item.value.disabled) return
    item.value.onSelect()
  }

  useScopedKeyboard(
    (event) => {
      if (event.name === "escape") {
        if (searchQuery().length > 0) {
          dispatch(CommandPaletteEvent.cases.ClearSearch.make({}))
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
          dispatch(CommandPaletteEvent.cases.SearchBackspaced.make({}))
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
        dispatch(CommandPaletteEvent.cases.MoveUp.make({ itemCount: filteredItems().length }))
        return true
      }

      if (event.name === "down" || (event.ctrl === true && event.name === "n")) {
        dispatch(CommandPaletteEvent.cases.MoveDown.make({ itemCount: filteredItems().length }))
        return true
      }

      if (event.sequence?.length === 1) {
        const code = event.sequence.charCodeAt(0)
        if (code >= 32 && code <= 126) {
          dispatch(CommandPaletteEvent.cases.SearchTyped.make({ char: event.sequence }))
          return true
        }
      }

      return false
    },
    { when: () => command.paletteOpen() },
  )

  createEffect(() => {
    if (command.paletteOpen()) {
      dispatch(CommandPaletteEvent.cases.Open.make({ rootLevel: rootLevel() }))
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

  const levelTitle = () =>
    Option.match(currentLevel(), {
      onNone: () => "Commands",
      onSome: (level) => level.title,
    })

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
            if (isSelected()) return theme.selectedListItemText
            return theme.text
          }
          const metaColor = () => {
            if (disabled) return theme.textMuted
            if (isSelected()) return theme.selectedListItemText
            return theme.textMuted
          }
          const background = () => {
            if (isSelected() && !disabled) return theme.primary
            return "transparent"
          }

          return (
            <box id={`item-${index()}`} backgroundColor={background()} paddingLeft={1}>
              <text style={{ fg: itemTextColor() }}>
                <Show when={catWidth > 0}>
                  <span style={{ fg: metaColor() }}>
                    {(item.category ?? "").padEnd(catWidth)}
                  </span>{" "}
                </Show>
                {item.title}
                <Show when={Option.isSome(Option.fromNullishOr(item.description))}>
                  <span style={{ fg: metaColor() }}> {item.description}</span>
                </Show>
                <Show when={Option.isSome(Option.fromNullishOr(item.shortcut))}>
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
            scrollRef = Option.some(element)
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
