/**
 * Autocomplete popup for prefix triggers ($, @, /)
 */

import { createSignal, createEffect, createMemo, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { ChromePanel } from "./chrome-panel"
import { useWorkspace } from "../workspace/index"
import { useSkills } from "../hooks/use-skills"
import { useFileSearch } from "../hooks/use-file-search"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { truncatePath } from "./message-list-utils"
import { useScopedKeyboard } from "../keyboard/context"
import { getFileTag } from "./file-tag"
import { useExtensionUI } from "../extensions/context"

export type AutocompleteType = "$" | "@" | "/"

export interface AutocompleteState {
  type: AutocompleteType
  filter: string
  triggerPos: number
}

export interface AutocompleteItem {
  id: string
  label: string
  description?: string
}

interface SlashCommand {
  id: string
  label: string
  description: string
}

/** Session/chrome commands — always available, not feature-specific */
const SESSION_SLASH_COMMANDS: SlashCommand[] = [
  { id: "clear", label: "/clear", description: "Clear messages" },
  { id: "new", label: "/new", description: "Start new session" },
  { id: "sessions", label: "/sessions", description: "Open sessions picker" },
  { id: "branch", label: "/branch", description: "Create new branch" },
  { id: "tree", label: "/tree", description: "Browse branch tree" },
  { id: "fork", label: "/fork", description: "Fork from a message" },
  { id: "think", label: "/think", description: "Set reasoning level" },
  { id: "permissions", label: "/permissions", description: "View/edit permission rules" },
  { id: "auth", label: "/auth", description: "Manage API keys" },
]

export interface AutocompletePopupProps {
  state: AutocompleteState
  onSelect: (value: string) => void
  onClose: () => void
}

export function AutocompletePopup(props: AutocompletePopupProps) {
  const { theme } = useTheme()
  const workspace = useWorkspace()
  const { skills } = useSkills()
  const fileSearch = useFileSearch({ cwd: workspace.cwd })
  const extensionUI = useExtensionUI()

  const [rawSelectedIndex, setSelectedIndex] = createSignal(0)

  let scrollRef: ScrollBoxRenderable | undefined = undefined

  // Merge session commands + extension-contributed slash commands. Session wins on collision.
  const slashCommands = createMemo((): SlashCommand[] => {
    const sessionIds = new Set(SESSION_SLASH_COMMANDS.map((c) => c.id.toLowerCase()))
    const extCommands: SlashCommand[] = []
    for (const c of extensionUI.commands()) {
      if (c.slash !== undefined && !sessionIds.has(c.slash.toLowerCase())) {
        extCommands.push({
          id: c.slash,
          label: `/${c.slash}`,
          description: c.description ?? c.title,
        })
      }
    }
    return [...SESSION_SLASH_COMMANDS, ...extCommands]
  })

  // Memoize filtered items to avoid recomputation on each access
  const items = createMemo((): AutocompleteItem[] => {
    const filter = props.state.filter.toLowerCase()

    switch (props.state.type) {
      case "$": {
        return skills()
          .filter((s) => s.name.toLowerCase().includes(filter))
          .map((s) => ({
            id: s.name,
            label: s.name,
            description:
              s.description.length > 60 ? s.description.slice(0, 60) + "…" : s.description,
          }))
      }

      case "@": {
        return fileSearch.results().map((f) => {
          const tag = getFileTag(f.path)
          return {
            id: f.path,
            label: tag.length > 0 ? `${tag} ${f.name}` : f.name,
            description: truncatePath(f.path, 40),
          }
        })
      }

      case "/": {
        const all = slashCommands()
        return all
          .filter((c) => c.id.includes(filter) || c.label.includes(filter))
          .map((c) => ({
            id: c.id,
            label: c.label,
            description: c.description,
          }))
      }
    }
  })

  // Clamp index reactively instead of via createEffect
  const selectedIndex = createMemo(() => {
    const list = items()
    const idx = rawSelectedIndex()
    return idx >= list.length ? Math.max(0, list.length - 1) : idx
  })

  useScrollSync(() => `ac-item-${selectedIndex()}`, { getRef: () => scrollRef })

  // Update file search when filter changes
  createEffect(() => {
    if (props.state.type === "@") {
      fileSearch.search(props.state.filter)
    }
  })

  // Handle keyboard navigation
  useScopedKeyboard((e) => {
    const list = items()
    if (list.length === 0) return false

    if (e.name === "escape") {
      props.onClose()
      return true
    }

    if (e.name === "return" || e.name === "tab") {
      const item = list[selectedIndex()]
      if (item !== undefined) {
        props.onSelect(item.id)
      }
      return true
    }

    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : list.length - 1))
      return true
    }

    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      setSelectedIndex((i) => (i < list.length - 1 ? i + 1 : 0))
      return true
    }
    return false
  })

  const dimensions = useTerminalDimensions()

  // Content-driven height with floor/cap
  const popupHeight = () => {
    const contentH = items().length + 3 // items + header + filter hint + footer
    return Math.min(14, Math.max(5, contentH))
  }

  const popupWidth = () => Math.min(60, dimensions().width - 2)
  const popupLeft = () => Math.floor((dimensions().width - popupWidth()) / 2)

  const title = () => {
    switch (props.state.type) {
      case "$":
        return "Skills"
      case "@":
        return "Files"
      case "/":
        return "Commands"
    }
  }

  return (
    <Show when={items().length > 0}>
      <ChromePanel.Root
        title={title()}
        width={popupWidth()}
        height={popupHeight()}
        left={popupLeft()}
        bottom={3}
      >
        {/* Filter display */}
        <Show when={props.state.filter.length > 0}>
          <ChromePanel.Section>
            <text style={{ fg: theme.textMuted }}>
              › <span style={{ fg: theme.text }}>{props.state.filter}</span>
            </text>
          </ChromePanel.Section>
        </Show>

        {/* Items */}
        <ChromePanel.Body ref={scrollRef} paddingLeft={0} paddingRight={0}>
          <For each={items()}>
            {(item, index) => {
              const isSelected = () => selectedIndex() === index()
              return (
                <box
                  id={`ac-item-${index()}`}
                  backgroundColor={isSelected() ? theme.primary : "transparent"}
                  paddingLeft={1}
                >
                  <text
                    style={{
                      fg: isSelected() ? theme.selectedListItemText : theme.text,
                    }}
                  >
                    {item.label}
                    <Show when={item.description !== undefined}>
                      <span
                        style={{
                          fg: isSelected() ? theme.selectedListItemText : theme.textMuted,
                          dim: !isSelected(),
                        }}
                      >
                        {"  "}
                        {item.description}
                      </span>
                    </Show>
                  </text>
                </box>
              )
            }}
          </For>
        </ChromePanel.Body>

        <ChromePanel.Footer>↑↓ navigate · enter select · esc close</ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}
