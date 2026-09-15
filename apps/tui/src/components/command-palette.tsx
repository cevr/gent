/** @jsxImportSource @opentui/solid */

import { createEffect, createMemo, createResource, createSignal, Show } from "solid-js"
import { useTerminalDimensions } from "../terminal-dimensions"
import { matchSorter } from "match-sorter"
import { Option } from "effect"
import { useClient } from "../client/index"
import type { Session as DomainSession } from "@gent/sdk"
import { useCommand } from "../command/context"
import {
  CommandPaletteEvent,
  CommandPaletteState,
  transitionCommandPalette,
  type PaletteItem,
  type PaletteLevel,
} from "./command-palette-state"
import { ChromePanel } from "./chrome-panel"
import { PickerFrame, pickerHeight } from "./picker-frame"
import { SelectList, selectable, type SelectListApi, type SelectListRow } from "./select-list"
import { truncate, truncateStart } from "../utils/truncate"
import { textWidth } from "../platform/text-width-adapter"
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
  const { theme, selected, set, all, mode, setMode } = useTheme()
  const client = useClient()
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal(CommandPaletteState.initial())
  // The list owns the query and the cursor; the palette keeps a copy of the
  // query to filter with and a handle to reset the list when a level changes.
  const [searchQuery, setSearchQuery] = createSignal("")
  let list = Option.none<SelectListApi>()
  const resetList = () => Option.match(list, { onNone: () => {}, onSome: (api) => api.reset() })
  const listToTop = () => Option.match(list, { onNone: () => {}, onSome: (api) => api.moveTo(0) })

  const dispatch = (event: Parameters<typeof transitionCommandPalette>[1]) => {
    setState((current) => transitionCommandPalette(current, event))
  }

  const closePalette = () => {
    dispatch(CommandPaletteEvent.cases.Close.make({}))
    command.closePalette()
  }

  // ── Level factories ──

  // Theme and mode are orthogonal: `set(name)` picks the catalog entry and
  // `setMode` picks the variant it resolves in. "System" is a catalog entry
  // like any other — the one generated from the terminal's palette — so
  // following the terminal stays a theme choice, not a third mode.
  const themeLevel = (): PaletteLevel => ({
    id: "theme",
    title: "Theme",
    source: (): readonly PaletteItem[] => {
      const active = selected()
      const named = Object.keys(all())
        .filter((name) => name !== "system")
        .map((name) => ({
          id: `theme.${name}`,
          title: selectedTitle(name, active === name),
          onSelect: () => {
            set(name)
            closePalette()
          },
        }))
      return [
        {
          id: "theme.system",
          title: selectedTitle("System", active === "system"),
          description: "Follow terminal theme",
          onSelect: () => {
            set("system")
            closePalette()
          },
        },
        ...named,
      ]
    },
  })

  // Dark/Light is the variant every theme resolves in, so it is its own level
  // rather than three entries mixed into the theme list.
  const modeLevel = (): PaletteLevel => ({
    id: "mode",
    title: "Mode",
    source: (): readonly PaletteItem[] => {
      const current = mode()
      const item = (value: "dark" | "light", title: string): PaletteItem => ({
        id: `mode.${value}`,
        title: selectedTitle(title, current === value),
        onSelect: () => {
          setMode(value)
          closePalette()
        },
      })
      return [item("dark", "Dark"), item("light", "Light")]
    },
  })

  const sessionsLevel = (): PaletteLevel => {
    const [sessions] = createResource(() => client.runtime.run(client.listSessions))

    const newSessionItem: PaletteItem = {
      id: "session.new",
      title: "+ New Session",
      onSelect: () => {
        client.createSession()
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

  const branchesLevel = (): PaletteLevel => {
    const [branches] = createResource(() => client.runtime.run(client.listBranches))
    return {
      id: "branches",
      title: "Branches",
      source: () =>
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(branches()), (items) =>
            items.map((branch) => ({
              id: `branch.${branch.id}`,
              title: selectedTitle(
                branch.name ?? `Branch ${branch.id.slice(0, 8)}…${branch.id.slice(-4)}`,
                client.session()?.branchId === branch.id,
              ),
              onSelect: () => {
                if (client.session()?.branchId !== branch.id) client.switchBranch(branch.id)
                closePalette()
              },
            })),
          ),
        ),
    }
  }

  const pushLevel = (level: PaletteLevel) => {
    dispatch(CommandPaletteEvent.cases.PushLevel.make({ level }))
    resetList()
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
        category: "Session",
        onSelect: () => pushLevel(sessionsLevel()),
      },
      {
        id: "theme",
        title: "Theme",
        description: "Switch color theme",
        category: "Appearance",
        onSelect: () => pushLevel(themeLevel()),
      },
      {
        id: "mode",
        title: "Mode",
        description: "Dark or light variant",
        category: "Appearance",
        onSelect: () => pushLevel(modeLevel()),
      },
      {
        id: "new-session",
        title: "New Session",
        description: "Start a fresh session",
        category: "Session",
        shortcut: "Ctrl+N",
        onSelect: () => {
          client.createSession()
          closePalette()
        },
      },
      {
        id: "branches",
        title: "Branches",
        description: "Switch branches in this session",
        category: "Session",
        onSelect: () => pushLevel(branchesLevel()),
      },
      ...command
        .commands()
        .filter((cmd) => cmd.id !== "session.new" && cmd.id !== "session.sessions")
        .map((cmd) => ({
          id: `ext:${cmd.id}`,
          title: cmd.title,
          description: cmd.description,
          category: cmd.category ?? "General",
          shortcut: cmd.keybind,
          onSelect: () => {
            cmd.onSelect()
            closePalette()
          },
        })),
    ],
  })

  // ── Derived state ──

  const currentLevel = () => CommandPaletteState.currentLevel(state())

  /** `None` while the level's request is pending. */
  const levelSource = createMemo(() =>
    Option.flatMap(currentLevel(), (level) => Option.fromNullishOr(level.source())),
  )
  const loading = () => Option.isNone(levelSource())
  const levelItems = createMemo<readonly PaletteItem[]>(() =>
    Option.getOrElse(levelSource(), (): readonly PaletteItem[] => []),
  )

  const categories = createMemo(() => [
    "",
    ...new Set(levelItems().map((item) => item.category ?? "General")),
  ])
  const category = () => {
    if (categories().includes(state().category)) return state().category
    return ""
  }
  const filteredItems = createMemo(() => {
    const items = filterItems(levelItems(), searchQuery())
    if (category() === "") return items
    return items.filter((item) => (item.category ?? "General") === category())
  })
  const categoryHeader = () => {
    const selected = category()
    const label = selected || "All"
    const others = categories()
      .filter((value) => value !== selected)
      .map((value) => value || "All")
    return `[${label}]  ${others.join("  ")}`
  }

  const popLevel = () => {
    if (state().levelStack.length <= 1) {
      closePalette()
      return
    }
    dispatch(CommandPaletteEvent.cases.PopLevel.make({}))
    resetList()
  }

  const handleSelect = (item: PaletteItem) => {
    if (item.disabled === true) return
    item.onSelect()
  }

  const cycleCategory = (backward: boolean) => {
    const items = categories()
    let step = 1
    if (backward) step = -1
    const index = (items.indexOf(category()) + step + items.length) % items.length
    dispatch(
      CommandPaletteEvent.cases.SelectCategory.make({
        category: Option.getOrElse(Option.fromNullishOr(items[index]), () => ""),
      }),
    )
    listToTop()
  }

  // Escape clears a query before it leaves a level, and backspace on an empty
  // query walks back a level. Both are the list's keys otherwise, so the pane
  // claims them only in those cases.
  const escapeLevel = () => {
    if (searchQuery().length > 0) {
      resetList()
      return
    }
    popLevel()
  }

  createEffect(() => {
    if (command.paletteOpen()) {
      dispatch(CommandPaletteEvent.cases.Open.make({ rootLevel: rootLevel() }))
    }
  })

  const paletteHeight = () => pickerHeight(filteredItems().length, dimensions().height)

  const hasDetails = () =>
    filteredItems().some((item) => Boolean(item.description?.trim() || item.shortcut))
  const labelWidth = () => {
    if (!hasDetails()) return dimensions().width
    return Math.max(8, Math.min(24, Math.floor(dimensions().width * 0.28)))
  }

  const footerHint = () => {
    let close = "Close"
    if (state().levelStack.length > 1) close = "Back"
    if (dimensions().width < 56) return `↑↓ Move · Tab Group · ↵ Open · Esc ${close}`
    return `↑↓ Navigate     Tab Category     Enter Open     Esc ${close}`
  }

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

  const queryPrefix = () => {
    if (searchQuery().length === 0) return truncate(breadcrumb(), dimensions().width - 2)
    const available = Math.max(1, Math.floor((dimensions().width - 3) / 2))
    return `${truncate(breadcrumb() || "›", available)} `
  }
  const visibleQuery = () =>
    truncateStart(searchQuery(), dimensions().width - 3 - textWidth(queryPrefix()))

  const rows = (): ReadonlyArray<SelectListRow<PaletteItem>> =>
    filteredItems().map((item) =>
      selectable(item, (isSelected, id) => {
        const disabled = item.disabled === true
        const itemTextColor = () => {
          if (disabled) return theme.textMuted
          if (isSelected()) return theme.primary
          return theme.text
        }
        const metaColor = () => {
          if (disabled) return theme.textMuted
          if (isSelected()) return theme.primary
          return theme.textMuted
        }
        const detail = () => {
          let text = Option.getOrElse(Option.fromNullishOr(item.description), () => "")
          if (item.shortcut) text += ` [${item.shortcut}]`
          return truncate(text, dimensions().width - labelWidth() - 3)
        }
        return (
          <box id={id} paddingLeft={1} flexDirection="row" height={1} gap={2}>
            <text
              width={labelWidth() - 2}
              flexShrink={0}
              wrapMode="none"
              truncate
              style={{ fg: itemTextColor() }}
            >
              <span style={{ bold: isSelected() && !disabled }}>
                {truncate(item.title, labelWidth() - 2)}
              </span>
            </text>
            <Show when={hasDetails()}>
              <text flexGrow={1} wrapMode="none" truncate style={{ fg: metaColor() }}>
                {detail()}
              </text>
            </Show>
          </box>
        )
      }),
    )

  const emptyRow = () => {
    let label = "No matches"
    if (loading()) label = "Loading…"
    return (
      <box paddingLeft={1}>
        <text style={{ fg: theme.textMuted }}>{label}</text>
      </box>
    )
  }

  return (
    <Show when={command.paletteOpen()}>
      <PickerFrame height={paletteHeight()} footer={footerHint()}>
        <box height={1} flexShrink={0} overflow="hidden">
          <text style={{ fg: theme.textMuted }}>
            {levelTitle()} {filteredItems().length} {categoryHeader()}
          </text>
        </box>
        <ChromePanel.Section>
          <text height={1} wrapMode="none" truncate style={{ fg: theme.text }}>
            <span style={{ fg: theme.textMuted }}>{queryPrefix()}</span>
            <Show when={searchQuery().length > 0}>
              {visibleQuery()}
              <span style={{ fg: theme.primary }}>│</span>
            </Show>
          </text>
        </ChromePanel.Section>

        <SelectList
          id="command-palette"
          open={command.paletteOpen()}
          rows={rows}
          filter={{ onQueryChange: setSearchQuery, showInput: false }}
          empty={emptyRow}
          api={(api) => (list = Option.some(api))}
          extraKeys={(event, selected) => {
            if (event.name === "tab") {
              cycleCategory(event.shift === true)
              return true
            }
            if (event.name === "escape") {
              escapeLevel()
              return true
            }
            if (event.name === "left") {
              popLevel()
              return true
            }
            if (event.name === "backspace" && searchQuery().length === 0) {
              if (state().levelStack.length <= 1) return false
              popLevel()
              return true
            }
            if (event.name === "right") {
              Option.match(selected, { onNone: () => {}, onSome: handleSelect })
              return true
            }
            return false
          }}
          onSelect={handleSelect}
          onDismiss={escapeLevel}
        />
      </PickerFrame>
    </Show>
  )
}
